import type { JobContext, ScheduledJobEvent } from '@devvit/public-api'
import { defaults } from './defaults/index.js'
import { getLanguageSettings } from './language.js'
import { recordPreviousMonthlyPost } from './previousThread.js'
import { redditApiCall } from './redditApi.js'
import { render, renderTitle } from './templates.js'
import { errorText, expirationFromNow } from './utils.js'

const MONTHLY_POST_CLAIM_TTL_MS = 15 * 60 * 1000
const MONTHLY_ROTATION_TTL_MS = 45 * 24 * 60 * 60 * 1000

/**
 * Which steps of one month's rotation are done, kept in Redis so a retry after a partial failure
 * finishes the outstanding steps instead of assuming the pointer still names the previous thread.
 */
interface MonthlyRotation {
  previousId: string | null
  sortSet: boolean
  modmailSent: boolean
}

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
  setSuggestedCommentSort: (sort: 'NEW') => Promise<unknown>
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
  const rotationKey = monthlyRotationKey(subredditName, now)
  let rotation = await loadRotation(ctx, rotationKey)
  // Once the pointer has moved to this month's thread it names the thread itself, so a retry takes the
  // previous thread from the rotation record, which was written before the pointer moved.
  const previousId = rotation ? rotation.previousId : (await ctx.redis.get('currentMonthlyPost')) ?? null
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
  const { dateLocale } = await getLanguageSettings(ctx)
  const title = renderTitle(titleTemplate, now, dateLocale)

  const existing = botUser ? await findExistingPostForMonth(ctx, subredditName, now, botUser.username, title) : null
  if (existing) {
    await openGraceWindow(ctx, previousId, previousPost, existing.id)
    await lockPreviousMonthlyPost(ctx, previousPost, existing.id)
    if (await tryReuseExistingMonthlyPost(ctx, subredditName, existing)) {
      // Without a record the thread was not made by this rotation logic (older version or by hand),
      // and its follow-up steps are taken as done.
      if (rotation) await finishRotation(ctx, rotationKey, rotation, subredditName, existing)
      return
    }
  }

  rotation = {
    previousId: previousId ?? null,
    sortSet: false,
    modmailSent: false,
  }
  await saveRotation(ctx, rotationKey, rotation)

  const post = await submitMonthlyPost(ctx, {
    subredditName,
    title,
    bodyTemplate,
    botName: botUser?.username ?? '',
    previous,
    flairId,
  })
  // Point at the new thread before the fallible follow-up calls; otherwise a failure there leaves
  // the pointer on the locked old thread and replies to the new one are rejected for good.
  await openGraceWindow(ctx, previousId, previousPost, post.id)
  await ctx.redis.set('currentMonthlyPost', post.id)
  await setSortStep(ctx, rotationKey, rotation, post)
  await lockPreviousMonthlyPost(ctx, previousPost, post.id)
  await redditApiCall(ctx, () => post.sticky(), `sticky monthly post ${post.id}`)
  await sendModmailStep(ctx, rotationKey, rotation, subredditName, post)
}

/**
 * Gives confirmations on the thread being rotated out a grace window that runs from the moment it is
 * locked, however late a retry of a failed rotation does that. A thread that is already locked keeps
 * the window recorded when it was locked, so repeating a finished rotation does not extend it.
 */
async function openGraceWindow(
  ctx: JobContext,
  previousId: string | null,
  previousPost: PreviousMonthlyPost | null,
  newPostId: string,
): Promise<void> {
  if (!previousId || previousId === newPostId) return
  await recordPreviousMonthlyPost(ctx, previousId, { restart: previousPost?.locked !== true })
}

/** Finish the steps a retry finds outstanding for a thread that already exists (sticky is done by the caller). */
async function finishRotation(
  ctx: JobContext,
  rotationKey: string,
  rotation: MonthlyRotation,
  subredditName: string,
  post: MonthlyPostCandidate,
): Promise<void> {
  await setSortStep(ctx, rotationKey, rotation, post)
  await sendModmailStep(ctx, rotationKey, rotation, subredditName, post)
}

async function setSortStep(
  ctx: JobContext,
  rotationKey: string,
  rotation: MonthlyRotation,
  post: Pick<CreatedMonthlyPost, 'id' | 'setSuggestedCommentSort'>,
): Promise<void> {
  if (rotation.sortSet) return
  await redditApiCall(ctx, () => post.setSuggestedCommentSort('NEW'), `set suggested sort for ${post.id}`)
  rotation.sortSet = true
  await saveRotation(ctx, rotationKey, rotation)
}

async function sendModmailStep(
  ctx: JobContext,
  rotationKey: string,
  rotation: MonthlyRotation,
  subredditName: string,
  post: Pick<CreatedMonthlyPost, 'permalink'>,
): Promise<void> {
  if (rotation.modmailSent) return
  await redditApiCall(ctx, () => ctx.reddit.modMail.createConversation({
    subredditName,
    subject: 'Monthly thread is up',
    body: `Monthly trade-confirmation thread is live: ${post.permalink}`,
    to: null,
  }), `create monthly post modmail for r/${subredditName}`)
  rotation.modmailSent = true
  await saveRotation(ctx, rotationKey, rotation)
}

async function loadRotation(ctx: JobContext, key: string): Promise<MonthlyRotation | null> {
  const raw = await ctx.redis.get(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<MonthlyRotation>
    return {
      previousId: typeof parsed.previousId === 'string' ? parsed.previousId : null,
      sortSet: parsed.sortSet === true,
      modmailSent: parsed.modmailSent === true,
    }
  } catch {
    console.warn(`Ignoring unreadable monthly rotation record ${key}`)
    return null
  }
}

async function saveRotation(ctx: JobContext, key: string, rotation: MonthlyRotation): Promise<void> {
  await ctx.redis.set(key, JSON.stringify(rotation), { expiration: expirationFromNow(MONTHLY_ROTATION_TTL_MS) })
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
    // A 400 from sticky() means the sticky slots are full, not that the post is gone. Replacing the
    // thread would split the month's confirmations across two threads, so only a post that is really
    // gone may be replaced; anything else fails loudly and the next run retries the sticky.
    if (!isGonePostError(error)) throw error
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

function isGonePostError(error: unknown): boolean {
  const text = errorText(error)
  // A 400 is never "gone", whatever the message says about removed or deleted posts: it is what a
  // full sticky slot returns, and replacing the thread then would split the month in two.
  if (/\b400\b/.test(text)) return false
  return /\b404\b/.test(text) || /not found|deleted|removed/i.test(text)
}

function monthlyPostClaimKey(subredditName: string, when: Date): string {
  return `monthlyPostClaim:${subredditName.toLowerCase()}:${monthlyPostMonthKey(when)}`
}

function monthlyRotationKey(subredditName: string, when: Date): string {
  return `monthlyRotation:${subredditName.toLowerCase()}:${monthlyPostMonthKey(when)}`
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
