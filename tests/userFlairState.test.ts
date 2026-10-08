import { afterEach, describe, expect, it, vi } from 'vitest'
import { withUserFlairLock } from '../src/userFlairState'

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
