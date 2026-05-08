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
  unsticky: () => Promise<unknown>
  lock: () => Promise<unknown>
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
