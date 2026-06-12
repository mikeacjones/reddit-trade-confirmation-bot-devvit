import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import {
  commitConfirmationClaim,
  updateConfirmationEffect,
} from '../src/confirmationState.js'

function fixedClock(value = '2026-06-11T12:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

function mockContext(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const queuedSets: Array<{ key: string; value: string; options?: { nx?: boolean } }> = []
  const txn = {
    multi: vi.fn(async () => undefined),
    set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
      queuedSets.push({ key, value, options })
      return 'QUEUED'
    }),
    exec: vi.fn(async () => {
      for (const set of queuedSets) {
        if (set.options?.nx && store.has(set.key)) return [null]
        store.set(set.key, set.value)
      }
      return queuedSets.map(() => 'OK')
    }),
    unwatch: vi.fn(async () => undefined),
  }
  const redis = {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
      if (options?.nx && store.has(key)) return ''
      store.set(key, value)
      return 'OK'
    }),
    watch: vi.fn(async () => txn),
  }
  const getUserFlairBySubreddit = vi.fn(async () => ({ flairText: 'Trades: 7' }))
  const reddit = {
    getUserByUsername: vi.fn(async () => ({ getUserFlairBySubreddit })),
  }
  return { ctx: { redis, reddit }, store, redis, txn, reddit, getUserFlairBySubreddit }
}

describe('commitConfirmationClaim', () => {
  it('claims the confirmation and increments both users from Redis counts', async () => {
    const { ctx, store, redis, txn } = mockContext({
      'confirmations:seller': '4',
      'confirmations:buyer': '2',
    })

    const result = await commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())

    expect(result.committed).toBe(true)
    if (!result.committed) throw new Error('Expected confirmation to commit')
    expect(result.record).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      parentPreviousCount: 4,
      parentCount: 5,
      confirmerPreviousCount: 2,
      confirmerCount: 3,
      effects: {
        parentFlair: { status: 'pending' },
        confirmerFlair: { status: 'pending' },
        reply: { status: 'pending' },
      },
    }))
    expect(redis.watch).toHaveBeenCalledWith(
      'confirmed:t1_parent',
      'confirmations:seller',
      'confirmations:buyer',
    )
    expect(txn.multi).toHaveBeenCalledOnce()
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(result.record)
    expect(store.get('confirmations:seller')).toBe('5')
    expect(store.get('confirmations:buyer')).toBe('3')
  })

  it('replays an existing claim from the same triggering comment', async () => {
    const existingRecord = {
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
    const { ctx, redis, txn } = mockContext({
      'confirmed:t1_parent': JSON.stringify(existingRecord),
      'confirmations:seller': '5',
      'confirmations:buyer': '3',
    })

    const result = await commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())

    expect(result).toEqual({ committed: true, record: existingRecord })
    expect(redis.watch).not.toHaveBeenCalled()
    expect(txn.unwatch).not.toHaveBeenCalled()
    expect(txn.multi).not.toHaveBeenCalled()
  })

  it('replays an existing claim without bootstrapping missing user counts', async () => {
    const existingRecord = {
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
    const { ctx, reddit, txn } = mockContext({
      'confirmed:t1_parent': JSON.stringify(existingRecord),
    })

    const result = await commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())

    expect(result).toEqual({ committed: true, record: existingRecord })
    expect(reddit.getUserByUsername).not.toHaveBeenCalled()
    expect(txn.multi).not.toHaveBeenCalled()
  })

  it('treats a compact confirmed marker as an already-claimed trade', async () => {
    const { ctx, reddit, txn } = mockContext({
      'confirmed:t1_parent': JSON.stringify({
        commentId: 't1_earlier_confirm',
        parentCommentId: 't1_parent',
        confirmedAt: '2026-06-11T11:59:00.000Z',
      }),
      'confirmations:seller': '5',
      'confirmations:buyer': '3',
    })

    const result = await commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())

    expect(result).toEqual({ committed: false, reason: 'already_claimed' })
    expect(reddit.getUserByUsername).not.toHaveBeenCalled()
    expect(txn.multi).not.toHaveBeenCalled()
  })

  it('pulls in a missing user count from Reddit flair before committing', async () => {
    const { ctx, store, reddit, getUserFlairBySubreddit } = mockContext({
      'confirmations:buyer': '2',
    })

    const result = await commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())

    expect(result.committed).toBe(true)
    if (!result.committed) throw new Error('Expected confirmation to commit')
    expect(result.record).toEqual(expect.objectContaining({
      parentPreviousCount: 7,
      parentCount: 8,
      confirmerPreviousCount: 2,
      confirmerCount: 3,
    }))
    expect(reddit.getUserByUsername).toHaveBeenCalledWith('seller')
    expect(getUserFlairBySubreddit).toHaveBeenCalledWith('PlasticModelExchange')
    expect(store.get('confirmations:seller')).toBe('8')
  })

  it('commits from zero when a missing user has no parseable flair count', async () => {
    const { ctx, store, getUserFlairBySubreddit } = mockContext({
      'confirmations:buyer': '2',
    })
    getUserFlairBySubreddit.mockResolvedValueOnce({ flairText: 'No trade flair' })

    const result = await commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())

    expect(result.committed).toBe(true)
    if (!result.committed) throw new Error('Expected confirmation to commit')
    expect(result.record).toEqual(expect.objectContaining({
      parentPreviousCount: 0,
      parentCount: 1,
      confirmerPreviousCount: 2,
      confirmerCount: 3,
    }))
    expect(store.get('confirmations:seller')).toBe('1')
  })

  it('does not read flair or commit when another bootstrap owns the missing user', async () => {
    const { ctx, store, redis, txn, reddit } = mockContext({
      'confirmations:buyer': '2',
      'userBootstrap:plasticmodelexchange:seller': 'busy',
    })

    await expect(commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())).rejects.toThrow('Could not acquire bootstrap lock for seller')

    expect(reddit.getUserByUsername).not.toHaveBeenCalled()
    expect(redis.watch).not.toHaveBeenCalled()
    expect(txn.multi).not.toHaveBeenCalled()
    expect(store.get('confirmed:t1_parent')).toBeUndefined()
    expect(store.get('confirmations:seller')).toBeUndefined()
  })

  it('fails as retryable work when the Redis transaction aborts', async () => {
    const { ctx, txn } = mockContext({
      'confirmations:seller': '4',
      'confirmations:buyer': '2',
    })
    txn.exec.mockResolvedValueOnce(null as any)

    await expect(commitConfirmationClaim(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      subredditName: 'PlasticModelExchange',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    }, fixedClock())).rejects.toThrow('Redis transaction aborted')
  })
})

describe('updateConfirmationEffect', () => {
  it('updates one effect on the existing confirmation claim', async () => {
    const existingRecord = {
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
    const { ctx, store } = mockContext({
      'confirmed:t1_parent': JSON.stringify(existingRecord),
    })

    const updated = await updateConfirmationEffect(ctx, 't1_parent', 'parentFlair', {
      status: 'applied',
      at: '2026-06-11T12:00:00.000Z',
    }, fixedClock())

    expect(updated).toEqual(expect.objectContaining({
      effects: {
        parentFlair: { status: 'applied', at: '2026-06-11T12:00:00.000Z' },
        confirmerFlair: { status: 'pending' },
        reply: { status: 'pending' },
      },
      updatedAt: '2026-06-11T12:00:00.000Z',
    }))
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(updated)
  })
})
