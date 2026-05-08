import type { CommentSubmit } from '@devvit/protos'
import type { TriggerContext, JobContext, ScheduledJobEvent } from '@devvit/public-api'
import {
  evaluateConfirmation,
  findFlairTemplate,
  formatFlairFromTemplate,
  parseTradeCount,
  type FlairTemplate,
} from './rules.js'
import { render, renderTitle } from './templates.js'
import { defaults } from './defaults/index.js'

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

async function processComment(
  ctx: TriggerContext,
  comment: ProcessableComment,
  subredditName: string,
): Promise<boolean> {
  const key = `processed:${comment.id}`
  if (await ctx.redis.get(key)) return false
  await ctx.redis.set(key, '1', { expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })

  const submission = await ctx.reddit.getPostById(comment.postId as `t3_${string}`)
  const botUser = await ctx.reddit.getAppUser()
  if (!botUser) return true
  if (submission.authorId !== botUser.id) return true
  if (submission.locked) return true

  const isCurrent = submission.id === (await ctx.redis.get('currentMonthlyPost'))
  const isModerator = await isUserModerator(ctx, subredditName, comment.author)

  const parent = await fetchParent(ctx, comment.parentId)
  const grandparent = parent ? await fetchParent(ctx, parent.parentId) : null
  const parentIsSaved = parent ? !!(await ctx.redis.get(`confirmed:${parent.id}`)) : false

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
      parentIsSaved,
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
    const replyBody = render(await getTemplate(ctx, result.reason), {
      author_name: comment.author,
      id: comment.id,
      permalink: comment.permalink,
      body: comment.body,
      parent_author: result.parentAuthor ?? '',
      parent_comment_id: result.parentCommentId ?? '',
    })
    await ctx.reddit.submitComment({ id: comment.id, text: replyBody })
    return true
  }

  const parentResult = await seedAndIncrementFlair(ctx, subredditName, result.parentAuthor!)
  const confirmerResult = await seedAndIncrementFlair(ctx, subredditName, result.confirmer!)

  if (result.parentCommentId) {
    await ctx.redis.set(`confirmed:${result.parentCommentId}`, '1')
  }

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
  await ctx.reddit.submitComment({ id: replyTo, text: replyBody })
  return true
}

export async function rescanCurrentMonthlyPost(ctx: TriggerContext): Promise<{ scanned: number; processed: number }> {
  const postId = await ctx.redis.get('currentMonthlyPost')
  if (!postId) return { scanned: 0, processed: 0 }
  const { name: subredditName } = await ctx.reddit.getCurrentSubreddit()
  const comments = await ctx.reddit
    .getComments({ postId: postId as `t3_${string}`, limit: 1000, pageSize: 100 })
    .all()
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
  const c = await ctx.reddit.getCommentById(fullName as `t1_${string}`)
  return {
    id: c.id,
    parentId: c.parentId,
    authorName: c.authorName,
    removed: c.removed ?? false,
    isRoot: c.parentId.startsWith('t3_'),
    body: c.body ?? '',
  }
}

async function isUserModerator(ctx: TriggerContext, subredditName: string, username: string): Promise<boolean> {
  if (!subredditName || !username) return false
  const sub = await ctx.reddit.getSubredditByName(subredditName)
  const mods = await sub.getModerators({ username }).all()
  return mods.length > 0
}

async function getTemplate(ctx: TriggerContext, name: string): Promise<string> {
  return (await ctx.settings.get<string>(name))?.trim() || defaults[name]
}

async function seedAndIncrementFlair(ctx: TriggerContext, subredditName: string, username: string) {
  const key = `confirmations:${username.toLowerCase()}`
  const sub = await ctx.reddit.getSubredditByName(subredditName)
  const userFlair = await sub.getUserFlair({ usernames: [username] })
  const oldFlair = userFlair.users[0]?.flairText ?? null

  if ((await ctx.redis.get(key)) === undefined) {
    await ctx.redis.set(key, String(parseTradeCount(oldFlair) ?? 0), { nx: true })
  }

  const newCount = await ctx.redis.incrBy(key, 1)
  const isMod = await isUserModerator(ctx, subredditName, username)
  const tpl = findFlairTemplate(await loadFlairTemplates(ctx, subredditName), newCount, isMod)
  if (!tpl) return { oldFlair, newFlair: null as string | null }

  const newFlair = formatFlairFromTemplate(tpl.template, newCount)
  await ctx.reddit.setUserFlair({ subredditName, username, text: newFlair, flairTemplateId: tpl.id })
  return { oldFlair, newFlair }
}

