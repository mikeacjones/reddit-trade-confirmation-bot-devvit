import type { CommentSubmit, ModAction } from '@devvit/protos'
import type { TriggerContext, JobContext, ScheduledJobEvent } from '@devvit/public-api'
import {
  evaluateConfirmation,
  findFlairTemplate,
  formatFlairFromTemplate,
  parseTradeCount,
  type FlairTemplate,
  type ValidationResult,
} from './rules.js'
import { render, renderTitle } from './templates.js'
import { defaults } from './defaults/index.js'

const PROCESSED_COMMENT_TTL_MS = 45 * 24 * 60 * 60 * 1000
const PROCESSING_COMMENT_TTL_MS = 5 * 60 * 1000
const FLAIR_TEMPLATE_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const MODERATOR_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const COMMENT_SUBMIT_SPACING_MS = 6500
const COMMENT_SUBMIT_SLOT_ATTEMPTS = 4
const REDDIT_WRITE_ATTEMPTS = 3
const RATE_LIMIT_FALLBACK_MS = 6000
const RATE_LIMIT_BACKOFF_PADDING_MS = 500
const MAX_RATE_LIMIT_SLEEP_MS = 20 * 1000
const MONTHLY_POST_CLAIM_TTL_MS = 15 * 60 * 1000

type RejectionReason = NonNullable<ValidationResult['reason']>
type RedditApiContext = Pick<TriggerContext, 'reddit' | 'redis'>
type FlairTemplateContext = RedditApiContext
type ModeratorCacheContext = RedditApiContext

const REDDIT_API_BACKOFF_KEY = 'reddit:api-backoff-until'
const MODERATOR_CACHE_KEY = 'moderators'
const MODERATOR_MEMBERSHIP_ACTIONS = new Set([
  'addmoderator',
  'acceptmoderatorinvite',
  'removemoderator',
  'setpermissions',
  'reordermoderators',
])

interface CachedFlairTemplate extends FlairTemplate {
  min: number
  max: number
}

interface CachedModeratorList {
  usernames: string[]
  syncedAt: string
}

interface ConfirmationParticipant {
  username: string
  usernameLower: string
  countKey: string
  oldFlair: string | null
  seedCount: number
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

interface PreviousMonthlyPost {
  id: string
  title: string
  permalink: string
  stickied: boolean
  locked?: boolean
  unsticky: () => Promise<unknown>
  lock: () => Promise<unknown>
}

interface ProcessableComment {
  id: string
  body: string
  author: string
  parentId: string
  postId: string
  permalink: string
}

export async function onCommentSubmit(event: CommentSubmit, ctx: TriggerContext): Promise<void> {
  const c = event.comment
  if (!c) return
  await processComment(ctx, {
    id: c.id,
    body: c.body,
    author: event.author?.name ?? '',
    parentId: c.parentId,
    postId: c.postId,
    permalink: c.permalink,
  }, event.subreddit?.name ?? '')
}

export async function onModAction(event: ModAction, ctx: TriggerContext): Promise<void> {
  if (!event.action || !MODERATOR_MEMBERSHIP_ACTIONS.has(event.action)) return
  const subredditName = event.subreddit?.name ||
    (await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')).name
  await refreshModeratorCache(ctx, subredditName)
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

  const parent = await fetchParent(ctx, comment.parentId)
  const grandparent = shouldFetchGrandparent(comment, parent) ? await fetchParent(ctx, parent.parentId) : null

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

  const flairTemplates = await loadFlairTemplates(ctx, subredditName)
  const participants = await loadConfirmationParticipants(
    ctx,
    subredditName,
    result.parentAuthor!,
    result.confirmer!,
  )
  const commit = await commitConfirmation(ctx, comment, result, participants.parent, participants.confirmer)
  if (!commit.committed) {
    console.debug(`Rejecting ${comment.id}: parent comment ${result.parentCommentId} already claimed`)
    await replyWithReason(ctx, comment, 'already_confirmed', result)
    return true
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
  return true
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
      parentId: c.parentId,
      postId: c.postId,
      permalink: c.permalink,
    }, subredditName)
    if (ran) processed++
  }
  return { scanned: comments.length, processed }
}

