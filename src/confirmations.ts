import type { CommentSubmit } from '@devvit/protos'
import type { TriggerContext } from '@devvit/public-api'
import {
  evaluateConfirmation,
  findFlairTemplate,
  formatFlairFromTemplate,
  type FlairTemplate,
  type ValidationResult,
} from './rules.js'
import { defaults } from './defaults/index.js'
import { render } from './templates.js'
import { trySetUserFlairWithFallback } from './flairAssignment.js'
import { loadFlairTemplates, refreshFlairTemplateCache } from './flairCache.js'
import { isUserModerator } from './moderators.js'
import {
  redditApiCall,
  trySubmitCommentWithRetry,
} from './redditApi.js'
import { errorText, expirationFromNow } from './utils.js'

const PROCESSED_COMMENT_TTL_MS = 45 * 24 * 60 * 60 * 1000
const PROCESSING_COMMENT_TTL_MS = 5 * 60 * 1000

type RejectionReason = NonNullable<ValidationResult['reason']>

interface ProcessableComment {
  id: string
  body: string
  author: string
  authorFlair: string | null
  parentId: string
  postId: string
  permalink: string
}

interface FetchedComment {
  id: string
  parentId: string
  postId: string
  subredditName: string
  authorName: string
  authorFlair: string | null
  removed: boolean
  isRoot: boolean
  body: string
  permalink: string
}

interface ConfirmationParticipant {
  username: string
  usernameLower: string
  countKey: string
  oldFlair: string | null
  isModerator: boolean
}

interface CommittedConfirmationParticipant extends ConfirmationParticipant {
  newCount: number
  newFlair: string | null
}

type ConfirmationCommit =
  | {
    committed: true
    parent: CommittedConfirmationParticipant
    confirmer: CommittedConfirmationParticipant
  }
  | { committed: false }

interface ConfirmationClaimRecord {
  commentId: string
  replyToCommentId: string
  confirmer: string
  parentAuthor: string
  modApproval: boolean
  parentCount: number
  confirmerCount: number
  createdAt: string
}

export interface ManualApprovalResult {
  approved: boolean
  message: string
  parentAuthor?: string
  confirmer?: string
  parentCommentId?: string
}

export async function onCommentSubmit(event: CommentSubmit, ctx: TriggerContext): Promise<void> {
  const c = event.comment
  if (!c) return
  await processComment(ctx, {
    id: c.id,
    body: c.body,
    author: event.author?.name ?? '',
    authorFlair: event.author?.flair?.text || null,
    parentId: c.parentId,
    postId: c.postId,
    permalink: c.permalink,
  }, event.subreddit?.name ?? '')
}

async function processComment(
  ctx: TriggerContext,
  comment: ProcessableComment,
  subredditName: string,
): Promise<boolean> {
  if (comment.parentId.startsWith('t3_')) {
    console.debug(`Skipping ${comment.id}: root-level comment`)
    return false
  }

  const processedKey = `processed:${comment.id}`
  if (await ctx.redis.get(processedKey)) {
    console.debug(`Skipping ${comment.id}: already marked processed`)
    return false
  }

  const processingKey = `processing:${comment.id}`
  const processingClaimed = await ctx.redis.set(processingKey, '1', {
    nx: true,
    expiration: expirationFromNow(PROCESSING_COMMENT_TTL_MS),
  })
  if (!processingClaimed) {
    console.debug(`Skipping ${comment.id}: another invocation owns processing claim`)
    return false
  }

  try {
    console.debug(`Processing comment ${comment.id} by u/${comment.author}`)
    const processed = await processCommentOnce(ctx, comment, subredditName)
    if (processed) {
      await ctx.redis.set(processedKey, '1', { expiration: expirationFromNow(PROCESSED_COMMENT_TTL_MS) })
    }
    return processed
  } finally {
    await ctx.redis.del(processingKey).catch(error => {
      console.warn(`Failed to release ${processingKey}: ${errorText(error)}`)
    })
  }
}

