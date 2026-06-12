import type { Clock } from './clock.js'
import {
  updateConfirmationEffect,
  type ConfirmationClaimRecord,
  type EffectName,
  type EffectState,
} from './confirmationState.js'
import { getAppSettings } from './settings.js'
import { formatTradeFlair, withUserFlairLock } from './userFlair.js'

interface FlairEffectContext {
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<unknown>
    del(...keys: string[]): Promise<unknown>
  }
  settings?: {
    get<T>(name: string): Promise<T | undefined>
  }
  reddit: {
    setUserFlair(options: { subredditName: string; username: string; text: string }): Promise<void>
  }
}

export async function applyFlairEffect(
  ctx: FlairEffectContext,
  record: ConfirmationClaimRecord,
  effectName: 'parentFlair' | 'confirmerFlair',
  clock: Clock,
): Promise<EffectState> {
  const existing = record.effects[effectName]
  if (existing.status === 'applied' || existing.status === 'superseded') return existing

  const target = flairTarget(record, effectName)
  const currentCount = parseStoredCount(await ctx.redis.get(countKey(target.username)))
  const at = clock.now().toISOString()

  if (currentCount > target.count) {
    const effect: EffectState = { status: 'superseded', at, currentCount }
    await updateConfirmationEffect(ctx, record.parentCommentId, effectName, effect, clock)
    return effect
  }

  if (currentCount < target.count) {
    const error = `Redis count for ${target.username} is behind committed count`
    const effect = failedEffect(record, effectName, at, error)
    await updateConfirmationEffect(ctx, record.parentCommentId, effectName, effect, clock)
    throw new Error(error)
  }

  const settings = await getAppSettings(ctx)
  return withUserFlairLock(ctx, record.subredditName, target.username, clock, async () => {
    await ctx.reddit.setUserFlair({
      subredditName: record.subredditName,
      username: target.username,
      text: formatTradeFlair(target.count, settings.flairCountLabel),
    })
    const effect: EffectState = { status: 'applied', at }
    await updateConfirmationEffect(ctx, record.parentCommentId, effectName, effect, clock)
    return effect
  }).catch(async error => {
    const message = errorMessage(error)
    const effect = failedEffect(record, effectName, at, message)
    await updateConfirmationEffect(ctx, record.parentCommentId, effectName, effect, clock)
    throw error
  })
}

function failedEffect(
  record: ConfirmationClaimRecord,
  effectName: EffectName,
  at: string,
  error: string,
): EffectState {
  const previous = record.effects[effectName]
  const attempts = previous.status === 'failed' ? previous.attempts + 1 : 1
  return { status: 'failed', at, error, attempts }
}

function flairTarget(record: ConfirmationClaimRecord, effectName: EffectName): { username: string; count: number } {
  if (effectName === 'parentFlair') return { username: record.parentAuthor, count: record.parentCount }
  if (effectName === 'confirmerFlair') return { username: record.confirmer, count: record.confirmerCount }
  throw new Error(`Unsupported flair effect ${effectName}`)
}

function countKey(username: string): string {
  return `confirmations:${username.toLowerCase()}`
}

function parseStoredCount(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