async function fetchParent(ctx: TriggerContext, fullName: string) {
  if (!fullName.startsWith('t1_')) return null
  const c = await redditApiCall(ctx, () => ctx.reddit.getCommentById(fullName as `t1_${string}`), `get comment ${fullName}`)
  return {
    id: c.id,
    parentId: c.parentId,
    authorName: c.authorName,
    removed: c.removed ?? false,
    isRoot: c.parentId.startsWith('t3_'),
    body: c.body ?? '',
  }
}

function shouldFetchGrandparent(
  comment: ProcessableComment,
  parent: Awaited<ReturnType<typeof fetchParent>>,
): parent is NonNullable<typeof parent> {
  return !!parent && !parent.isRoot && comment.body.toLowerCase().includes('approved')
}

async function isUserModerator(ctx: RedditApiContext, subredditName: string, username: string): Promise<boolean> {
  if (!subredditName || !username) return false
  let moderators = await loadModeratorCache(ctx)
  if (!moderators) moderators = await refreshModeratorCache(ctx, subredditName)
  return moderators.has(username.toLowerCase())
}

async function loadModeratorCache(ctx: ModeratorCacheContext): Promise<Set<string> | null> {
  const cached = await ctx.redis.get(MODERATOR_CACHE_KEY)
  if (cached) {
    const parsed = parseCachedModeratorList(cached)
    if (parsed) {
      console.debug(`Moderator cache hit (${parsed.size} users)`)
      return parsed
    }
  }
  console.debug('Moderator cache miss')
  return null
}

export async function refreshModeratorCache(
  ctx: ModeratorCacheContext,
  subredditName: string,
): Promise<Set<string>> {
  const sub = await redditApiCall(ctx, () => ctx.reddit.getSubredditByName(subredditName), `get subreddit ${subredditName}`)
  const moderators = await redditApiCall(ctx, () => sub.getModerators().all(), `get moderators for r/${subredditName}`)
  const usernames = moderators
    .map(mod => mod.username.toLowerCase())
    .filter(Boolean)
    .sort()
  const cached: CachedModeratorList = {
    usernames,
    syncedAt: new Date().toISOString(),
  }
  await ctx.redis.set(MODERATOR_CACHE_KEY, JSON.stringify(cached), {
    expiration: expirationFromNow(MODERATOR_CACHE_TTL_MS),
  })
  console.debug(`Moderator cache refreshed for r/${subredditName} (${usernames.length} users)`)
  return new Set(usernames)
}

function parseCachedModeratorList(value: string): Set<string> | null {
  try {
    const parsed = JSON.parse(value) as CachedModeratorList
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.usernames)) return null
    if (!parsed.usernames.every(username => typeof username === 'string')) return null
    return new Set(parsed.usernames.map(username => username.toLowerCase()))
  } catch {
    return null
  }
}

