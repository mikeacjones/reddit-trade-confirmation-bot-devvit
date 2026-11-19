import { vi } from 'vitest'

/**
 * Settles `pending` while vitest's fake timers are on, by alternating real event-loop turns (the
 * Redis mocks need `setImmediate`, which stays real) with small steps of the fake clock. A single
 * `advanceTimersByTimeAsync(n)` jumps the whole window before the flow under test has reached its
 * later sleeps, so a flow with two or three waits would hang; stepping lets each wait be reached
 * and then passed. Gives up after `maxMs` of fake time.
 */
export async function runWithClock<T>(pending: Promise<T>, options: { stepMs?: number; maxMs?: number } = {}): Promise<T> {
  const { stepMs = 500, maxMs = 15 * 60_000 } = options
  let done = false
  const settled = pending.finally(() => { done = true })
  settled.catch(() => undefined)
  for (let elapsed = 0; !done && elapsed <= maxMs; elapsed += stepMs) {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (done) break
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  return settled
}
