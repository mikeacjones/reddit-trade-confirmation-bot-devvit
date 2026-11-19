import type { TriggerContext } from '@devvit/public-api'
import { expirationFromNow } from './utils.js'

/**
 * How long after a monthly rotation a confirmation on the previous (now locked) thread is still
 * counted. The rotation locks the old thread, and a confirmation posted just before it may not have
 * been processed yet; the hourly rescan and a late trigger delivery both get this long to finish it.
 * Past the window the old thread is rejected as before. Several rescans fit in it, so one failed
 * run does not lose a trade.
 */
export const PREVIOUS_THREAD_GRACE_MS = 6 * 60 * 60 * 1000

const PREVIOUS_THREAD_KEY = 'previousMonthlyPost'

type RedisContext = Pick<TriggerContext, 'redis'>

interface PreviousThreadRecord {
  postId: string
  until: number
}

/**
 * Remembers the thread being rotated out, with the time its grace window ends. Called before the
 * pointer moves and the thread is locked, so there is no moment where the old thread is locked and
 * unknown. The window runs from this call, so a caller passes `restart` while the thread is still
 * unlocked (a retry that locks it hours after the first attempt gets a full window) and leaves it off
 * once the thread is locked, so a repeated run does not extend a window that is already running.
 */
export async function recordPreviousMonthlyPost(
  ctx: RedisContext,
  postId: string | null,
  options: { restart: boolean },
): Promise<void> {
  if (!postId) return
  if (!options.restart && (await readRecord(ctx))?.postId === postId) return
  const record: PreviousThreadRecord = { postId, until: Date.now() + PREVIOUS_THREAD_GRACE_MS }
  await ctx.redis.set(PREVIOUS_THREAD_KEY, JSON.stringify(record), {
    expiration: expirationFromNow(PREVIOUS_THREAD_GRACE_MS * 2),
  })
}

/** The previous monthly thread while its grace window is open, otherwise null. */
export async function getGracePreviousPostId(ctx: RedisContext): Promise<string | null> {
  const record = await readRecord(ctx)
  if (!record || Date.now() >= record.until) return null
  // Before the pointer moves (a rotation that failed early) the record names the current thread.
  if (record.postId === (await ctx.redis.get('currentMonthlyPost'))) return null
  return record.postId
}

async function readRecord(ctx: RedisContext): Promise<PreviousThreadRecord | null> {
  const raw = await ctx.redis.get(PREVIOUS_THREAD_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PreviousThreadRecord>
    if (typeof parsed.postId !== 'string' || typeof parsed.until !== 'number') return null
    return { postId: parsed.postId, until: parsed.until }
  } catch {
    return null
  }
}
