import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cacheUserFlair,
  getCachedUserFlair,
  getCachedUserFlairRecord,
  withUserFlairLock,
} from '../src/userFlairState'

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
      del: vi.fn(async (key: string) => {
        store.delete(key)
      }),
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('getCachedUserFlairRecord', () => {
  it('returns null when nothing is cached', async () => {
    const redis = mockRedis()
    const result = await getCachedUserFlairRecord({ redis: redis.api } as any, 'PlasticModelExchange', 'alice')
    expect(result).toBeNull()
  })

  it('returns null when the cached JSON is malformed', async () => {
    const redis = mockRedis({
      'userFlair:plasticmodelexchange:alice': 'not json',
    })
    const result = await getCachedUserFlairRecord({ redis: redis.api } as any, 'PlasticModelExchange', 'alice')
    expect(result).toBeNull()
  })

  it('returns null when cached fields have wrong types', async () => {
    const cases = [
      { text: 5, count: 1, setAt: 'x' },
      { text: 'a', count: 'one', setAt: 'x' },
      { text: 'a', count: 1, setAt: 0 },
      { text: 'a', count: Number.NaN, setAt: 'x' },
    ]
    for (const cached of cases) {
      const redis = mockRedis({
        'userFlair:plasticmodelexchange:alice': JSON.stringify(cached),
      })
      const result = await getCachedUserFlairRecord(
        { redis: redis.api } as any,
        'PlasticModelExchange',
        'alice',
      )
      expect(result).toBeNull()
    }
  })

  it('returns the parsed record when all fields are valid', async () => {
    const redis = mockRedis({
      'userFlair:plasticmodelexchange:alice': JSON.stringify({
        text: 'Trades: 5',
        count: 5,
        setAt: '2026-05-08T00:00:00.000Z',
      }),
    })

    const result = await getCachedUserFlairRecord({ redis: redis.api } as any, 'PlasticModelExchange', 'Alice')

    expect(result).toEqual({
      text: 'Trades: 5',
      count: 5,
      setAt: '2026-05-08T00:00:00.000Z',
    })
  })
})

describe('getCachedUserFlair', () => {
  it('returns only the flair text from a valid record', async () => {
    const redis = mockRedis({
      'userFlair:plasticmodelexchange:alice': JSON.stringify({
        text: 'Trades: 5',
        count: 5,
        setAt: '2026-05-08T00:00:00.000Z',
      }),
    })

    expect(await getCachedUserFlair({ redis: redis.api } as any, 'PlasticModelExchange', 'alice')).toBe('Trades: 5')
  })

  it('returns null when nothing is cached', async () => {
    const redis = mockRedis()
    expect(await getCachedUserFlair({ redis: redis.api } as any, 'PlasticModelExchange', 'alice')).toBeNull()
  })
})

describe('cacheUserFlair', () => {
  it('writes the cached record with a TTL', async () => {
    const redis = mockRedis()
    await cacheUserFlair({ redis: redis.api } as any, 'PlasticModelExchange', 'Alice', 'Trades: 5', 5)
    const stored = JSON.parse(redis.store.get('userFlair:plasticmodelexchange:alice') ?? '{}')
    expect(stored).toEqual(expect.objectContaining({ text: 'Trades: 5', count: 5 }))
    expect(redis.api.set).toHaveBeenCalledWith(
      'userFlair:plasticmodelexchange:alice',
      expect.any(String),
      expect.objectContaining({ expiration: expect.any(Date) }),
    )
  })

  it('swallows redis errors so the caller is not broken by cache writes', async () => {
    const redis = mockRedis()
    redis.api.set.mockRejectedValueOnce(new Error('redis down'))
    await expect(
      cacheUserFlair({ redis: redis.api } as any, 'PlasticModelExchange', 'alice', 'Trades: 5', 5),
    ).resolves.toBeUndefined()
  })
})

describe('withUserFlairLock', () => {
  it('claims the lock, runs the callback, and releases the lock', async () => {
    const redis = mockRedis()
    const fn = vi.fn(async () => 'ok')

    const result = await withUserFlairLock({ redis: redis.api } as any, 'PlasticModelExchange', 'alice', fn)

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
    expect(redis.store.has('userFlairLock:plasticmodelexchange:alice')).toBe(false)
  })

  it('releases the lock even when the callback throws', async () => {
    const redis = mockRedis()

    await expect(
      withUserFlairLock({ redis: redis.api } as any, 'PlasticModelExchange', 'alice', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(redis.store.has('userFlairLock:plasticmodelexchange:alice')).toBe(false)
  })

  it('does not delete a lock token that no longer matches', async () => {
    const redis = mockRedis()
    const fn = vi.fn(async () => {
      redis.store.set('userFlairLock:plasticmodelexchange:alice', 'stolen-by-someone-else')
    })

    await withUserFlairLock({ redis: redis.api } as any, 'PlasticModelExchange', 'alice', fn)

    expect(redis.store.get('userFlairLock:plasticmodelexchange:alice')).toBe('stolen-by-someone-else')
  })

  it('times out when the lock cannot be acquired', async () => {
    vi.useFakeTimers()
    const redis = mockRedis({
      'userFlairLock:plasticmodelexchange:alice': 'held-by-another',
    })
    const fn = vi.fn()

    const pending = withUserFlairLock(
      { redis: redis.api } as any,
      'PlasticModelExchange',
      'alice',
      fn,
    )
    const settled = pending.catch(error => error)

    await vi.advanceTimersByTimeAsync(20_000)
    const result = await settled

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('Timed out waiting for flair lock for u/alice')
    expect(fn).not.toHaveBeenCalled()
  })
})
