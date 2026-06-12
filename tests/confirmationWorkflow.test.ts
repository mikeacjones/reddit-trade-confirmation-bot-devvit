import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import { processConfirmationItem } from '../src/confirmationWorkflow.js'
import type { ConfirmationWorkItem } from '../src/workQueue.js'

function fixedClock(value = '2026-06-11T12:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

const workItem: ConfirmationWorkItem = {
  workId: 'confirmation-comment:t1_confirm',
  kind: 'confirmation-comment',
  commentId: 't1_confirm',
  postId: 't3_post',
  subredditName: 'PlasticModelExchange',
  enqueuedAt: '2026-06-11T12:00:00.000Z',
  status: 'queued',
  attempts: 0,
  nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
}

function mockContext() {
  const store = new Map<string, string>([
    ['currentMonthlyPost', 't3_post'],
    ['confirmations:seller', '4'],
    ['confirmations:buyer', '2'],
  ])
  const queuedSets: Array<{ key: string; value: string; options?: { nx?: boolean } }> = []
  const txn = {
    multi: vi.fn(async () => undefined),
    set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
      queuedSets.push({ key, value, options })
      return 'QUEUED'
    }),
    exec: vi.fn(async () => {
      for (const set of queuedSets) store.set(set.key, set.value)
      return queuedSets.map(() => 'OK')
    }),
    unwatch: vi.fn(async () => undefined),
  }
  const redis = {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key)
    }),
    watch: vi.fn(async () => txn),
  }
  const reddit = {
    getCommentById: vi.fn(async (id: string) => id === 't1_confirm'
      ? {
          id: 't1_confirm',
          body: 'confirmed',
          authorName: 'buyer',
          parentId: 't1_parent',
          postId: 't3_post',
          removed: false,
        }
      : {
          id: 't1_parent',
          body: 'sold to u/buyer',
          authorName: 'seller',
          parentId: 't3_post',
          postId: 't3_post',
          removed: false,
        }),
    getPostById: vi.fn(async () => ({
      id: 't3_post',
      authorId: 't2_bot',
      locked: false,
    })),
    getAppUser: vi.fn(async () => ({ id: 't2_bot', username: 'swap-conf-bot' })),
    getUserByUsername: vi.fn(async () => ({ getUserFlairBySubreddit: vi.fn(async () => undefined) })),
    setUserFlair: vi.fn(async () => undefined),
    getComments: vi.fn(async (): Promise<Array<{ id: string; authorName?: string; body?: string }>> => []),
    submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
  }
  return { ctx: { redis, reddit }, store, reddit }
}

