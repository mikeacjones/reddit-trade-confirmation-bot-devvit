import { afterEach, describe, expect, it, vi } from 'vitest'
import { redditApiCall, trySubmitCommentWithRetry, tryRedditWriteWithRetry } from '../src/redditApi'

function mockRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    api: {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
        if (options?.nx && store.has(key)) return false
        store.set(key, value)
        return true
      }),
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('redditApiCall', () => {
  it('returns the result without retrying when the call succeeds', async () => {
    const redis = mockRedis()
    const fn = vi.fn(async () => 'ok')

    const result = await redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('rethrows non-rate-limit errors immediately', async () => {
    const redis = mockRedis()
    const fn = vi.fn(async () => {
      throw new Error('http status 500 Internal Server Error')
    })

    await expect(redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')).rejects.toThrow('500')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries after a ratelimit error with explicit retry-after text', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'))
    const redis = mockRedis()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ratelimit reached, retry-after: 3'))
      .mockResolvedValueOnce('ok')

    const pending = redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')
    const settled = pending.catch(error => error)
    await vi.advanceTimersByTimeAsync(7_000)
    const result = await settled

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('uses the minutes wording for longer Reddit cool-downs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'))
    const redis = mockRedis()
    const fn = vi.fn(async () => {
      throw new Error('ratelimit; please take a break for 1 minutes')
    })

    const settled = redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op').catch(error => error)
    await vi.advanceTimersByTimeAsync(70_000)
    const result = await settled

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('Reddit API backoff active')
  })

  it('treats a generic ratelimit message with the fallback delay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'))
    const redis = mockRedis()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('Ratelimit (no other hints)'))
      .mockResolvedValueOnce('ok')

    const settled = redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await settled).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('reads retry-after from gRPC-style metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'))
    const redis = mockRedis()
    const error: any = new Error('rpc error')
    error.metadata = {
      get: (key: string) => (key === 'retry-after' ? ['2'] : []),
    }
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok')

    const settled = redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await settled).toBe('ok')
  })

  it('reads x-ratelimit-reset only when remaining is zero', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'))
    const redis = mockRedis()
    const buildError = () => {
      const error: any = new Error('rpc error')
      error.metadata = {
        internalRepr: new Map<string, unknown>([
          ['x-ratelimit-remaining', ['0']],
          ['x-ratelimit-reset', ['4']],
        ]),
      }
      return error
    }
    const fn = vi.fn()
      .mockRejectedValueOnce(buildError())
      .mockResolvedValueOnce('ok')

    const settled = redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await settled).toBe('ok')
  })

  it('walks the error cause chain to find rate-limit metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'))
    const redis = mockRedis()
    const inner: any = new Error('cause')
    inner.metadata = { get: (key: string) => (key === 'retry-after' ? '1' : null) }
    const outer: any = new Error('outer')
    outer.cause = inner
    const fn = vi.fn()
      .mockRejectedValueOnce(outer)
      .mockResolvedValueOnce('ok')

    const settled = redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await settled).toBe('ok')
  })

  it('rethrows after exhausting the retry budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'))
    const redis = mockRedis()
    const fn = vi.fn(async () => {
      throw new Error('ratelimit, retry-after: 1')
    })

    const settled = redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op').catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await settled

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('ratelimit')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('ignores a stale backoff key whose value is not a finite number', async () => {
    const redis = mockRedis({ 'reddit:api-backoff-until': 'garbage' })
    const fn = vi.fn(async () => 'ok')

    expect(await redditApiCall({ redis: redis.api, reddit: {} } as any, fn, 'op')).toBe('ok')
  })
})

describe('tryRedditWriteWithRetry', () => {
  it('returns true on success', async () => {
    const redis = mockRedis()
    expect(
      await tryRedditWriteWithRetry({ redis: redis.api, reddit: {} } as any, async () => undefined, 'op'),
    ).toBe(true)
  })

  it('returns false instead of throwing on failure', async () => {
    const redis = mockRedis()
    const result = await tryRedditWriteWithRetry(
      { redis: redis.api, reddit: {} } as any,
      async () => {
        throw new Error('http status 500 Server Error')
      },
      'op',
    )
    expect(result).toBe(false)
  })
})

describe('trySubmitCommentWithRetry', () => {
  it('claims a submit slot and posts the comment', async () => {
    const redis = mockRedis()
    const submitComment = vi.fn(async () => undefined)
    const ctx = {
      redis: redis.api,
      reddit: { submitComment },
    } as any

    const result = await trySubmitCommentWithRetry(ctx, 't1_abc', 'hello')

    expect(result).toBe(true)
    expect(submitComment).toHaveBeenCalledWith({ id: 't1_abc', text: 'hello' })
    expect(redis.store.has('reddit:comment-submit-slot')).toBe(true)
  })

  it('returns false when Reddit refuses the comment with a non-retriable error', async () => {
    const redis = mockRedis()
    const ctx = {
      redis: redis.api,
      reddit: {
        submitComment: vi.fn(async () => {
          throw new Error('http status 403 Forbidden')
        }),
      },
    } as any

    const result = await trySubmitCommentWithRetry(ctx, 't1_abc', 'hello')

    expect(result).toBe(false)
  })
})
