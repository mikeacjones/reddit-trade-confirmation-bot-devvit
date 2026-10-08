import type { ModAction } from '@devvit/protos'
import type { TriggerContext } from '@devvit/public-api'
import { redditApiCall, type RedditApiContext } from './redditApi.js'
import { expirationFromNow } from './utils.js'

const MODERATOR_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const MODERATOR_CACHE_KEY = 'moderators'
const MODERATOR_MEMBERSHIP_ACTIONS = new Set([
  'addmoderator',
  'acceptmoderatorinvite',
  'removemoderator',
  'setpermissions',
  'reordermoderators',
])

type ModeratorCacheContext = RedditApiContext

interface CachedModeratorList {
  usernames: string[]
  syncedAt: string
}

export async function onModAction(event: ModAction, ctx: TriggerContext): Promise<void> {
  if (!event.action || !MODERATOR_MEMBERSHIP_ACTIONS.has(event.action)) return
  const subredditName = event.subreddit?.name ||
    (await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')).name
  await refreshModeratorCache(ctx, subredditName)
}

export async function isUserModerator(ctx: RedditApiContext, subredditName: string, username: string): Promise<boolean> {
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
