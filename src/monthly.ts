import { expirationFrom, systemClock, type Clock } from './clock.js'
import { getAppSettings, renderTemplate, renderTitle } from './settings.js'

export const MONTHLY_POST_JOB = 'monthly-post'
export const MONTHLY_POST_CRON = '0 0 1 * *'

const CURRENT_MONTHLY_POST_KEY = 'currentMonthlyPost'
const MONTHLY_POST_CLAIM_TTL_MS = 15 * 60 * 1000

interface MonthlyPostContext {
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<unknown>
    del(...keys: string[]): Promise<unknown>
  }
  settings?: {
    get<T>(name: string): Promise<T | undefined>
  }
  reddit: {
    getCurrentSubreddit(): Promise<{ name: string }>
    getPostById(id: string): Promise<MonthlyPost>
    getAppUser(): Promise<{ id: string; username?: string } | undefined>
    getPostsByUser(options: { username: string; sort: 'new'; limit: number }): {
      all(): Promise<MonthlyPostCandidate[]>
    }
    submitPost(options: {
      subredditName: string
      title: string
      text: string
      sendreplies: false
      flairId?: string
    }): Promise<CreatedMonthlyPost>
    modMail: {
      createConversation(options: {
        subredditName: string
        subject: string
        body: string
        to: null
      }): Promise<unknown>
    }
  }
}

interface MonthlyPost {
  id: string
  title: string
  permalink: string
  stickied: boolean
  locked?: boolean
  removed?: boolean
  spam?: boolean
  archived?: boolean
  removedByCategory?: string
  unsticky(): Promise<unknown>
  lock(): Promise<unknown>
}

interface MonthlyPostCandidate extends MonthlyPost {
  subredditName: string
  createdAt: Date
  sticky(): Promise<unknown>
}

interface CreatedMonthlyPost {
  id: string
  permalink: string
  setSuggestedCommentSort(sort: 'NEW'): Promise<unknown>
  sticky(): Promise<unknown>
}

export type MonthlyPostResult =
  | { status: 'created'; postId: string }
  | { status: 'reused'; postId: string }
  | { status: 'skipped_claimed' }

export async function onMonthlyPost(
  _event: unknown,
  ctx: MonthlyPostContext,
): Promise<void> {
  await processMonthlyPost(ctx)
}

export async function processMonthlyPost(
  ctx: MonthlyPostContext,
  options: { clock?: Clock } = {},
): Promise<MonthlyPostResult> {
  const clock = options.clock ?? systemClock
  const subredditName = (await ctx.reddit.getCurrentSubreddit()).name
  const now = clock.now()
  const claimKey = monthlyPostClaimKey(subredditName, now)
  const claimed = await ctx.redis.set(claimKey, String(now.getTime()), {
    nx: true,
    expiration: expirationFrom(now, MONTHLY_POST_CLAIM_TTL_MS),
  })
  if (!claimed) return { status: 'skipped_claimed' }

  try {
    return await createOrReuseMonthlyPost(ctx, subredditName, now)
  } finally {
    await ctx.redis.del(claimKey)
  }
}

async function createOrReuseMonthlyPost(
  ctx: MonthlyPostContext,
  subredditName: string,
  now: Date,
): Promise<MonthlyPostResult> {
  const settings = await getAppSettings(ctx)
  const previousPost = await loadPreviousPost(ctx)
  const botUser = await ctx.reddit.getAppUser()
  const title = renderTitle(settings.monthlyPostTitle, now, settings.dateLocale)
  const existing = botUser?.username
    ? await findExistingPostForMonth(ctx, subredditName, now, botUser.username, title)
    : null

  if (existing) {
    await lockPreviousPost(previousPost, existing.id)
    if (!existing.stickied) await existing.sticky()
    await ctx.redis.set(CURRENT_MONTHLY_POST_KEY, existing.id)
    return { status: 'reused', postId: existing.id }
  }

  const post = await ctx.reddit.submitPost({
    subredditName,
    title,
    text: renderTemplate(settings.monthlyPost, {
      bot_name: botUser?.username ?? '',
      subreddit_name: subredditName,
      confirmation_keyword: settings.confirmationKeyword,
      previous_month_submission: previousPost
        ? { title: previousPost.title, permalink: previousPost.permalink }
        : {
            title: 'Previous monthly thread',
            permalink: `https://www.reddit.com/r/${subredditName}/`,
          },
    }),
    sendreplies: false,
    flairId: settings.monthlyPostFlairId.trim() || undefined,
  })
  await post.setSuggestedCommentSort('NEW')
  await lockPreviousPost(previousPost, post.id)
  await post.sticky()
  await ctx.redis.set(CURRENT_MONTHLY_POST_KEY, post.id)
  await ctx.reddit.modMail.createConversation({
    subredditName,
    subject: 'Monthly thread is up',
    body: `Monthly trade-confirmation thread is live: ${post.permalink}`,
    to: null,
  })
  return { status: 'created', postId: post.id }
}

async function loadPreviousPost(ctx: MonthlyPostContext): Promise<MonthlyPost | null> {
  const postId = await ctx.redis.get(CURRENT_MONTHLY_POST_KEY)
  if (!postId) return null
  try {
    return await ctx.reddit.getPostById(postId)
  } catch {
    return null
  }
}

async function lockPreviousPost(previousPost: MonthlyPost | null, currentPostId: string): Promise<void> {
  if (!previousPost || previousPost.id === currentPostId || !isUsablePost(previousPost)) return
  if (previousPost.stickied) await previousPost.unsticky()
  if (previousPost.locked !== true) await previousPost.lock()
}

async function findExistingPostForMonth(
  ctx: MonthlyPostContext,
  subredditName: string,
  now: Date,
  botUsername: string,
  title: string,
): Promise<MonthlyPostCandidate | null> {
  const posts = await ctx.reddit.getPostsByUser({
    username: botUsername,
    sort: 'new',
    limit: 25,
  }).all()
  return posts.find(post =>
    post.subredditName === subredditName &&
    post.title === title &&
    post.createdAt.getUTCFullYear() === now.getUTCFullYear() &&
    post.createdAt.getUTCMonth() === now.getUTCMonth() &&
    isUsablePost(post),
  ) ?? null
}

function isUsablePost(post: Pick<MonthlyPost, 'removed' | 'spam' | 'archived' | 'removedByCategory'>): boolean {
  return post.removed !== true &&
    post.spam !== true &&
    post.archived !== true &&
    post.removedByCategory !== 'deleted'
}

function monthlyPostClaimKey(subredditName: string, when: Date): string {
  return `monthlyPostClaim:${subredditName.toLowerCase()}:${monthKey(when)}`
}

function monthKey(when: Date): string {
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`
}
