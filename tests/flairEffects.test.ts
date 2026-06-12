import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import { applyFlairEffect } from '../src/flairEffects.js'
import type { ConfirmationClaimRecord } from '../src/confirmationState.js'

function fixedClock(value = '2026-06-11T12:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

function claim(): ConfirmationClaimRecord {
  return {
    commentId: 't1_confirm',
    replyToCommentId: 't1_confirm',
    parentCommentId: 't1_parent',
    subredditName: 'PlasticModelExchange',
    parentAuthor: 'seller',
    confirmer: 'buyer',
    modApproval: false,
    postId: 't3_post',
    parentPreviousCount: 4,
    parentCount: 5,
    confirmerPreviousCount: 2,
    confirmerCount: 3,
    effects: {
      parentFlair: { status: 'pending' },
      confirmerFlair: { status: 'pending' },
      reply: { status: 'pending' },
    },
    createdAt: '2026-06-11T11:59:00.000Z',
    updatedAt: '2026-06-11T11:59:00.000Z',
  }
}

function mockContext(record = claim(), initial: Record<string, string> = {}) {
  const store = new Map<string, string>([
    ['confirmed:t1_parent', JSON.stringify(record)],
    ['confirmations:seller', '5'],
    ...Object.entries(initial),
  ])
  const redis = {
    get: vi.fn(async (key: string) => store.get(key)),
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
  return { ctx: { redis, reddit }, store, reddit, redis }
}

describe('applyFlairEffect', () => {
  it('writes flair with the configured flair count label', async () => {
    const record = claim()
    const { ctx, reddit } = mockContext(record)
    const getSetting = vi.fn(async (name: string) =>
      name === 'flair_count_label' ? 'Deals:' : undefined)
    const settings = {
      get: async <T,>(name: string): Promise<T | undefined> =>
        getSetting(name) as Promise<T | undefined>,
    }

    const result = await applyFlairEffect({ ...ctx, settings }, record, 'parentFlair', fixedClock())

    expect(result.status).toBe('applied')
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      text: 'Deals: 5',
    })
  })

  it('writes parent flair and marks the effect applied when Redis matches the committed count', async () => {
    const record = claim()
    const { ctx, store, reddit } = mockContext(record)

    const result = await applyFlairEffect(ctx, record, 'parentFlair', fixedClock())

    expect(result.status).toBe('applied')
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      text: 'Trades: 5',
    })
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      effects: expect.objectContaining({
        parentFlair: { status: 'applied', at: '2026-06-11T12:00:00.000Z' },
      }),
      updatedAt: '2026-06-11T12:00:00.000Z',
    }))
  })

  it('locks the user while writing flair and releases the lock after', async () => {
    const record = claim()
    const { ctx, store, reddit, redis } = mockContext(record)

    await applyFlairEffect(ctx, record, 'parentFlair', fixedClock())

    expect(redis.set).toHaveBeenCalledWith(
      'userFlairLock:plasticmodelexchange:seller',
      expect.any(String),
      expect.objectContaining({ nx: true, expiration: new Date('2026-06-11T12:00:30.000Z') }),
    )
    expect(callOrder(redis.set, args => args[0] === 'userFlairLock:plasticmodelexchange:seller'))
      .toBeLessThan(callOrder(reddit.setUserFlair))
    expect(callOrder(reddit.setUserFlair))
      .toBeLessThan(callOrder(redis.del, args => args[0] === 'userFlairLock:plasticmodelexchange:seller'))
    expect(store.get('userFlairLock:plasticmodelexchange:seller')).toBeUndefined()
  })

  it('returns without reading count or writing flair when the effect is already applied', async () => {
    const base = claim()
    const record: ConfirmationClaimRecord = {
      ...base,
      effects: {
        ...base.effects,
        parentFlair: { status: 'applied', at: '2026-06-11T11:59:30.000Z' },
      },
    }
    const { ctx, reddit, redis } = mockContext(record)

    const result = await applyFlairEffect(ctx, record, 'parentFlair', fixedClock())

    expect(result).toEqual({ status: 'applied', at: '2026-06-11T11:59:30.000Z' })
    expect(redis.get).not.toHaveBeenCalledWith('confirmations:seller')
    expect(redis.set).not.toHaveBeenCalledWith(
      'userFlairLock:plasticmodelexchange:seller',
      expect.any(String),
      expect.anything(),
    )
    expect(reddit.setUserFlair).not.toHaveBeenCalled()
  })

  it('marks the effect failed and does not write when the flair lock is held', async () => {
    const record = claim()
    const { ctx, store, reddit } = mockContext(record, {
      'userFlairLock:plasticmodelexchange:seller': 'busy',
    })

    await expect(applyFlairEffect(ctx, record, 'parentFlair', fixedClock()))
      .rejects.toThrow('Could not acquire flair lock for seller')

    expect(reddit.setUserFlair).not.toHaveBeenCalled()
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      effects: expect.objectContaining({
        parentFlair: {
          status: 'failed',
          at: '2026-06-11T12:00:00.000Z',
          error: 'Could not acquire flair lock for seller',
          attempts: 1,
        },
      }),
    }))
  })

  it('marks parent flair superseded and does not write when Redis has a newer count', async () => {
    const record = claim()
    const { ctx, store, reddit } = mockContext(record, {
      'confirmations:seller': '6',
    })

    const result = await applyFlairEffect(ctx, record, 'parentFlair', fixedClock())

    expect(result).toEqual({
      status: 'superseded',
      at: '2026-06-11T12:00:00.000Z',
      currentCount: 6,
    })
    expect(reddit.setUserFlair).not.toHaveBeenCalled()
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      effects: expect.objectContaining({
        parentFlair: {
          status: 'superseded',
          at: '2026-06-11T12:00:00.000Z',
          currentCount: 6,
        },
      }),
    }))
  })

  it('marks parent flair failed and does not write when Redis is behind the committed count', async () => {
    const record = claim()
    const { ctx, store, reddit } = mockContext(record, {
      'confirmations:seller': '4',
    })

    await expect(applyFlairEffect(ctx, record, 'parentFlair', fixedClock()))
      .rejects.toThrow('Redis count for seller is behind committed count')

    expect(reddit.setUserFlair).not.toHaveBeenCalled()
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      effects: expect.objectContaining({
        parentFlair: {
          status: 'failed',
          at: '2026-06-11T12:00:00.000Z',
          error: 'Redis count for seller is behind committed count',
          attempts: 1,
        },
      }),
    }))
  })

  it('increments failed effect attempts across retries', async () => {
    const base = claim()
    const record: ConfirmationClaimRecord = {
      ...base,
      effects: {
        ...base.effects,
        parentFlair: {
          status: 'failed',
          at: '2026-06-11T11:59:30.000Z',
          error: 'previous failure',
          attempts: 2,
        },
      },
    }
    const { ctx, store } = mockContext(record, {
      'confirmations:seller': '4',
    })

    await expect(applyFlairEffect(ctx, record, 'parentFlair', fixedClock()))
      .rejects.toThrow('Redis count for seller is behind committed count')

    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      effects: expect.objectContaining({
        parentFlair: expect.objectContaining({
          status: 'failed',
          attempts: 3,
        }),
      }),
    }))
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
