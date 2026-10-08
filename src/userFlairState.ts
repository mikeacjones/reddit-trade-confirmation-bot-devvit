import type { TriggerContext } from '@devvit/public-api'
import { errorText, expirationFromNow, sleep } from './utils.js'

type RedisContext = Pick<TriggerContext, 'redis'>

const USER_FLAIR_LOCK_TTL_MS = 30 * 1000
const USER_FLAIR_LOCK_ATTEMPTS = 12
const USER_FLAIR_LOCK_RETRY_MS = 500

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

function userFlairLockKey(subredditName: string, username: string): string {
  return `userFlairLock:${subredditName.toLowerCase()}:${username.toLowerCase()}`
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