export async function adjustUserTradeCount(
  ctx: RedditApiContext,
  rawUsername: string,
  count: number,
): Promise<{ username: string; count: number; oldFlair: string | null; newFlair: string }> {
  const username = normalizeUsername(rawUsername)
  if (!username) throw new Error('Username is required')
  if (!Number.isInteger(count) || count < 0) throw new Error('Trade count must be a non-negative whole number')

  const { name: subredditName } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
  const sub = await redditApiCall(ctx, () => ctx.reddit.getSubredditByName(subredditName), `get subreddit ${subredditName}`)
  const userFlair = await redditApiCall(ctx, () => sub.getUserFlair({ usernames: [username] }), `get flair for u/${username}`)
  const oldFlair = userFlair.users[0]?.flairText ?? null

  const flairTemplates = await loadFlairTemplates(ctx, subredditName)
  const isMod = await isUserModerator(ctx, subredditName, username)
  const tpl = findFlairTemplate(flairTemplates, count, isMod)
    ?? findFlairTemplate(await refreshFlairTemplateCache(ctx, subredditName), count, isMod)
  if (!tpl) throw new Error(`No ${isMod ? 'moderator' : 'user'} flair template found for trade count ${count}`)

  const newFlair = formatFlairFromTemplate(tpl.template, count)
  const countKey = `confirmations:${username.toLowerCase()}`
  const previousCount = await ctx.redis.get(countKey)
  await ctx.redis.set(countKey, String(count))

  try {
    await redditApiCall(ctx, () =>
      ctx.reddit.setUserFlair({ subredditName, username, text: newFlair, flairTemplateId: tpl.id }),
    `set manual flair for u/${username}`)
  } catch (error) {
    if (previousCount === undefined) await ctx.redis.del(countKey)
    else await ctx.redis.set(countKey, previousCount)
    throw error
  }

  console.log(`Adjusted trade count for u/${username} in r/${subredditName}: ${oldFlair ?? 'none'} -> ${newFlair}`)
  return { username, count, oldFlair, newFlair }
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/^\/?u\//i, '').replace(/^@/, '')
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
): Promise<{ parent: ConfirmationParticipant; confirmer: ConfirmationParticipant }> {
  const sub = await redditApiCall(ctx, () => ctx.reddit.getSubredditByName(subredditName), `get subreddit ${subredditName}`)
  const usernames = uniqueUsernames([parentUsername, confirmerUsername])
  const userFlair = await redditApiCall(ctx, () => sub.getUserFlair({ usernames }), `get flair for confirmation users`)
  const flairByUsername = new Map(
    userFlair.users
      .filter(user => user.user)
      .map(user => [user.user!.toLowerCase(), user.flairText ?? null]),
  )

  const parent = await buildConfirmationParticipant(ctx, subredditName, parentUsername, flairByUsername)
  const confirmer = parent.usernameLower === confirmerUsername.toLowerCase()
    ? parent
    : await buildConfirmationParticipant(ctx, subredditName, confirmerUsername, flairByUsername)
  return { parent, confirmer }
}

