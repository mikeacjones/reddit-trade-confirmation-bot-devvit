import type { TriggerContext } from '@devvit/public-api'
import { errorText, expirationFromNow, sleep } from './utils.js'

type RedisContext = Pick<TriggerContext, 'redis'>

const USER_FLAIR_CACHE_TTL_MS = 60 * 1000
const USER_FLAIR_LOCK_TTL_MS = 30 * 1000
const USER_FLAIR_LOCK_ATTEMPTS = 12
const USER_FLAIR_LOCK_RETRY_MS = 500

export interface CachedUserFlair {
  text: string
  count: number
  setAt: string
}

export async function getCachedUserFlair(
  ctx: RedisContext,
  subredditName: string,
  username: string,
): Promise<string | null> {
  return (await getCachedUserFlairRecord(ctx, subredditName, username))?.text ?? null
}

export async function getCachedUserFlairRecord(
  ctx: RedisContext,
  subredditName: string,
  username: string,
): Promise<CachedUserFlair | null> {
  const value = await ctx.redis.get(userFlairCacheKey(subredditName, username))
  if (!value) return null

  return parseCachedUserFlair(value)
}

export async function cacheUserFlair(
  ctx: RedisContext,
  subredditName: string,
  username: string,
  text: string,
  count: number,
): Promise<void> {
  try {
    await ctx.redis.set(
      userFlairCacheKey(subredditName, username),
      JSON.stringify({ text, count, setAt: new Date().toISOString() } satisfies CachedUserFlair),
      { expiration: expirationFromNow(USER_FLAIR_CACHE_TTL_MS) },
    )
  } catch (error) {
    console.warn(`Failed to cache flair for u/${username}: ${errorText(error)}`)
  }
}

export async function withUserFlairLock<T>(
  ctx: RedisContext,
  subredditName: string,
  username: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = userFlairLockKey(subredditName, username)
  const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`

  for (let attempt = 0; attempt < USER_FLAIR_LOCK_ATTEMPTS; attempt++) {
    const claimed = await ctx.redis.set(key, token, {
      nx: true,
      expiration: expirationFromNow(USER_FLAIR_LOCK_TTL_MS),
    })
    if (claimed) {
      try {
        return await fn()
      } finally {
        await releaseUserFlairLock(ctx, key, token)
      }
    }

    await sleep(USER_FLAIR_LOCK_RETRY_MS + lockJitterMs())
  }

  throw new Error(`Timed out waiting for flair lock for u/${username}`)
}

function userFlairCacheKey(subredditName: string, username: string): string {
  return `userFlair:${subredditName.toLowerCase()}:${username.toLowerCase()}`
}

function userFlairLockKey(subredditName: string, username: string): string {
  return `userFlairLock:${subredditName.toLowerCase()}:${username.toLowerCase()}`
}

function parseCachedUserFlair(value: string): CachedUserFlair | null {
  try {
    const cached = JSON.parse(value) as Partial<CachedUserFlair>
    if (typeof cached.text !== 'string') return null
    if (typeof cached.count !== 'number' || !Number.isFinite(cached.count)) return null
    if (typeof cached.setAt !== 'string') return null
    return {
      text: cached.text,
      count: cached.count,
      setAt: cached.setAt,
    }
  } catch {
    return null
  }
}

async function releaseUserFlairLock(ctx: RedisContext, key: string, token: string): Promise<void> {
  try {
    if (await ctx.redis.get(key) === token) await ctx.redis.del(key)
  } catch (error) {
    console.warn(`Failed to release ${key}: ${errorText(error)}`)
  }
}

function lockJitterMs(): number {
  return Math.floor(Math.random() * 100)
}