async function loadFlairTemplates(ctx: TriggerContext, subredditName: string): Promise<Map<[number, number], FlairTemplate>> {
  const sub = await ctx.reddit.getSubredditByName(subredditName)
  const templates = await sub.getUserFlairTemplates()
  const result = new Map<[number, number], FlairTemplate>()
  const RANGE = /Trades: (\d+)-(\d+)/
  for (const t of templates) {
    const m = t.text.match(RANGE)
    if (!m) continue
    result.set([parseInt(m[1], 10), parseInt(m[2], 10)], {
      id: t.id,
      template: t.text,
      modOnly: t.modOnly ?? false,
    })
  }
  return result
}

export async function onMonthlyPost(_event: ScheduledJobEvent<undefined>, ctx: JobContext): Promise<void> {
  const { name: subredditName } = await ctx.reddit.getCurrentSubreddit()
  const now = new Date()

  const previousId = await ctx.redis.get('currentMonthlyPost')
  let previous: { title: string; permalink: string } | null = null
  if (previousId) {
    try {
      const prev = await ctx.reddit.getPostById(previousId as `t3_${string}`)
      previous = { title: prev.title, permalink: prev.permalink }
      if (prev.stickied) await prev.unsticky()
    } catch {}
  }

  const existing = await findExistingPostForMonth(ctx, subredditName, now)
  if (existing) {
    await ctx.redis.set('currentMonthlyPost', existing.id)
    if (!existing.stickied) await existing.sticky()
    return
  }

  const titleTemplate = (await ctx.settings.get<string>('monthly_post_title')) || defaults.monthly_post_title
  const bodyTemplate = (await ctx.settings.get<string>('monthly_post')) || defaults.monthly_post
  const flairId = (await ctx.settings.get<string>('monthly_post_flair_id'))?.trim() || undefined
  const botUser = await ctx.reddit.getAppUser()

  const post = await ctx.reddit.submitPost({
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
  })
  await post.setSuggestedCommentSort('NEW')
  await post.sticky()
  await ctx.redis.set('currentMonthlyPost', post.id)

  await ctx.reddit.modMail.createConversation({
    subredditName,
    subject: 'Monthly thread is up',
    body: `Monthly trade-confirmation thread is live: ${post.permalink}`,
    to: null,
  })
}

async function findExistingPostForMonth(ctx: JobContext, subredditName: string, when: Date) {
  const botUser = await ctx.reddit.getAppUser()
  if (!botUser) return null
  const recent = await ctx.reddit.getPostsByUser({ username: botUser.username, sort: 'new', limit: 25 }).all()
  return recent.find(p =>
    p.subredditName === subredditName &&
    p.createdAt.getUTCFullYear() === when.getUTCFullYear() &&
    p.createdAt.getUTCMonth() === when.getUTCMonth(),
  ) ?? null
}

export async function onLockSubmissions(_event: ScheduledJobEvent<undefined>, ctx: JobContext): Promise<void> {
  const { name: subredditName } = await ctx.reddit.getCurrentSubreddit()
  const botUser = await ctx.reddit.getAppUser()
  if (!botUser) return

  const recent = await ctx.reddit.getPostsByUser({ username: botUser.username, sort: 'new', limit: 50 }).all()
  for (const p of recent) {
    if (p.subredditName !== subredditName || p.stickied) continue
    await p.lock()
  }

  await ctx.reddit.modMail.createConversation({
    subredditName,
    subject: 'Old threads locked',
    body: 'Old confirmation threads have been locked.',
    to: null,
  })
}