async function buildConfirmationParticipant(
  ctx: TriggerContext,
  subredditName: string,
  username: string,
  flairByUsername: Map<string, string | null>,
): Promise<ConfirmationParticipant> {
  const usernameLower = username.toLowerCase()
  const oldFlair = flairByUsername.get(usernameLower) ?? null
  const isMod = await isUserModerator(ctx, subredditName, username)
  return {
    username,
    usernameLower,
    countKey: `confirmations:${usernameLower}`,
    oldFlair,
    seedCount: parseTradeCount(oldFlair) ?? 0,
    isModerator: isMod,
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
        newCount: (stored ?? participant.seedCount) + 1,
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
  await tryRedditWriteWithRetry(ctx, () =>
    ctx.reddit.setUserFlair({
      subredditName,
      username: participant.username,
      text: newFlair,
      flairTemplateId: tpl.id,
    }),
  `set flair for u/${participant.username}`)
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

async function trySubmitCommentWithRetry(ctx: TriggerContext, id: string, text: string): Promise<boolean> {
  return tryRedditWriteWithRetry(ctx, async () => {
    await waitForCommentSubmitSlot(ctx)
    await ctx.reddit.submitComment({ id, text })
  }, `reply to ${id}`)
}

async function tryRedditWriteWithRetry<T>(
  ctx: RedditApiContext,
  fn: () => Promise<T>,
  description: string,
): Promise<boolean> {
  try {
    await redditApiCall(ctx, fn, description)
    return true
  } catch (error) {
    console.warn(`Reddit API write failed after retries (${description}): ${errorText(error)}`)
    return false
  }
}

async function waitForCommentSubmitSlot(ctx: TriggerContext): Promise<void> {
  for (let attempt = 0; attempt < COMMENT_SUBMIT_SLOT_ATTEMPTS; attempt++) {
    const claimed = await ctx.redis.set('reddit:comment-submit-slot', String(Date.now()), {
      nx: true,
      expiration: expirationFromNow(COMMENT_SUBMIT_SPACING_MS),
    })
    if (claimed) return
    await sleep(COMMENT_SUBMIT_SPACING_MS + jitterMs())
  }
  throw new Error('Timed out waiting for Reddit comment submit slot')
}

export async function redditApiCall<T>(
  ctx: RedditApiContext,
  fn: () => Promise<T>,
  description: string,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < REDDIT_WRITE_ATTEMPTS; attempt++) {
    try {
      await waitForRedditApiBackoff(ctx, description)
      console.debug(`Reddit API call: ${description} (attempt ${attempt + 1}/${REDDIT_WRITE_ATTEMPTS})`)
      const result = await fn()
      if (attempt > 0) console.debug(`Reddit API call succeeded after retry: ${description}`)
      return result
    } catch (error) {
      lastError = error
      const delayMs = redditRateLimitDelayMs(error)
      if (delayMs === null || attempt === REDDIT_WRITE_ATTEMPTS - 1) throw error

      await setRedditApiBackoff(ctx, delayMs)
      console.warn(
        `Reddit API rate limit during ${description}; retrying in ${delayMs}ms ` +
        `(attempt ${attempt + 1}/${REDDIT_WRITE_ATTEMPTS})`,
      )
      await waitForRedditApiBackoff(ctx, description)
    }
  }
  throw lastError
}

async function waitForRedditApiBackoff(ctx: RedditApiContext, description: string): Promise<void> {
  const value = await ctx.redis.get(REDDIT_API_BACKOFF_KEY)
  const backoffUntil = value ? parseInt(value, 10) : 0
  if (!Number.isFinite(backoffUntil)) return

  const delayMs = backoffUntil - Date.now()
  if (delayMs <= 0) return
  if (delayMs > MAX_RATE_LIMIT_SLEEP_MS) {
    throw new Error(`Reddit API backoff active for ${delayMs}ms before ${description}`)
  }

  console.debug(`Waiting ${delayMs}ms for Reddit API backoff before ${description}`)
  await sleep(delayMs)
}

async function setRedditApiBackoff(ctx: RedditApiContext, delayMs: number): Promise<void> {
  const backoffUntil = Date.now() + delayMs + RATE_LIMIT_BACKOFF_PADDING_MS
  await ctx.redis.set(REDDIT_API_BACKOFF_KEY, String(backoffUntil), {
    expiration: expirationFromNow(delayMs + RATE_LIMIT_BACKOFF_PADDING_MS),
  })
}

function redditRateLimitDelayMs(error: unknown): number | null {
  const metadataDelayMs = redditRateLimitMetadataDelayMs(error)
  if (metadataDelayMs !== null) return Math.max(metadataDelayMs, RATE_LIMIT_FALLBACK_MS)

  const text = errorText(error)
  if (!/ratelimit/i.test(text)) return null
  const retryAfter = text.match(/retry-after[:= ]+(\d+)/i)
  if (retryAfter) return Math.max(parseInt(retryAfter[1], 10) * 1000, RATE_LIMIT_FALLBACK_MS)
  const seconds = text.match(/take a break for (\d+) seconds?/i)
  if (seconds) return Math.max(parseInt(seconds[1], 10) * 1000, RATE_LIMIT_FALLBACK_MS)
  const minutes = text.match(/take a break for (\d+) minutes?/i)
  if (minutes) return parseInt(minutes[1], 10) * 60 * 1000
  return RATE_LIMIT_FALLBACK_MS
}

function redditRateLimitMetadataDelayMs(error: unknown): number | null {
  const retryAfter = metadataNumber(error, 'retry-after')
  if (retryAfter !== null) return retryAfter * 1000

  const remaining = metadataNumber(error, 'x-ratelimit-remaining')
  const reset = metadataNumber(error, 'x-ratelimit-reset')
  if (reset !== null && (remaining === null || remaining <= 0)) return reset * 1000
  return null
}

function metadataNumber(error: unknown, key: string): number | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as {
    metadata?: {
      get?: (key: string) => unknown
      internalRepr?: Map<string, unknown>
    }
    cause?: unknown
  }

  const value = metadataValue(candidate.metadata, key)
  if (value !== null) return value
  if ('cause' in candidate) return metadataNumber(candidate.cause, key)
  return null
}

function metadataValue(
  metadata: { get?: (key: string) => unknown; internalRepr?: Map<string, unknown> } | undefined,
  key: string,
): number | null {
  if (!metadata) return null
  if (metadata.get) {
    const value = parseMetadataNumber(metadata.get(key))
    if (value !== null) return value
  }
  if (metadata.internalRepr instanceof Map) {
    const value = parseMetadataNumber(metadata.internalRepr.get(key))
    if (value !== null) return value
  }
  return null
}

