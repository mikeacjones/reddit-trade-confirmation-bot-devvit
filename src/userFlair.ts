import { expirationFrom, type Clock } from './clock.js'
import { tradeFlairText } from './settings.js'

const FLAIR_LOCK_TTL_MS = 30_000

export interface UserFlairLockContext {
  redis: {
    set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<unknown>
    del(...keys: string[]): Promise<unknown>
  }
}

export function formatTradeFlair(count: number, label?: string): string {
  return tradeFlairText(count, label)
}

export async function withUserFlairLock<T>(
  ctx: UserFlairLockContext,
  subredditName: string,
  username: string,
  clock: Clock,
  run: () => Promise<T>,
): Promise<T> {
  const key = userFlairLockKey(subredditName, username)
  const claimed = await ctx.redis.set(key, String(clock.now().getTime()), {
    nx: true,
    expiration: expirationFrom(clock.now(), FLAIR_LOCK_TTL_MS),
  })
  if (!claimed) throw new Error(`Could not acquire flair lock for ${username}`)

  try {
    return await run()
  } finally {
    await ctx.redis.del(key)
  }
}

function userFlairLockKey(subredditName: string, username: string): string {
  return `userFlairLock:${subredditName.toLowerCase()}:${username.toLowerCase()}`
}
