/**
 * Adversarial audit of the Reddit API wrapper (src/redditApi.ts): which errors are retried, which
 * are not, how long it waits, and that a write is never repeated in a way that double-posts.
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is an
 * `it.fails` repro with a `// BUG:` comment: it stays green now and turns red once the bug is
 * fixed, then drops `.fails`. This audit does not fix src/.
 *
 * Time is faked; the Redis double ignores expirations, so a key stays until the test removes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redditApiCall, submitCommentWithRetry, trySubmitCommentWithRetry } from '../src/redditApi'

const BACKOFF_KEY = 'reddit:api-backoff-until'
const NOW = new Date('2026-05-08T00:00:00.000Z')

function mockRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    api: {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
        if (options?.nx && store.has(key)) return null
        store.set(key, value)
        return 'OK'
      }),
    },
  }
}

function ctxFor(redis: ReturnType<typeof mockRedis>, reddit: unknown = {}) {
  return { redis: redis.api, reddit, settings: {} } as any
}

/** A gRPC-style error carrying response headers the way the Devvit runtime reports them. */
function withMetadata(message: string, headers: Record<string, string>): Error {
  const error = new Error(message) as Error & { metadata: { get(key: string): unknown } }
  error.metadata = { get: key => headers[key] }
  return error
}

/** Runs `start` and plays the fake clock forward until it settles. */
async function settle<T>(start: () => Promise<T>, ms = 120_000): Promise<{ value?: T; error?: unknown }> {
  const outcome = start().then(value => ({ value }), (error: unknown) => ({ error }))
  await vi.advanceTimersByTimeAsync(ms)
  return outcome
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('redditApiCall: errors that are never retried', () => {
  it.each([
    ['400 bad request', new Error('http status 400 Bad Request')],
    ['403 forbidden', new Error('403 Forbidden: this user is banned')],
    ['404 not found', new Error('404 comment t1_x not found')],
    ['500 server error', new Error('http status 500 Internal Server Error')],
    ['503 unavailable', new Error('503 Service Unavailable')],
    ['connection reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['timeout', new Error('DEADLINE_EXCEEDED: request timed out')],
  ])('calls once and rethrows the same error for %s', async (_name, error) => {
    const redis = mockRedis()
    const fn = vi.fn(async () => { throw error })

    const { error: thrown } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(thrown).toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(redis.store.has(BACKOFF_KEY)).toBe(false)
  })

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('rethrows a thrown %s unchanged, without retrying', async (_name, value) => {
    const redis = mockRedis()
    const fn = vi.fn(async () => { throw value })

    const { error } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(error).toBe(value)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not match "ratelimit" in the description of the call, only in the error', async () => {
    const redis = mockRedis()
    const fn = vi.fn(async () => { throw new Error('404 not found') })

    await settle(() => redditApiCall(ctxFor(redis), fn, 'check ratelimit status'))

    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('redditApiCall: rate limits', () => {
  it('retries an upper-case RATELIMIT text, and a thrown string, once each and returns the result', async () => {
    for (const first of [new Error('RATELIMIT: you are doing that too much'), 'RATELIMIT: slow down']) {
      const redis = mockRedis()
      const fn = vi.fn().mockRejectedValueOnce(first).mockResolvedValueOnce('ok')

      const { value } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

      expect(value).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    }
  })

  it('waits at least the 6 second floor even when retry-after metadata says 0, 1 or a negative number', async () => {
    for (const retryAfter of ['0', '1', '-5']) {
      const redis = mockRedis()
      const fn = vi.fn()
        .mockRejectedValueOnce(withMetadata('too many requests', { 'retry-after': retryAfter }))
        .mockResolvedValueOnce('ok')
      const started = Date.now()

      const pending = redditApiCall(ctxFor(redis), fn, 'op')
      await vi.advanceTimersByTimeAsync(5_900)
      expect(fn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(await pending).toBe('ok')
      expect(Date.now() - started).toBeGreaterThanOrEqual(6_000)
    }
  })

  it('gives up after three attempts and rethrows the last rate-limit error', async () => {
    const redis = mockRedis()
    const errors = [1, 2, 3].map(n => new Error(`ratelimit reached #${n}`))
    const fn = vi.fn()
    errors.forEach(error => fn.mockRejectedValueOnce(error))

    const { error } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(fn).toHaveBeenCalledTimes(3)
    expect(error).toBe(errors[2])
  })

  it('a rate limit followed by a permanent error stops retrying at the permanent error', async () => {
    const redis = mockRedis()
    const permanent = new Error('403 Forbidden')
    const fn = vi.fn().mockRejectedValueOnce(new Error('ratelimit')).mockRejectedValueOnce(permanent)

    const { error } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(error).toBe(permanent)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('a "take a break for N minutes" limit is not slept through: the retry is refused and the call is not repeated', async () => {
    const redis = mockRedis()
    const fn = vi.fn().mockRejectedValueOnce(new Error('RATELIMIT: take a break for 2 minutes before trying again'))

    const { error } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(String(error)).toMatch(/backoff active/)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(parseInt(redis.store.get(BACKOFF_KEY)!, 10)).toBeGreaterThanOrEqual(NOW.getTime() + 120_000)
  })

  it('while a long backoff is recorded, later calls are refused without calling Reddit at all', async () => {
    const redis = mockRedis({ [BACKOFF_KEY]: String(NOW.getTime() + 5 * 60_000) })
    const fn = vi.fn(async () => 'ok')

    const { error } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(String(error)).toMatch(/backoff active/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('a short recorded backoff is waited out before the call, once', async () => {
    const redis = mockRedis({ [BACKOFF_KEY]: String(NOW.getTime() + 4_000) })
    const fn = vi.fn(async () => 'ok')

    const pending = redditApiCall(ctxFor(redis), fn, 'op')
    await vi.advanceTimersByTimeAsync(3_900)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)

    expect(await pending).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('treats an expired or unreadable backoff value as no backoff', async () => {
    for (const value of ['0', '', 'soon', String(NOW.getTime() - 1)]) {
      const redis = mockRedis({ [BACKOFF_KEY]: value })
      const fn = vi.fn(async () => 'ok')

      const { value: result } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

      expect(result).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })

  // BUG: a plain "429 Too Many Requests" error (no "ratelimit" text and no retry-after/x-ratelimit metadata) is treated as a permanent error and never retried, severity low
  it.fails('retries a plain 429 error that carries no ratelimit wording or headers', async () => {
    const redis = mockRedis()
    const fn = vi.fn().mockRejectedValueOnce(new Error('429 Too Many Requests')).mockResolvedValueOnce('ok')

    const { value } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(value).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  // BUG: errorText and the metadata lookup follow `cause` without a cycle guard, so an error whose cause chain loops makes redditApiCall throw a RangeError (stack overflow) instead of the original error, severity low
  it.fails('rethrows the original error when its cause chain is circular', async () => {
    const redis = mockRedis()
    const error = new Error('403 Forbidden') as Error & { cause?: unknown }
    error.cause = error
    const fn = vi.fn(async () => { throw error })

    const { error: thrown } = await settle(() => redditApiCall(ctxFor(redis), fn, 'op'))

    expect(thrown).toBe(error)
  })

  // BUG: setRedditApiBackoff overwrites the shared backoff unconditionally, so a call that was already in flight when a long cool-down was recorded shortens it to its own ~6 second limit, severity low
  it.fails('a short rate limit does not shorten a longer backoff recorded by another call', async () => {
    const redis = mockRedis()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const inFlight = vi.fn(async () => {
      await gate
      throw new Error('RATELIMIT: slow down')
    })
    const slow = redditApiCall(ctxFor(redis), inFlight, 'in flight').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    const longBackoff = NOW.getTime() + 10 * 60_000
    redis.store.set(BACKOFF_KEY, String(longBackoff))
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(parseInt(redis.store.get(BACKOFF_KEY)!, 10)).toBeGreaterThanOrEqual(longBackoff)
    await vi.advanceTimersByTimeAsync(120_000)
    await slow
  })
})

describe('submitCommentWithRetry: a reply is never posted twice', () => {
  function replyReddit(behaviour: (attempt: number, posted: string[]) => Promise<void>) {
    const posted: string[] = []
    let attempt = 0
    const reddit = {
      submitComment: vi.fn(async ({ text }: { id: string; text: string }) => {
        await behaviour(++attempt, posted)
        posted.push(text)
      }),
    }
    return { reddit, posted }
  }

  it('a rate-limited submit is retried and lands exactly once', async () => {
    const redis = mockRedis()
    const { reddit, posted } = replyReddit(async attempt => {
      // The double has no key expiry, so free the slot the way the real 6.5 second expiry would.
      redis.store.delete('reddit:comment-submit-slot')
      if (attempt === 1) throw new Error('RATELIMIT: take a break for 3 seconds')
    })

    const { error } = await settle(() => submitCommentWithRetry(ctxFor(redis, reddit), 't1_x', 'hello'))

    expect(error).toBeUndefined()
    expect(reddit.submitComment).toHaveBeenCalledTimes(2)
    expect(posted).toEqual(['hello'])
  })

  it('a submit that fails with a timeout or 5xx after Reddit may have accepted it is not repeated', async () => {
    for (const message of ['DEADLINE_EXCEEDED', '502 Bad Gateway', 'socket hang up']) {
      const redis = mockRedis()
      const { reddit, posted } = replyReddit(async (_attempt, sent) => {
        sent.push('hello') // the server took the comment, the reply to us was lost
        throw new Error(message)
      })

      const { error } = await settle(() => submitCommentWithRetry(ctxFor(redis, reddit), 't1_x', 'hello'))

      expect(String((error as Error).message)).toBe(message)
      expect(reddit.submitComment).toHaveBeenCalledTimes(1)
      expect(posted).toEqual(['hello'])
    }
  })

  it('a busy comment slot that never frees fails without posting anything', async () => {
    const redis = mockRedis({ 'reddit:comment-submit-slot': String(NOW.getTime()) })
    const { reddit } = replyReddit(async () => {})

    const { error } = await settle(() => submitCommentWithRetry(ctxFor(redis, reddit), 't1_x', 'hello'))

    expect(String((error as Error).message)).toMatch(/Timed out waiting for Reddit comment submit slot/)
    expect(reddit.submitComment).not.toHaveBeenCalled()
  })

  // BUG: trySubmitCommentWithRetry wraps submitCommentWithRetry, which already retries, in a second redditApiCall, so a persistent rate limit makes 9 submit attempts (3 x 3) instead of 3 and holds the trigger for about a minute, severity low
  it.fails('a persistent rate limit makes three submit attempts, not nine', async () => {
    const redis = mockRedis()
    const reddit = {
      submitComment: vi.fn(async () => {
        redis.store.delete('reddit:comment-submit-slot')
        throw new Error('RATELIMIT: slow down')
      }),
    }

    const { value } = await settle(() => trySubmitCommentWithRetry(ctxFor(redis, reddit), 't1_x', 'hello'), 600_000)

    expect(value).toBe(false)
    expect(reddit.submitComment).toHaveBeenCalledTimes(3)
  })
})
