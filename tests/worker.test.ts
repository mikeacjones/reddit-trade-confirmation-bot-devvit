import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import { processConfirmationWork } from '../src/worker.js'
import {
  POLLER_LEASE_KEY,
  processedWorkKey,
  READY_QUEUE_KEY,
  workItemKey,
} from '../src/workQueue.js'

function fixedClock(value = '2026-06-11T12:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

function mutableClock(value = '2026-06-11T12:00:00.000Z') {
  let now = Date.parse(value)
  return {
    clock: { now: () => new Date(now) } satisfies Clock,
    advanceBy: (ms: number) => {
      now += ms
    },
  }
}

function queuedWork(workId: string) {
  return {
    workId,
    kind: 'confirmation-comment',
    commentId: 't1_comment',
    postId: 't3_post',
    subredditName: 'PlasticModelExchange',
    enqueuedAt: '2026-06-11T11:59:00.000Z',
    status: 'queued',
    attempts: 0,
    nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
  }
}

function mockContext(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const zsets = new Map<string, Array<{ member: string; score: number }>>()
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
    set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
      if (options?.nx && store.has(key)) return ''
      store.set(key, value)
      return 'OK'
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key)
    }),
    zAdd: vi.fn(async (key: string, member: { member: string; score: number }) => {
      const members = zsets.get(key) ?? []
      const existing = members.findIndex(item => item.member === member.member)
      if (existing >= 0) members[existing] = member
      else members.push(member)
      zsets.set(key, members)
      return existing >= 0 ? 0 : 1
    }),
    zRem: vi.fn(async (key: string, membersToRemove: string[]) => {
      const members = zsets.get(key) ?? []
      const remaining = members.filter(item => !membersToRemove.includes(item.member))
      zsets.set(key, remaining)
      return members.length - remaining.length
    }),
    zRange: vi.fn(async (
      key: string,
      start: number | string,
      stop: number | string,
      options?: { limit?: { offset: number; count: number } },
    ) => {
      const min = start === '-inf' ? Number.NEGATIVE_INFINITY : Number(start)
      const max = stop === '+inf' ? Number.POSITIVE_INFINITY : Number(stop)
      const members = (zsets.get(key) ?? [])
        .filter(item => item.score >= min && item.score <= max)
        .sort((a, b) => a.score - b.score)
      const offset = options?.limit?.offset ?? 0
      const count = options?.limit?.count ?? members.length
      return members.slice(offset, offset + count)
    }),
    watch: vi.fn(async () => txn),
  }
  const reddit = {
    getCommentById: vi.fn(async (id: string) => id === 't1_comment'
      ? {
          id: 't1_comment',
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
    getAppUser: vi.fn(async () => ({ id: 't2_bot' })),
    getUserByUsername: vi.fn(async () => ({ getUserFlairBySubreddit: vi.fn(async () => undefined) })),
    setUserFlair: vi.fn(async () => undefined),
    submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
  }
  return { ctx: { redis, reddit }, store, zsets }
}

describe('processConfirmationWork', () => {
  it('exits when another worker holds the global poller lease', async () => {
    const { ctx } = mockContext({ [POLLER_LEASE_KEY]: 'already-running' })
    const processItem = vi.fn(async () => undefined)

    const result = await processConfirmationWork(ctx, {
      clock: fixedClock(),
      processItem,
    })

    expect(result).toEqual({ pollerAcquired: false, processed: 0 })
    expect(processItem).not.toHaveBeenCalled()
  })

  it('processes one claimed due work item', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const work = queuedWork(workId)
    const { ctx, store, zsets } = mockContext({
      [workItemKey(workId)]: JSON.stringify(work),
    })
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])
    const processItem = vi.fn(async () => undefined)

    const result = await processConfirmationWork(ctx, {
      clock: fixedClock(),
      processItem,
    })

    expect(result).toEqual({ pollerAcquired: true, processed: 1 })
    expect(processItem).toHaveBeenCalledWith(work, ctx)
    expect(store.get(POLLER_LEASE_KEY)).toBe(String(Date.parse('2026-06-11T12:00:00.000Z')))
    expect(JSON.parse(store.get(processedWorkKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      workId,
      commentId: 't1_comment',
      processedAt: '2026-06-11T12:00:00.000Z',
    }))
    expect(store.get(workItemKey(workId))).toBeUndefined()
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([])
  })

  it('processes up to five due work items by default', async () => {
    const dueAt = Date.parse('2026-06-11T11:59:00.000Z')
    const entries = Array.from({ length: 6 }, (_, index) => {
      const workId = `confirmation-comment:t1_comment_${index + 1}`
      return {
        workId,
        work: {
          ...queuedWork(workId),
          commentId: `t1_comment_${index + 1}`,
          nextAttemptAt: dueAt,
        },
      }
    })
    const { ctx, zsets } = mockContext(Object.fromEntries(
      entries.map(({ workId, work }) => [workItemKey(workId), JSON.stringify(work)]),
    ))
    zsets.set(READY_QUEUE_KEY, entries.map(({ workId }) => ({ member: workId, score: dueAt })))
    const processItem = vi.fn(async () => undefined)

    const result = await processConfirmationWork(ctx, {
      clock: fixedClock(),
      processItem,
    })

    expect(result).toEqual({ pollerAcquired: true, processed: 5 })
    expect(processItem).toHaveBeenCalledTimes(5)
    expect(zsets.get(READY_QUEUE_KEY)?.map(item => item.member)).toEqual([
      'confirmation-comment:t1_comment_6',
    ])
  })

  it('stops before claiming more work after the runtime budget is spent', async () => {
    const dueAt = Date.parse('2026-06-11T11:59:00.000Z')
    const firstWorkId = 'confirmation-comment:t1_first'
    const secondWorkId = 'confirmation-comment:t1_second'
    const { ctx, zsets } = mockContext({
      [workItemKey(firstWorkId)]: JSON.stringify({
        ...queuedWork(firstWorkId),
        commentId: 't1_first',
        nextAttemptAt: dueAt,
      }),
      [workItemKey(secondWorkId)]: JSON.stringify({
        ...queuedWork(secondWorkId),
        commentId: 't1_second',
        nextAttemptAt: dueAt,
      }),
    })
    zsets.set(READY_QUEUE_KEY, [
      { member: firstWorkId, score: dueAt },
      { member: secondWorkId, score: dueAt },
    ])
    const { clock, advanceBy } = mutableClock()
    const processItem = vi.fn(async () => {
      advanceBy(21_000)
    })

    const result = await processConfirmationWork(ctx, {
      clock,
      processItem,
    })

    expect(result).toEqual({ pollerAcquired: true, processed: 1 })
    expect(processItem).toHaveBeenCalledTimes(1)
    expect(zsets.get(READY_QUEUE_KEY)?.map(item => item.member)).toEqual([secondWorkId])
  })

  it('keeps failed work queued with a later retry time', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const work = queuedWork(workId)
    const { ctx, store, zsets } = mockContext({
      [workItemKey(workId)]: JSON.stringify(work),
    })
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])
    const processItem = vi.fn(async () => {
      throw new Error('reddit down')
    })

    const result = await processConfirmationWork(ctx, {
      clock: fixedClock(),
      processItem,
    })

    expect(result).toEqual({ pollerAcquired: true, processed: 0 })
    expect(JSON.parse(store.get(workItemKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      status: 'queued',
      attempts: 1,
      lastError: 'reddit down',
      nextAttemptAt: Date.parse('2026-06-11T12:00:30.000Z'),
    }))
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([
      {
        member: workId,
        score: Date.parse('2026-06-11T12:00:30.000Z'),
      },
    ])
  })

  it('uses the confirmation workflow as the default item processor', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const work = queuedWork(workId)
    const { ctx, store, zsets } = mockContext({
      currentMonthlyPost: 't3_post',
      'confirmations:seller': '4',
      'confirmations:buyer': '2',
      [workItemKey(workId)]: JSON.stringify(work),
    })
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])

    const result = await processConfirmationWork(ctx, { clock: fixedClock() })

    expect(result).toEqual({ pollerAcquired: true, processed: 1 })
    expect(store.get('confirmations:seller')).toBe('5')
    expect(store.get('confirmations:buyer')).toBe('3')
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual({
      commentId: 't1_comment',
      parentCommentId: 't1_parent',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      confirmedAt: '2026-06-11T12:00:00.000Z',
    })
    expect(JSON.parse(store.get(processedWorkKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      workId,
      commentId: 't1_comment',
      processedAt: '2026-06-11T12:00:00.000Z',
    }))
    expect(store.get(workItemKey(workId))).toBeUndefined()
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([])
  })

  it('cleans up rich rejection state after a terminal rejection reply', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const work = queuedWork(workId)
    const { ctx, store, zsets } = mockContext({
      currentMonthlyPost: 't3_post',
      [workItemKey(workId)]: JSON.stringify(work),
    })
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])
    ctx.reddit.getCommentById.mockImplementation(async (id: string) => id === 't1_comment'
      ? {
          id: 't1_comment',
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

    const result = await processConfirmationWork(ctx, { clock: fixedClock() })

    expect(result).toEqual({ pollerAcquired: true, processed: 1 })
    expect(ctx.reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_comment',
      text: expect.stringContaining('own trade'),
    })
    expect(store.get('rejected:t1_comment')).toBeUndefined()
    expect(JSON.parse(store.get(processedWorkKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      workId,
      commentId: 't1_comment',
      processedAt: '2026-06-11T12:00:00.000Z',
    }))
    expect(store.get(workItemKey(workId))).toBeUndefined()
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([])
  })

  it('does not fail terminal work when post-completion cleanup fails', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const work = queuedWork(workId)
    const { ctx, store, zsets } = mockContext({
      [workItemKey(workId)]: JSON.stringify(work),
    })
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])
    ctx.redis.set.mockImplementation(async (key: string, value: string, options?: { nx?: boolean }) => {
      if (key === 'confirmed:t1_parent') throw new Error('compact failed')
      if (options?.nx && store.has(key)) return ''
      store.set(key, value)
      return 'OK'
    })
    const processItem = vi.fn(async () => ({
      status: 'committed' as const,
      record: {
        commentId: 't1_comment',
        replyToCommentId: 't1_comment',
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
          parentFlair: { status: 'applied' as const, at: '2026-06-11T12:00:00.000Z' },
          confirmerFlair: { status: 'applied' as const, at: '2026-06-11T12:00:00.000Z' },
          reply: { status: 'posted' as const, at: '2026-06-11T12:00:00.000Z', replyId: 't1_bot_reply' },
        },
        createdAt: '2026-06-11T11:59:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
      },
    }))

    const result = await processConfirmationWork(ctx, {
      clock: fixedClock(),
      processItem,
    })

    expect(result).toEqual({ pollerAcquired: true, processed: 1 })
    expect(JSON.parse(store.get(processedWorkKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      workId,
      processedAt: '2026-06-11T12:00:00.000Z',
    }))
    expect(store.get(workItemKey(workId))).toBeUndefined()
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([])
    expect(zsets.get('work:failed')).toBeUndefined()
  })
})