async function processCommentOnce(
  ctx: TriggerContext,
  comment: ProcessableComment,
  subredditName: string,
): Promise<boolean> {
  const submission = await redditApiCall(ctx, () => ctx.reddit.getPostById(comment.postId as `t3_${string}`), `get post ${comment.postId}`)
  const botUser = await redditApiCall(ctx, () => ctx.reddit.getAppUser(), 'get app user')
  if (!botUser) return true
  if (submission.authorId !== botUser.id) return true
  if (submission.locked) return true

  const isCurrent = submission.id === (await ctx.redis.get('currentMonthlyPost'))
  const isModerator = await isUserModerator(ctx, subredditName, comment.author)

  const parent = await fetchComment(ctx, comment.parentId)
  const grandparent = shouldFetchGrandparent(comment, parent) ? await fetchComment(ctx, parent.parentId) : null

  const result = evaluateConfirmation(
    {
      id: comment.id,
      body: comment.body,
      authorName: comment.author,
      isRoot: comment.parentId.startsWith('t3_'),
    },
    {
      parentExists: !!parent,
      parentIsBanned: parent?.removed ?? false,
      parentIsProcessable: parent ? !!parent.authorName : false,
      parentAuthorName: parent?.authorName ?? '',
      parentId: parent?.id ?? '',
      parentIsRoot: parent?.isRoot ?? false,
      parentIsSaved: false,
      parentBody: parent?.body ?? '',
      isModerator,
      grandparentExists: !!grandparent,
      grandparentIsRoot: grandparent?.isRoot ?? false,
      grandparentAuthorName: grandparent?.authorName ?? '',
      grandparentId: grandparent?.id ?? '',
      isCurrentSubmission: isCurrent,
    },
  )

  if (!result.valid) {
    if (!result.reason) return true
    console.debug(`Rejecting ${comment.id}: ${result.reason}`)
    await replyWithReason(ctx, comment, result.reason, result)
    return true
  }

  const completion = await completeConfirmation(
    ctx,
    subredditName,
    comment,
    result,
    oldFlairHints(comment, result, parent, grandparent),
  )
  if (!completion.approved) {
    console.debug(`Rejecting ${comment.id}: parent comment ${result.parentCommentId} already claimed`)
    await replyWithReason(ctx, comment, 'already_confirmed', result)
    return true
  }
  return true
}

export async function approveConfirmationFromComment(
  ctx: TriggerContext,
  commentId: string,
): Promise<ManualApprovalResult> {
  if (!commentId.startsWith('t1_')) {
    return { approved: false, message: 'Select a confirmation comment to approve' }
  }

  const target = await fetchComment(ctx, commentId)
  if (!target) {
    return { approved: false, message: 'Select a confirmation comment to approve' }
  }
  const subredditName = target.subredditName
  if (target.isRoot) {
    return { approved: false, message: 'Select a reply to a trade comment, not a top-level comment' }
  }
  if (!target.authorName) {
    return { approved: false, message: 'Selected comment has no processable author' }
  }
  if (!target.body.toLowerCase().includes('confirmed')) {
    return { approved: false, message: 'Selected comment does not look like a confirmation' }
  }

  const parent = await fetchComment(ctx, target.parentId)
  if (!parent) {
    return { approved: false, message: 'Select a direct reply to a trade comment' }
  }
  if (!parent.isRoot) {
    return { approved: false, message: 'Select a direct reply to a trade comment' }
  }
  if (!parent.authorName || parent.removed) {
    return { approved: false, message: 'Parent trade comment cannot be confirmed' }
  }
  if (parent.authorName.toLowerCase() === target.authorName.toLowerCase()) {
    return { approved: false, message: 'A user cannot confirm their own trade' }
  }

  const submission = await redditApiCall(ctx, () => ctx.reddit.getPostById(target.postId as `t3_${string}`), `get post ${target.postId}`)
  const botUser = await redditApiCall(ctx, () => ctx.reddit.getAppUser(), 'get app user')
  if (!botUser || submission.authorId !== botUser.id) {
    return { approved: false, message: 'Selected comment is not on a bot confirmation thread' }
  }
  if (submission.locked) {
    return { approved: false, message: 'Selected confirmation thread is locked' }
  }
  if (submission.id !== (await ctx.redis.get('currentMonthlyPost'))) {
    return { approved: false, message: 'Selected comment is not on the current monthly confirmation thread' }
  }

  const result: ValidationResult = {
    valid: true,
    isModApproval: true,
    parentAuthor: parent.authorName,
    confirmer: target.authorName,
    parentCommentId: parent.id,
    replyToCommentId: target.id,
  }
  const completion = await completeConfirmation(ctx, subredditName, {
    id: target.id,
    body: target.body,
    author: target.authorName,
    authorFlair: target.authorFlair,
    parentId: target.parentId,
    postId: target.postId,
    permalink: target.permalink,
  }, result, manualApprovalFlairHints(parent, target))

  if (!completion.approved) {
    return {
      approved: false,
      message: 'That trade comment has already been confirmed',
      parentAuthor: result.parentAuthor,
      confirmer: result.confirmer,
      parentCommentId: result.parentCommentId,
    }
  }

  return {
    approved: true,
    message: `Approved confirmation for u/${result.parentAuthor} and u/${result.confirmer}`,
    parentAuthor: result.parentAuthor,
    confirmer: result.confirmer,
    parentCommentId: result.parentCommentId,
  }
}

