import type { Clock } from './clock.js'
import { getAppSettings } from './settings.js'
import { formatTradeFlair, withUserFlairLock, type UserFlairLockContext } from './userFlair.js'

interface TradeAdjustmentContext extends UserFlairLockContext {
  redis: UserFlairLockContext['redis'] & {
    set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<unknown>
  }
  settings?: {
    get<T>(name: string): Promise<T | undefined>
  }
  reddit: {
    setUserFlair(options: { subredditName: string; username: string; text: string }): Promise<void>
  }
}

export interface TradeAdjustmentInput {
  subredditName: string
  username: string
  count: number
}

export async function adjustUserTradeCount(
  ctx: TradeAdjustmentContext,
  input: TradeAdjustmentInput,
  clock: Clock,
): Promise<{ username: string; count: number; flairText: string }> {
  const settings = await getAppSettings(ctx)
  const flairText = formatTradeFlair(input.count, settings.flairCountLabel)
  await withUserFlairLock(ctx, input.subredditName, input.username, clock, async () => {
    await ctx.redis.set(countKey(input.username), String(input.count))
    await ctx.reddit.setUserFlair({
      subredditName: input.subredditName,
      username: input.username,
      text: flairText,
    })
  })
  return { username: input.username, count: input.count, flairText }
}

function countKey(username: string): string {
  return `confirmations:${username.toLowerCase()}`
}