describe('processConfirmationItem', () => {
  it('evaluates and commits a valid confirmation work item', async () => {
    const { ctx, store, reddit } = mockContext()

    const result = await processConfirmationItem(ctx, workItem, { clock: fixedClock() })

    expect(result.status).toBe('committed')
    if (result.status !== 'committed') throw new Error('Expected committed result')
    expect(result.record).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      parentPreviousCount: 4,
      parentCount: 5,
      confirmerPreviousCount: 2,
      confirmerCount: 3,
    }))
    expect(store.get('confirmations:seller')).toBe('5')
    expect(store.get('confirmations:buyer')).toBe('3')
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      text: 'Trades: 5',
    })
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'buyer',
      text: 'Trades: 3',
    })
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      effects: {
        parentFlair: { status: 'applied', at: '2026-06-11T12:00:00.000Z' },
        confirmerFlair: { status: 'applied', at: '2026-06-11T12:00:00.000Z' },
        reply: { status: 'posted', at: '2026-06-11T12:00:00.000Z', replyId: 't1_bot_reply' },
      },
    }))
    expect(reddit.submitComment).toHaveBeenCalledWith(expect.objectContaining({
      id: 't1_confirm',
      text: expect.stringContaining('u/buyer'),
    }))
  })

  it('does not duplicate the confirmation reply when recovery finds the bot marker', async () => {
    const { ctx, reddit } = mockContext()
    reddit.getComments.mockResolvedValueOnce([
      {
        id: 't1_existing_reply',
        authorName: 'swap-conf-bot',
        body: 'already posted\n\nConfirmation ID: t1_parent',
      },
    ])

    const result = await processConfirmationItem(ctx, workItem, { clock: fixedClock() })

    expect(result.status).toBe('committed')
    expect(reddit.submitComment).not.toHaveBeenCalled()
  })

  it('marks manual confirmation work as moderator approved on the claim', async () => {
    const { ctx, store } = mockContext()

    const result = await processConfirmationItem(ctx, {
      ...workItem,
      workId: 'manual-confirmation:t1_confirm',
      kind: 'manual-confirmation',
    }, { clock: fixedClock() })

    expect(result.status).toBe('committed')
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      modApproval: true,
    }))
  })

  it('stores and posts a durable rejection reply for self-confirmation', async () => {
    const { ctx, store, reddit } = mockContext()
    reddit.getCommentById.mockImplementation(async (id: string) => id === 't1_confirm'
      ? {
          id: 't1_confirm',
          body: 'confirmed',
          authorName: 'seller',
          parentId: 't1_parent',
          postId: 't3_post',
          removed: false,
        }
      : {
          id: 't1_parent',
          body: 'sold',
          authorName: 'seller',
          parentId: 't3_post',
          postId: 't3_post',
          removed: false,
        })

    const result = await processConfirmationItem(ctx, workItem, { clock: fixedClock() })

    expect(result).toEqual({ status: 'rejected', evaluation: { valid: false, reason: 'same_user' } })
    expect(store.get('confirmations:seller')).toBe('4')
    expect(store.get('confirmations:buyer')).toBe('2')
    expect(reddit.setUserFlair).not.toHaveBeenCalled()
    expect(reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: expect.stringContaining('Rejection ID: t1_confirm'),
    })
    expect(JSON.parse(store.get('rejected:t1_confirm') ?? '{}')).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      reason: 'same_user',
      effects: {
        reply: { status: 'posted', at: '2026-06-11T12:00:00.000Z', replyId: 't1_bot_reply' },
      },
    }))
  })

  it('stores and posts a durable rejection reply when the parent did not mention the confirmer', async () => {
    const { ctx, store, reddit } = mockContext()
    reddit.getCommentById.mockImplementation(async (id: string) => id === 't1_confirm'
      ? {
          id: 't1_confirm',
          body: 'confirmed',
          authorName: 'buyer',
          parentId: 't1_parent',
          postId: 't3_post',
          removed: false,
        }
      : {
          id: 't1_parent',
          body: 'sold locally',
          authorName: 'seller',
          parentId: 't3_post',
          postId: 't3_post',
          removed: false,
        })

    const result = await processConfirmationItem(ctx, workItem, { clock: fixedClock() })

    expect(result).toEqual({ status: 'rejected', evaluation: { valid: false, reason: 'cant_confirm_username' } })
    expect(reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: expect.stringContaining('u/seller'),
    })
    expect(reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: expect.stringContaining('u/buyer'),
    })
    expect(JSON.parse(store.get('rejected:t1_confirm') ?? '{}')).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      reason: 'cant_confirm_username',
      authorName: 'buyer',
      parentAuthor: 'seller',
      effects: {
        reply: { status: 'posted', at: '2026-06-11T12:00:00.000Z', replyId: 't1_bot_reply' },
      },
    }))
  })

  it('stores and posts a durable reply when the trade was already confirmed', async () => {
    const { ctx, store, reddit } = mockContext()
    store.set('confirmed:t1_parent', JSON.stringify({
      commentId: 't1_earlier_confirm',
      replyToCommentId: 't1_earlier_confirm',
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
        parentFlair: { status: 'applied', at: '2026-06-11T11:59:00.000Z' },
        confirmerFlair: { status: 'applied', at: '2026-06-11T11:59:00.000Z' },
        reply: { status: 'posted', at: '2026-06-11T11:59:00.000Z', replyId: 't1_old_reply' },
      },
      createdAt: '2026-06-11T11:59:00.000Z',
      updatedAt: '2026-06-11T11:59:00.000Z',
    }))

    const result = await processConfirmationItem(ctx, workItem, { clock: fixedClock() })

    expect(result).toEqual({ status: 'already_claimed' })
    expect(store.get('confirmations:seller')).toBe('4')
    expect(store.get('confirmations:buyer')).toBe('2')
    expect(reddit.setUserFlair).not.toHaveBeenCalled()
    expect(reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: expect.stringContaining('already been confirmed'),
    })
    expect(JSON.parse(store.get('rejected:t1_confirm') ?? '{}')).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      reason: 'already_claimed',
      effects: {
        reply: { status: 'posted', at: '2026-06-11T12:00:00.000Z', replyId: 't1_bot_reply' },
      },
    }))
  })
})