function parseMetadataNumber(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return null
  const parsed = parseFloat(String(raw).split(',')[0])
  return Number.isFinite(parsed) ? parsed : null
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const parts: string[] = []
  if ('message' in error) parts.push(String(error.message))
  if ('details' in error) parts.push(String(error.details))
  if ('cause' in error) parts.push(errorText(error.cause))
  return parts.join(' ')
}

function expirationFromNow(ms: number): Date {
  return new Date(Date.now() + ms)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function jitterMs(): number {
  return Math.floor(Math.random() * 500)
}

async function loadFlairTemplates(
  ctx: FlairTemplateContext,
  subredditName: string,
): Promise<Map<[number, number], FlairTemplate>> {
  const cached = await ctx.redis.get(flairTemplateCacheKey(subredditName))
  if (cached) {
    const parsed = parseCachedFlairTemplates(cached)
    if (parsed) {
      console.debug(`Flair template cache hit for r/${subredditName} (${parsed.size} templates)`)
      return parsed
    }
  }

  console.debug(`Flair template cache miss for r/${subredditName}`)
  return refreshFlairTemplateCache(ctx, subredditName)
}

export async function refreshFlairTemplateCache(
  ctx: FlairTemplateContext,
  subredditName: string,
): Promise<Map<[number, number], FlairTemplate>> {
  const sub = await redditApiCall(ctx, () => ctx.reddit.getSubredditByName(subredditName), `get subreddit ${subredditName}`)
  const templates = await redditApiCall(ctx, () => sub.getUserFlairTemplates(), `get flair templates for r/${subredditName}`)
  const cached: CachedFlairTemplate[] = []
  const RANGE = /Trades: (\d+)-(\d+)/
  for (const t of templates) {
    const m = t.text.match(RANGE)
    if (!m) continue
    cached.push({
      min: parseInt(m[1], 10),
      max: parseInt(m[2], 10),
      id: t.id,
      template: t.text,
      modOnly: t.modOnly ?? false,
    })
  }
  await ctx.redis.set(flairTemplateCacheKey(subredditName), JSON.stringify(cached), {
    expiration: expirationFromNow(FLAIR_TEMPLATE_CACHE_TTL_MS),
  })
  console.debug(`Flair template cache refreshed for r/${subredditName} (${cached.length} templates)`)
  return flairTemplateMap(cached)
}

function parseCachedFlairTemplates(value: string): Map<[number, number], FlairTemplate> | null {
  try {
    const parsed = JSON.parse(value) as CachedFlairTemplate[]
    if (!Array.isArray(parsed)) return null
    if (!parsed.every(isCachedFlairTemplate)) return null
    return flairTemplateMap(parsed)
  } catch {
    return null
  }
}

function isCachedFlairTemplate(value: unknown): value is CachedFlairTemplate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.min === 'number' &&
    typeof candidate.max === 'number' &&
    typeof candidate.id === 'string' &&
    typeof candidate.template === 'string' &&
    typeof candidate.modOnly === 'boolean'
}

function flairTemplateMap(templates: CachedFlairTemplate[]): Map<[number, number], FlairTemplate> {
  const result = new Map<[number, number], FlairTemplate>()
  for (const t of templates) {
    result.set([t.min, t.max], {
      id: t.id,
      template: t.template,
      modOnly: t.modOnly,
    })
  }
  return result
}

function flairTemplateCacheKey(subredditName: string): string {
  return `flairTemplates:${subredditName.toLowerCase()}`
}

export async function onMonthlyPost(_event: ScheduledJobEvent<undefined>, ctx: JobContext): Promise<void> {
  const { name: subredditName } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
  const now = new Date()
  const claimKey = monthlyPostClaimKey(subredditName, now)
  const claimed = await ctx.redis.set(claimKey, String(Date.now()), {
    nx: true,
    expiration: expirationFromNow(MONTHLY_POST_CLAIM_TTL_MS),
  })
  if (!claimed) {
    console.debug(`Skipping monthly post for r/${subredditName} ${monthlyPostMonthKey(now)}: claim already held`)
    return
  }

  try {
    await createOrRefreshMonthlyPost(ctx, subredditName, now)
  } finally {
    await ctx.redis.del(claimKey).catch(error => {
      console.warn(`Failed to release ${claimKey}: ${errorText(error)}`)
    })
  }
}