export async function rescanCurrentMonthlyPost(ctx: TriggerContext): Promise<{ scanned: number; processed: number }> {
  const postId = await ctx.redis.get('currentMonthlyPost')
  if (!postId) return { scanned: 0, processed: 0 }
  const { name: subredditName } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
  const comments = await redditApiCall(ctx, () =>
    ctx.reddit.getComments({ postId: postId as `t3_${string}`, limit: 1000, pageSize: 100 }).all(),
  `get comments for ${postId}`)
  let processed = 0
  for (const c of comments) {
    const ran = await processComment(ctx, {
      id: c.id,
      body: c.body,
      author: c.authorName,
      authorFlair: c.authorFlair?.text ?? null,
      parentId: c.parentId,
      postId: c.postId,
      permalink: c.permalink,
    }, subredditName)
    if (ran) processed++
  }
  return { scanned: comments.length, processed }
}

async function fetchComment(ctx: TriggerContext, fullName: string): Promise<FetchedComment | null> {
  if (!fullName.startsWith('t1_')) return null
  const c = await redditApiCall(ctx, () => ctx.reddit.getCommentById(fullName as `t1_${string}`), `get comment ${fullName}`)
  return {
    id: c.id,
    parentId: c.parentId,
    postId: c.postId,
    subredditName: c.subredditName,
    authorName: c.authorName,
    authorFlair: c.authorFlair?.text ?? null,
    removed: c.removed ?? false,
    isRoot: c.parentId.startsWith('t3_'),
    body: c.body ?? '',
    permalink: c.permalink,
  }
}

function shouldFetchGrandparent(
  comment: ProcessableComment,
  parent: FetchedComment | null,
): parent is NonNullable<typeof parent> {
  return !!parent && !parent.isRoot && comment.body.toLowerCase().includes('approved')
}

async function getTemplate(ctx: TriggerContext, name: string): Promise<string> {
  return (await ctx.settings.get<string>(name))?.trim() || defaults[name]
}

async function replyWithReason(
  ctx: TriggerContext,
  comment: ProcessableComment,
  reason: RejectionReason,
  result: ValidationResult,
): Promise<void> {
  const replyBody = render(await getTemplate(ctx, reason), {
    author_name: comment.author,
    id: comment.id,
    permalink: comment.permalink,
    body: comment.body,
    parent_author: result.parentAuthor ?? '',
    parent_comment_id: result.parentCommentId ?? '',
  })
  await trySubmitCommentWithRetry(ctx, comment.id, replyBody)
}

async function loadConfirmationParticipants(
  ctx: TriggerContext,
  subredditName: string,
  parentUsername: string,
  confirmerUsername: string,
  oldFlairByUsername: Map<string, string | null>,
): Promise<{ parent: ConfirmationParticipant; confirmer: ConfirmationParticipant }> {
  const parent = await buildConfirmationParticipant(ctx, subredditName, parentUsername, oldFlairByUsername)
  const confirmer = parent.usernameLower === confirmerUsername.toLowerCase()
    ? parent
    : await buildConfirmationParticipant(ctx, subredditName, confirmerUsername, oldFlairByUsername)
  return { parent, confirmer }
}

