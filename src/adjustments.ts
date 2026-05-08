import {
  findFlairTemplate,
  formatFlairFromTemplate,
} from './rules.js'
import { loadFlairTemplates, refreshFlairTemplateCache } from './flairCache.js'
import { isUserModerator } from './moderators.js'
import { redditApiCall, type RedditApiContext } from './redditApi.js'

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
