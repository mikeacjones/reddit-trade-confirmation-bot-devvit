import {
  findFlairTemplate,
  formatFlairFromTemplate,
} from './rules.js'
import { loadFlairTemplates, refreshFlairTemplateCache } from './flairCache.js'
import { setUserFlairWithFallback } from './flairAssignment.js'
import { isUserModerator } from './moderators.js'
import { redditApiCall, type RedditApiContext } from './redditApi.js'
import { cacheUserFlair, getCachedUserFlair, withUserFlairLock } from './userFlairState.js'

const REDDIT_USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/

export async function adjustUserTradeCount(
  ctx: RedditApiContext,
  rawUsername: string,
  count: number,
): Promise<{ username: string; count: number; oldFlair: string | null; newFlair: string }> {
  const username = normalizeUsername(rawUsername)
  if (!username) throw new Error('Username is required')
  if (!REDDIT_USERNAME_PATTERN.test(username)) {
    throw new Error('Username must be 3-20 characters and contain only letters, numbers, underscores, or hyphens')
  }
  if (!Number.isInteger(count) || count < 0) throw new Error('Trade count must be a non-negative whole number')

  const { name: subredditName } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
  const isMod = await isUserModerator(ctx, subredditName, username)
  let flairTemplates = await loadFlairTemplates(ctx, subredditName)
  let tpl = findFlairTemplate(flairTemplates, count, isMod)
  if (!tpl) {
    flairTemplates = await refreshFlairTemplateCache(ctx, subredditName)
    tpl = findFlairTemplate(flairTemplates, count, isMod)
  }
  if (!tpl) throw new Error(`No ${isMod ? 'moderator' : 'user'} flair template found for trade count ${count}`)

  const newFlair = formatFlairFromTemplate(tpl.template, count)
  const countKey = `confirmations:${username.toLowerCase()}`
  const previousCount = await ctx.redis.get(countKey)
  const previousStoredCount = parseStoredCount(previousCount)
  const oldTpl = previousStoredCount === null ? null : findFlairTemplate(flairTemplates, previousStoredCount, isMod)
  const cachedOldFlair = await getCachedUserFlair(ctx, subredditName, username)
  const oldFlair = cachedOldFlair ?? (oldTpl && previousStoredCount !== null
    ? formatFlairFromTemplate(oldTpl.template, previousStoredCount)
    : null)
  await ctx.redis.set(countKey, String(count))

  try {
    await withUserFlairLock(ctx, subredditName, username, async () => {
      await setUserFlairWithFallback(
        ctx,
        { subredditName, username, text: newFlair, flairTemplateId: tpl.id },
        `set manual flair for u/${username}`,
      )
      await cacheUserFlair(ctx, subredditName, username, newFlair, count)
    })
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

function parseStoredCount(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}