async function buildConfirmationParticipant(
  ctx: TriggerContext,
  subredditName: string,
  username: string,
  oldFlairByUsername: Map<string, string | null>,
): Promise<ConfirmationParticipant> {
  const usernameLower = username.toLowerCase()
  const oldFlair = oldFlairByUsername.get(usernameLower) ?? null
  const isMod = await isUserModerator(ctx, subredditName, username)
  return {
    username,
    usernameLower,
    countKey: `confirmations:${usernameLower}`,
    oldFlair,
    isModerator: isMod,
  }
}

function oldFlairHints(
  comment: ProcessableComment,
  result: ValidationResult,
  parent: FetchedComment | null,
  grandparent: FetchedComment | null,
): Map<string, string | null> {
  const hints = new Map<string, string | null>()
  if (result.parentAuthor) {
    hints.set(
      result.parentAuthor.toLowerCase(),
      result.isModApproval ? grandparent?.authorFlair ?? null : parent?.authorFlair ?? null,
    )
  }
  if (result.confirmer) {
    hints.set(
      result.confirmer.toLowerCase(),
      result.isModApproval ? parent?.authorFlair ?? null : comment.authorFlair,
    )
  }
  return hints
}

function manualApprovalFlairHints(parent: FetchedComment, target: FetchedComment): Map<string, string | null> {
  return new Map([
    [parent.authorName.toLowerCase(), parent.authorFlair],
    [target.authorName.toLowerCase(), target.authorFlair],
  ])
}

async function completeConfirmation(
  ctx: TriggerContext,
  subredditName: string,
  comment: ProcessableComment,
  result: ValidationResult,
  oldFlairByUsername: Map<string, string | null>,
): Promise<ManualApprovalResult> {
  const flairTemplates = await loadFlairTemplates(ctx, subredditName)
  const participants = await loadConfirmationParticipants(
    ctx,
    subredditName,
    result.parentAuthor!,
    result.confirmer!,
    oldFlairByUsername,
  )
  const commit = await commitConfirmation(ctx, comment, result, participants.parent, participants.confirmer)
  if (!commit.committed) {
    return {
      approved: false,
      message: 'That trade comment has already been confirmed',
      parentAuthor: result.parentAuthor,
      confirmer: result.confirmer,
      parentCommentId: result.parentCommentId,
    }
  }
  console.debug(`Committed confirmation ${result.parentCommentId} from comment ${comment.id}`)

  const parentResult = await applyCommittedFlair(ctx, subredditName, commit.parent, flairTemplates)
  const confirmerResult = await applyCommittedFlair(ctx, subredditName, commit.confirmer, flairTemplates)

  const replyTo = result.replyToCommentId ?? comment.id
  const replyBody = render(await getTemplate(ctx, 'trade_confirmation'), {
    comment_id: replyTo,
    confirmer: result.confirmer ?? '',
    parent_author: result.parentAuthor ?? '',
    old_comment_flair: confirmerResult.oldFlair ?? 'unknown',
    new_comment_flair: confirmerResult.newFlair ?? 'unknown',
    old_parent_flair: parentResult.oldFlair ?? 'unknown',
    new_parent_flair: parentResult.newFlair ?? 'unknown',
  })
  await trySubmitCommentWithRetry(ctx, replyTo, replyBody)
  console.debug(
    `Confirmed ${result.parentCommentId}: u/${result.parentAuthor} ${parentResult.oldFlair ?? 'none'} -> ` +
    `${parentResult.newFlair ?? 'unchanged'}, u/${result.confirmer} ${confirmerResult.oldFlair ?? 'none'} -> ` +
    `${confirmerResult.newFlair ?? 'unchanged'}`,
  )

  return {
    approved: true,
    message: `Approved confirmation for u/${result.parentAuthor} and u/${result.confirmer}`,
    parentAuthor: result.parentAuthor,
    confirmer: result.confirmer,
    parentCommentId: result.parentCommentId,
  }
}

