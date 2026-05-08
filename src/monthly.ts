import type { JobContext, ScheduledJobEvent } from '@devvit/public-api'
import { defaults } from './defaults/index.js'
import { redditApiCall } from './redditApi.js'
import { render, renderTitle } from './templates.js'
import { errorText, expirationFromNow } from './utils.js'

const MONTHLY_POST_CLAIM_TTL_MS = 15 * 60 * 1000

interface PreviousMonthlyPost {
  id: string
  title: string
  permalink: string
  stickied: boolean
  locked?: boolean
  removed?: boolean
  spam?: boolean
  archived?: boolean
  removedByCategory?: string
  unsticky: () => Promise<unknown>
  lock: () => Promise<unknown>
}

interface MonthlyPostCandidate extends PreviousMonthlyPost {
  subredditName: string
  createdAt: Date
  sticky: () => Promise<unknown>
}

interface CreatedMonthlyPost {
  id: string
  permalink: string
  setSuggestedCommentSort: (sort: 'NEW') => Promise<unknown>
  sticky: () => Promise<unknown>
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
  const titleTemplate = (await ctx.settings.get<string>('monthly_post_title')) || defaults.monthly_post_title
  const bodyTemplate = (await ctx.settings.get<string>('monthly_post')) || defaults.monthly_post
  const flairId = (await ctx.settings.get<string>('monthly_post_flair_id'))?.trim() || undefined
  const title = renderTitle(titleTemplate, now)

  const existing = botUser ? await findExistingPostForMonth(ctx, subredditName, now, botUser.username, title) : null
  if (existing) {
    await lockPreviousMonthlyPost(ctx, previousPost, existing.id)
    if (await tryReuseExistingMonthlyPost(ctx, subredditName, existing)) return
  }

  const post = await submitMonthlyPost(ctx, {
    subredditName,
    title,
    bodyTemplate,
    botName: botUser?.username ?? '',
    previous,
    flairId,
  })
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

async function submitMonthlyPost(
  ctx: JobContext,
  options: {
    subredditName: string
    title: string
    bodyTemplate: string
    botName: string
    previous: { title: string; permalink: string } | null
    flairId?: string
  },
): Promise<CreatedMonthlyPost> {
  return redditApiCall(ctx, () => ctx.reddit.submitPost({
    subredditName: options.subredditName,
    title: options.title,
    text: render(options.bodyTemplate, {
      bot_name: options.botName,
      subreddit_name: options.subredditName,
      previous_month_submission: options.previous ?? {
        title: 'Previous monthly thread',
        permalink: `https://www.reddit.com/r/${options.subredditName}/`,
      },
    }),
    sendreplies: false,
    flairId: options.flairId,
  }), `submit monthly post to r/${options.subredditName}`)
}

async function tryReuseExistingMonthlyPost(
  ctx: JobContext,
  subredditName: string,
  existing: MonthlyPostCandidate,
): Promise<boolean> {
  if (!isUsableMonthlyPost(existing)) {
    console.warn(`Existing monthly post ${existing.id} is removed, deleted, or archived; creating replacement`)
    return false
  }

  try {
    if (!existing.stickied) await redditApiCall(ctx, () => existing.sticky(), `sticky existing monthly post ${existing.id}`)
    await ctx.redis.set('currentMonthlyPost', existing.id)
    console.debug(`Monthly post already exists for r/${subredditName}: ${existing.id}`)
    return true
  } catch (error) {
    if (!isUnusablePostError(error)) throw error
    console.warn(`Existing monthly post ${existing.id} could not be reused: ${errorText(error)}`)
    return false
  }
}

async function lockPreviousMonthlyPost(
  ctx: JobContext,
  previousPost: PreviousMonthlyPost | null,
  currentPostId: string,
): Promise<void> {
  if (!previousPost || previousPost.id === currentPostId) return
  if (!isUsableMonthlyPost(previousPost)) {
    console.warn(`Skipping stale previous monthly post ${previousPost.id}: removed, deleted, or archived`)
    return
  }
  if (previousPost.stickied) {
    try {
      await redditApiCall(ctx, () => previousPost.unsticky(), `unsticky previous monthly post ${previousPost.id}`)
    } catch (error) {
      if (!isUnusablePostError(error)) throw error
      console.warn(`Could not unsticky stale previous monthly post ${previousPost.id}: ${errorText(error)}`)
      return
    }
  }
  if (previousPost.locked !== true) {
    try {
      await redditApiCall(ctx, () => previousPost.lock(), `lock previous monthly post ${previousPost.id}`)
    } catch (error) {
      if (!isUnusablePostError(error)) throw error
      console.warn(`Could not lock stale previous monthly post ${previousPost.id}: ${errorText(error)}`)
      return
    }
  }
  console.debug(`Locked previous monthly post ${previousPost.id}`)
}

function isUsableMonthlyPost(post: Pick<PreviousMonthlyPost, 'removed' | 'spam' | 'archived' | 'removedByCategory'>): boolean {
  return post.removed !== true &&
    post.spam !== true &&
    post.archived !== true &&
    post.removedByCategory !== 'deleted'
}

function isUnusablePostError(error: unknown): boolean {
  const text = errorText(error)
  return /\b(400|404)\b/.test(text) || /bad request|not found|deleted|removed/i.test(text)
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
  title: string,
): Promise<MonthlyPostCandidate | null> {
  const recent = await redditApiCall(ctx, () =>
    ctx.reddit.getPostsByUser({ username: botUsername, sort: 'new', limit: 25 }).all(),
  `get recent posts by u/${botUsername}`)
  return recent.find(p =>
    p.subredditName === subredditName &&
    p.title === title &&
    p.createdAt.getUTCFullYear() === when.getUTCFullYear() &&
    p.createdAt.getUTCMonth() === when.getUTCMonth() &&
    isUsableMonthlyPost(p),
  ) ?? null
}
