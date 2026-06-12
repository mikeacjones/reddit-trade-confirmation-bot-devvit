import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import { adjustUserTradeCount } from '../src/tradeAdjustments.js'

function fixedClock(value = '2026-06-11T12:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

function mockContext(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const redis = {
    set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
      if (options?.nx && store.has(key)) return ''
      store.set(key, value)
      return 'OK'
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key)
    }),
  }
  const reddit = {
    setUserFlair: vi.fn(async () => undefined),
  }
  return { ctx: { redis, reddit }, store, redis, reddit }
}

describe('adjustUserTradeCount', () => {
  it('uses the configured flair count label', async () => {
    const { ctx, reddit } = mockContext()
    const getSetting = vi.fn(async (name: string) =>
      name === 'flair_count_label' ? 'Deals:' : undefined)
    const settings = {
      get: async <T,>(name: string): Promise<T | undefined> =>
        getSetting(name) as Promise<T | undefined>,
    }

    const result = await adjustUserTradeCount({ ...ctx, settings }, {
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      count: 7,
    }, fixedClock())

    expect(result).toEqual({ username: 'seller', count: 7, flairText: 'Deals: 7' })
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      text: 'Deals: 7',
    })
  })

  it('updates Redis count and writes flair for the target user', async () => {
    const { ctx, store, redis, reddit } = mockContext()

    const result = await adjustUserTradeCount(ctx, {
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      count: 7,
    }, fixedClock())

    expect(result).toEqual({ username: 'seller', count: 7, flairText: 'Trades: 7' })
    expect(redis.set).toHaveBeenCalledWith(
      'userFlairLock:plasticmodelexchange:seller',
      expect.any(String),
      expect.objectContaining({ nx: true, expiration: new Date('2026-06-11T12:00:30.000Z') }),
    )
    expect(callOrder(redis.set, args => args[0] === 'userFlairLock:plasticmodelexchange:seller'))
      .toBeLessThan(callOrder(redis.set, args => args[0] === 'confirmations:seller'))
    expect(callOrder(redis.set, args => args[0] === 'confirmations:seller'))
      .toBeLessThan(callOrder(reddit.setUserFlair))
    expect(store.get('confirmations:seller')).toBe('7')
    expect(store.get('userFlairLock:plasticmodelexchange:seller')).toBeUndefined()
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      text: 'Trades: 7',
    })
  })

  it('does not update Redis or flair when the flair lock is held', async () => {
    const { ctx, store, reddit } = mockContext({
      'userFlairLock:plasticmodelexchange:seller': 'busy',
    })

    await expect(adjustUserTradeCount(ctx, {
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      count: 7,
    }, fixedClock())).rejects.toThrow('Could not acquire flair lock for seller')

    expect(store.get('confirmations:seller')).toBeUndefined()
    expect(reddit.setUserFlair).not.toHaveBeenCalled()
  })
})

function callOrder(
  fn: { mock: { calls: any[][]; invocationCallOrder: number[] } },
  predicate: (args: any[]) => boolean = () => true,
): number {
  const index = fn.mock.calls.findIndex(predicate)
  if (index < 0) throw new Error('Expected matching mock call')
  return fn.mock.invocationCallOrder[index]
}