async function commitConfirmation(
  ctx: TriggerContext,
  comment: ProcessableComment,
  result: ValidationResult,
  parent: ConfirmationParticipant,
  confirmer: ConfirmationParticipant,
): Promise<ConfirmationCommit> {
  if (!result.parentCommentId) return { committed: false }
  const claimKey = `confirmed:${result.parentCommentId}`
  const participants = uniqueParticipants([parent, confirmer])

  for (let attempt = 0; attempt < 5; attempt++) {
    const txn = await ctx.redis.watch(claimKey, ...participants.map(participant => participant.countKey))
    const existing = await ctx.redis.get(claimKey)
    if (existing) {
      await txn.unwatch()
      const replay = replayCommittedConfirmation(existing, comment.id, parent, confirmer)
      if (replay) return replay
      return { committed: false }
    }

    const committed = new Map<string, CommittedConfirmationParticipant>()
    for (const participant of participants) {
      const stored = parseStoredCount(await ctx.redis.get(participant.countKey))
      committed.set(participant.usernameLower, {
        ...participant,
        newCount: (stored ?? 0) + 1,
        newFlair: null,
      })
    }

    const parentCommit = committed.get(parent.usernameLower)!
    const confirmerCommit = committed.get(confirmer.usernameLower)!
    const record: ConfirmationClaimRecord = {
      commentId: comment.id,
      replyToCommentId: result.replyToCommentId ?? comment.id,
      confirmer: result.confirmer ?? '',
      parentAuthor: result.parentAuthor ?? '',
      modApproval: result.isModApproval ?? false,
      parentCount: parentCommit.newCount,
      confirmerCount: confirmerCommit.newCount,
      createdAt: new Date().toISOString(),
    }

    await txn.multi()
    await txn.set(claimKey, JSON.stringify(record), { nx: true })
    for (const participant of participants) {
      const next = committed.get(participant.usernameLower)!
      await txn.set(participant.countKey, String(next.newCount))
    }
    const results = await txn.exec()
    if (results.length >= participants.length + 1 && results[0] !== false && results[0] !== null) {
      console.debug(
        `Atomically committed ${claimKey}: ` +
        participants.map(participant => `${participant.usernameLower}=${committed.get(participant.usernameLower)!.newCount}`).join(', '),
      )
      return {
        committed: true,
        parent: parentCommit,
        confirmer: confirmerCommit,
      }
    }

    console.debug(`Retrying atomic confirmation commit for ${claimKey}`)
  }

  throw new Error(`Failed to atomically commit confirmation ${claimKey}`)
}

function replayCommittedConfirmation(
  value: string,
  commentId: string,
  parent: ConfirmationParticipant,
  confirmer: ConfirmationParticipant,
): ConfirmationCommit | null {
  try {
    const record = JSON.parse(value) as Partial<ConfirmationClaimRecord>
    if (record.commentId !== commentId) return null
    if (typeof record.parentCount !== 'number' || typeof record.confirmerCount !== 'number') return null
    return {
      committed: true,
      parent: { ...parent, newCount: record.parentCount, newFlair: null },
      confirmer: { ...confirmer, newCount: record.confirmerCount, newFlair: null },
    }
  } catch {
    return null
  }
}

async function applyCommittedFlair(
  ctx: TriggerContext,
  subredditName: string,
  participant: CommittedConfirmationParticipant,
  flairTemplates: Map<[number, number], FlairTemplate>,
): Promise<CommittedConfirmationParticipant> {
  const tpl = findFlairTemplate(flairTemplates, participant.newCount, participant.isModerator)
    ?? findFlairTemplate(await refreshFlairTemplateCache(ctx, subredditName), participant.newCount, participant.isModerator)
  if (!tpl) return { ...participant, newFlair: null }

  const newFlair = formatFlairFromTemplate(tpl.template, participant.newCount)
  await trySetUserFlairWithFallback(
    ctx,
    {
      subredditName,
      username: participant.username,
      text: newFlair,
      flairTemplateId: tpl.id,
    },
    `set flair for u/${participant.username}`,
  )
  return { ...participant, newFlair }
}

function uniqueUsernames(usernames: string[]): string[] {
  const seen = new Set<string>()
  return usernames.filter(username => {
    const key = username.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueParticipants(participants: ConfirmationParticipant[]): ConfirmationParticipant[] {
  const seen = new Set<string>()
  return participants.filter(participant => {
    if (seen.has(participant.usernameLower)) return false
    seen.add(participant.usernameLower)
    return true
  })
}

function parseStoredCount(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}