async function createOrRefreshMonthlyPost(
  ctx: JobContext,
  subredditName: string,
  now: Date,
): Promise<void> {
  const previousId = await ctx.redis.get('currentMonthlyPost')
  let previous: { title: string; permalink: string } | null = null
  let previousPost: PreviousMonthlyPost | null = null
  if (previousId) {
    try {
      const prev = await redditApiCall(ctx, () => ctx.reddit.getPostById(previousId as `t3_${string}`), `get previous post ${previousId}`)
      previousPost = prev
      previous = { title: prev.title, permalink: prev.permalink }
    } catch (error) {
      console.warn(`Failed to load previous monthly post ${previousId}: ${errorText(error)}`)
    }
  }

  const botUser = await redditApiCall(ctx, () => ctx.reddit.getAppUser(), 'get app user')
  const existing = botUser ? await findExistingPostForMonth(ctx, subredditName, now, botUser.username) : null
  if (existing) {
    await lockPreviousMonthlyPost(ctx, previousPost, existing.id)
    if (!existing.stickied) await redditApiCall(ctx, () => existing.sticky(), `sticky existing monthly post ${existing.id}`)
    await ctx.redis.set('currentMonthlyPost', existing.id)
    console.debug(`Monthly post already exists for r/${subredditName}: ${existing.id}`)
    return
  }

  const titleTemplate = (await ctx.settings.get<string>('monthly_post_title')) || defaults.monthly_post_title
  const bodyTemplate = (await ctx.settings.get<string>('monthly_post')) || defaults.monthly_post
  const flairId = (await ctx.settings.get<string>('monthly_post_flair_id'))?.trim() || undefined

  const post = await redditApiCall(ctx, () => ctx.reddit.submitPost({
    subredditName,
    title: renderTitle(titleTemplate, now),
    text: render(bodyTemplate, {
      bot_name: botUser?.username ?? '',
      subreddit_name: subredditName,
      previous_month_submission: previous ?? {
        title: 'Previous monthly thread',
        permalink: `https://www.reddit.com/r/${subredditName}/`,
      },
    }),
    sendreplies: false,
    flairId,
  }), `submit monthly post to r/${subredditName}`)
  await redditApiCall(ctx, () => post.setSuggestedCommentSort('NEW'), `set suggested sort for ${post.id}`)
  await lockPreviousMonthlyPost(ctx, previousPost, post.id)
  await redditApiCall(ctx, () => post.sticky(), `sticky monthly post ${post.id}`)
  await ctx.redis.set('currentMonthlyPost', post.id)

  await redditApiCall(ctx, () => ctx.reddit.modMail.createConversation({
    subredditName,
    subject: 'Monthly thread is up',
    body: `Monthly trade-confirmation thread is live: ${post.permalink}`,
    to: null,
  }), `create monthly post modmail for r/${subredditName}`)
}

async function lockPreviousMonthlyPost(
  ctx: JobContext,
  previousPost: PreviousMonthlyPost | null,
  currentPostId: string,
): Promise<void> {
  if (!previousPost || previousPost.id === currentPostId) return
  if (previousPost.stickied) {
    await redditApiCall(ctx, () => previousPost.unsticky(), `unsticky previous monthly post ${previousPost.id}`)
  }
  if (previousPost.locked !== true) {
    await redditApiCall(ctx, () => previousPost.lock(), `lock previous monthly post ${previousPost.id}`)
  }
  console.debug(`Locked previous monthly post ${previousPost.id}`)
}

function monthlyPostClaimKey(subredditName: string, when: Date): string {
  return `monthlyPostClaim:${subredditName.toLowerCase()}:${monthlyPostMonthKey(when)}`
}

function monthlyPostMonthKey(when: Date): string {
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`
}

async function findExistingPostForMonth(
  ctx: JobContext,
  subredditName: string,
  when: Date,
  botUsername: string,
) {
  const recent = await redditApiCall(ctx, () =>
    ctx.reddit.getPostsByUser({ username: botUsername, sort: 'new', limit: 25 }).all(),
  `get recent posts by u/${botUsername}`)
  return recent.find(p =>
    p.subredditName === subredditName &&
    p.createdAt.getUTCFullYear() === when.getUTCFullYear() &&
    p.createdAt.getUTCMonth() === when.getUTCMonth(),
  ) ?? null
}
