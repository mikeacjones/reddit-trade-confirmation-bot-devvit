import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import { onCommentSubmit } from '../src/events.js'
import {
  acquirePollerLease,
  claimNextDueWork,
  completeWorkItem,
  enqueueConfirmationComment,
  enqueueManualConfirmation,
  failWorkItem,
  FAILED_QUEUE_KEY,
  listFailedWorkItems,
  listReadyWorkItems,
  POLLER_LEASE_KEY,
  nudgeConfirmationWorker,
  PROCESS_CONFIRMATION_WORK_JOB,
  processedWorkKey,
  READY_QUEUE_KEY,
  retryFailedWorkItem,
  WORKER_NUDGE_KEY,
  workItemLeaseKey,
  workItemKey,
} from '../src/workQueue.js'

function fixedClock(value = '2026-06-11T12:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

function mockContext(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const zsets = new Map<string, Array<{ member: string; score: number }>>()
  const redis = {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
      if (options?.nx && store.has(key)) return ''
      store.set(key, value)
      return 'OK'
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
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key)
    }),
    zRange: vi.fn(async (
      key: string,
      start: number | string,
      stop: number | string,
      options?: { by?: string; limit?: { offset: number; count: number } },
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
  }
  const scheduler = {
    runJob: vi.fn(async () => 'job-id'),
  }
  return { ctx: { redis, scheduler }, store, zsets, redis, scheduler }
}

describe('enqueueConfirmationComment', () => {
  it('writes a durable work item and marks it ready', async () => {
    const { ctx, store, zsets } = mockContext()
    const clock = fixedClock()

    const result = await enqueueConfirmationComment(ctx, {
      commentId: 't1_comment',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
    }, clock)

    expect(result).toEqual(expect.objectContaining({
      workId: 'confirmation-comment:t1_comment',
      enqueued: true,
    }))
    expect(JSON.parse(store.get(workItemKey(result.workId)) ?? '{}')).toEqual({
      workId: 'confirmation-comment:t1_comment',
      kind: 'confirmation-comment',
      commentId: 't1_comment',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      enqueuedAt: '2026-06-11T12:00:00.000Z',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
    })
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([
      {
        member: 'confirmation-comment:t1_comment',
        score: Date.parse('2026-06-11T12:00:00.000Z'),
      },
    ])
  })

  it('does not enqueue duplicate work items', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const { ctx, zsets } = mockContext({
      [workItemKey(workId)]: JSON.stringify({ workId }),
    })

    const result = await enqueueConfirmationComment(ctx, {
      commentId: 't1_comment',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
    }, fixedClock())

    expect(result.enqueued).toBe(false)
    expect(ctx.redis.zAdd).not.toHaveBeenCalled()
    expect(zsets.get(READY_QUEUE_KEY)).toBeUndefined()
  })

  it('does not enqueue comments with a persistent processed marker', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const { ctx, zsets } = mockContext({
      [processedWorkKey(workId)]: JSON.stringify({ workId, commentId: 't1_comment' }),
    })

    const result = await enqueueConfirmationComment(ctx, {
      commentId: 't1_comment',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
    }, fixedClock())

    expect(result.enqueued).toBe(false)
    expect(ctx.redis.set).not.toHaveBeenCalledWith(workItemKey(workId), expect.any(String), expect.anything())
    expect(ctx.redis.zAdd).not.toHaveBeenCalled()
    expect(zsets.get(READY_QUEUE_KEY)).toBeUndefined()
  })
})

describe('enqueueManualConfirmation', () => {
  it('writes manual confirmation work without colliding with event work for the same comment', async () => {
    const { ctx, store, zsets } = mockContext()
    const clock = fixedClock()

    await enqueueConfirmationComment(ctx, {
      commentId: 't1_comment',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
    }, clock)
    const result = await enqueueManualConfirmation(ctx, {
      commentId: 't1_comment',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
    }, clock)

    expect(result).toEqual(expect.objectContaining({
      workId: 'manual-confirmation:t1_comment',
      enqueued: true,
    }))
    expect(JSON.parse(store.get(workItemKey(result.workId)) ?? '{}')).toEqual({
      workId: 'manual-confirmation:t1_comment',
      kind: 'manual-confirmation',
      commentId: 't1_comment',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      enqueuedAt: '2026-06-11T12:00:00.000Z',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
    })
    expect(zsets.get(READY_QUEUE_KEY)?.map(item => item.member)).toEqual([
      'confirmation-comment:t1_comment',
      'manual-confirmation:t1_comment',
    ])
  })
})

describe('nudgeConfirmationWorker', () => {
  it('schedules a near-term worker job once per debounce window', async () => {
    const { ctx, store, scheduler } = mockContext()
    const clock = fixedClock()

    await expect(nudgeConfirmationWorker(ctx, clock)).resolves.toBe(true)

    expect(store.get(WORKER_NUDGE_KEY)).toBe(String(Date.parse('2026-06-11T12:00:00.000Z')))
    expect(scheduler.runJob).toHaveBeenCalledWith({
      name: PROCESS_CONFIRMATION_WORK_JOB,
      runAt: new Date('2026-06-11T12:00:01.000Z'),
    })

    await expect(nudgeConfirmationWorker(ctx, clock)).resolves.toBe(false)
    expect(scheduler.runJob).toHaveBeenCalledTimes(1)
  })
})

describe('acquirePollerLease', () => {
  it('claims the global worker lease once', async () => {
    const { ctx, store } = mockContext()
    const clock = fixedClock()

    await expect(acquirePollerLease(ctx, clock)).resolves.toBe(true)
    await expect(acquirePollerLease(ctx, clock)).resolves.toBe(false)

    expect(store.get(POLLER_LEASE_KEY)).toBe(String(Date.parse('2026-06-11T12:00:00.000Z')))
  })
})

describe('claimNextDueWork', () => {
  it('claims the first due work item without removing it from the ready queue', async () => {
    const { ctx, store, zsets } = mockContext()
    const clock = fixedClock()
    const dueWorkId = 'confirmation-comment:t1_due'
    const futureWorkId = 'confirmation-comment:t1_future'
    store.set(workItemKey(dueWorkId), JSON.stringify({
      workId: dueWorkId,
      kind: 'confirmation-comment',
      commentId: 't1_due',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      enqueuedAt: '2026-06-11T11:59:00.000Z',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
    }))
    zsets.set(READY_QUEUE_KEY, [
      { member: futureWorkId, score: Date.parse('2026-06-11T12:01:00.000Z') },
      { member: dueWorkId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])

    const claimed = await claimNextDueWork(ctx, clock)

    expect(claimed?.workId).toBe(dueWorkId)
    expect(store.get(workItemLeaseKey(dueWorkId))).toBe(String(Date.parse('2026-06-11T12:00:00.000Z')))
    expect(zsets.get(READY_QUEUE_KEY)?.map(item => item.member)).toEqual([futureWorkId, dueWorkId])
  })

  it('cleans up stale ready entries that already have a processed marker', async () => {
    const { ctx, store, zsets } = mockContext()
    const clock = fixedClock()
    const workId = 'confirmation-comment:t1_done'
    store.set(processedWorkKey(workId), JSON.stringify({ workId, commentId: 't1_done' }))
    store.set(workItemKey(workId), JSON.stringify({
      workId,
      kind: 'confirmation-comment',
      commentId: 't1_done',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      enqueuedAt: '2026-06-11T11:59:00.000Z',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
    }))
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])

    await expect(claimNextDueWork(ctx, clock)).resolves.toBeNull()

    expect(store.get(processedWorkKey(workId))).toBeDefined()
    expect(store.get(workItemKey(workId))).toBeUndefined()
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([])
  })
})

describe('listReadyWorkItems', () => {
  it('returns queued work items in ready-time order', async () => {
    const firstWorkId = 'confirmation-comment:t1_first'
    const secondWorkId = 'confirmation-comment:t1_second'
    const { ctx, store, zsets } = mockContext({
      [workItemKey(firstWorkId)]: JSON.stringify({
        workId: firstWorkId,
        kind: 'confirmation-comment',
        commentId: 't1_first',
        postId: 't3_post',
        subredditName: 'PlasticModelExchange',
        enqueuedAt: '2026-06-11T11:00:00.000Z',
        status: 'queued',
        attempts: 1,
        nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
      }),
      [workItemKey(secondWorkId)]: JSON.stringify({
        workId: secondWorkId,
        kind: 'confirmation-comment',
        commentId: 't1_second',
        postId: 't3_post',
        subredditName: 'PlasticModelExchange',
        enqueuedAt: '2026-06-11T11:00:00.000Z',
        status: 'queued',
        attempts: 0,
        nextAttemptAt: Date.parse('2026-06-11T12:01:00.000Z'),
      }),
    })
    zsets.set(READY_QUEUE_KEY, [
      { member: secondWorkId, score: Date.parse('2026-06-11T12:01:00.000Z') },
      { member: firstWorkId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])

    await expect(listReadyWorkItems(ctx, 10)).resolves.toEqual([
      expect.objectContaining({ workId: firstWorkId, attempts: 1 }),
      expect.objectContaining({ workId: secondWorkId, attempts: 0 }),
    ])
    expect(store.size).toBe(2)
  })
})

describe('completeWorkItem', () => {
  it('writes a processed marker and removes temporary queue state', async () => {
    const workId = 'confirmation-comment:t1_done'
    const { ctx, store, zsets } = mockContext()
    store.set(workItemKey(workId), JSON.stringify({
      workId,
      kind: 'confirmation-comment',
      commentId: 't1_done',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      enqueuedAt: '2026-06-11T11:59:00.000Z',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
    }))
    store.set(workItemLeaseKey(workId), 'lease')
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])

    await completeWorkItem(ctx, {
      workId,
      kind: 'confirmation-comment',
      commentId: 't1_done',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      enqueuedAt: '2026-06-11T11:59:00.000Z',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
    }, fixedClock())

    expect(JSON.parse(store.get(processedWorkKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      workId,
      commentId: 't1_done',
      processedAt: '2026-06-11T12:00:00.000Z',
    }))
    expect(store.get(workItemKey(workId))).toBeUndefined()
    expect(store.get(workItemLeaseKey(workId))).toBeUndefined()
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([])
  })
})

describe('failWorkItem', () => {
  it('dead-letters work after the final retry attempt', async () => {
    const workId = 'confirmation-comment:t1_failed'
    const { ctx, store, zsets } = mockContext()
    zsets.set(READY_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T11:59:00.000Z') },
    ])

    await failWorkItem(ctx, {
      workId,
      kind: 'confirmation-comment',
      commentId: 't1_failed',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      enqueuedAt: '2026-06-11T11:00:00.000Z',
      status: 'queued',
      attempts: 9,
      nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
    }, new Error('reddit down'), fixedClock())

    expect(JSON.parse(store.get(workItemKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      workId,
      status: 'failed',
      attempts: 10,
      failedAt: '2026-06-11T12:00:00.000Z',
      lastError: 'reddit down',
    }))
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([])
    expect(zsets.get(FAILED_QUEUE_KEY)).toEqual([
      { member: workId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])
  })
})

describe('retryFailedWorkItem', () => {
  it('does not retry stale failed work that already has a processed marker', async () => {
    const workId = 'confirmation-comment:t1_failed'
    const { ctx, store, zsets } = mockContext({
      [processedWorkKey(workId)]: JSON.stringify({ workId, commentId: 't1_failed' }),
      [workItemKey(workId)]: JSON.stringify({
        workId,
        kind: 'confirmation-comment',
        commentId: 't1_failed',
        postId: 't3_post',
        subredditName: 'PlasticModelExchange',
        enqueuedAt: '2026-06-11T11:00:00.000Z',
        status: 'failed',
        attempts: 10,
        nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
        failedAt: '2026-06-11T12:00:00.000Z',
        lastError: 'old error',
      }),
      [workItemLeaseKey(workId)]: 'lease',
    })
    zsets.set(FAILED_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])

    await expect(retryFailedWorkItem(ctx, workId, fixedClock())).resolves.toBe(false)

    expect(store.get(processedWorkKey(workId))).toBeDefined()
    expect(store.get(workItemKey(workId))).toBeUndefined()
    expect(store.get(workItemLeaseKey(workId))).toBeUndefined()
    expect(zsets.get(FAILED_QUEUE_KEY)).toEqual([])
    expect(zsets.get(READY_QUEUE_KEY)).toBeUndefined()
  })

  it('moves failed work back to the ready queue', async () => {
    const workId = 'confirmation-comment:t1_failed'
    const { ctx, store, zsets } = mockContext({
      [workItemKey(workId)]: JSON.stringify({
        workId,
        kind: 'confirmation-comment',
        commentId: 't1_failed',
        postId: 't3_post',
        subredditName: 'PlasticModelExchange',
        enqueuedAt: '2026-06-11T11:00:00.000Z',
        status: 'failed',
        attempts: 10,
        nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
        failedAt: '2026-06-11T12:00:00.000Z',
        lastError: 'reddit down',
      }),
    })
    zsets.set(FAILED_QUEUE_KEY, [
      { member: workId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])

    await expect(retryFailedWorkItem(ctx, workId, fixedClock())).resolves.toBe(true)

    expect(JSON.parse(store.get(workItemKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      workId,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
    }))
    expect(JSON.parse(store.get(workItemKey(workId)) ?? '{}').failedAt).toBeUndefined()
    expect(JSON.parse(store.get(workItemKey(workId)) ?? '{}').lastError).toBeUndefined()
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([
      { member: workId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])
    expect(zsets.get(FAILED_QUEUE_KEY)).toEqual([])
  })
})

describe('listFailedWorkItems', () => {
  it('returns failed work items in failure-time order', async () => {
    const firstWorkId = 'confirmation-comment:t1_first'
    const secondWorkId = 'confirmation-comment:t1_second'
    const { ctx, zsets, store } = mockContext({
      [workItemKey(firstWorkId)]: JSON.stringify({
        workId: firstWorkId,
        kind: 'confirmation-comment',
        commentId: 't1_first',
        postId: 't3_post',
        subredditName: 'PlasticModelExchange',
        enqueuedAt: '2026-06-11T11:00:00.000Z',
        status: 'failed',
        attempts: 10,
        nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
        failedAt: '2026-06-11T12:00:00.000Z',
        lastError: 'first error',
      }),
      [workItemKey(secondWorkId)]: JSON.stringify({
        workId: secondWorkId,
        kind: 'confirmation-comment',
        commentId: 't1_second',
        postId: 't3_post',
        subredditName: 'PlasticModelExchange',
        enqueuedAt: '2026-06-11T11:00:00.000Z',
        status: 'failed',
        attempts: 10,
        nextAttemptAt: Date.parse('2026-06-11T11:59:00.000Z'),
        failedAt: '2026-06-11T12:01:00.000Z',
        lastError: 'second error',
      }),
    })
    zsets.set(FAILED_QUEUE_KEY, [
      { member: secondWorkId, score: Date.parse('2026-06-11T12:01:00.000Z') },
      { member: firstWorkId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])

    await expect(listFailedWorkItems(ctx, 10)).resolves.toEqual([
      expect.objectContaining({ workId: firstWorkId, lastError: 'first error' }),
      expect.objectContaining({ workId: secondWorkId, lastError: 'second error' }),
    ])
    expect(store.size).toBe(2)
  })
})

describe('onCommentSubmit', () => {
  it('enqueues comment submit work and nudges the worker', async () => {
    const { ctx, store, scheduler } = mockContext()

    await onCommentSubmit({
      comment: {
        id: 't1_comment',
        postId: 't3_post',
      },
      subreddit: {
        name: 'PlasticModelExchange',
      },
    }, ctx, { clock: fixedClock() })

    expect(store.has(workItemKey('confirmation-comment:t1_comment'))).toBe(true)
    expect(scheduler.runJob).toHaveBeenCalledOnce()
  })

  it('returns without writing work when the event has no comment', async () => {
    const { ctx, redis, scheduler } = mockContext()

    await onCommentSubmit({}, ctx, { clock: fixedClock() })

    expect(redis.set).not.toHaveBeenCalled()
    expect(scheduler.runJob).not.toHaveBeenCalled()
  })

  it('does not nudge the worker for duplicate work', async () => {
    const workId = 'confirmation-comment:t1_comment'
    const { ctx, scheduler } = mockContext({
      [workItemKey(workId)]: JSON.stringify({ workId }),
    })

    await onCommentSubmit({
      comment: {
        id: 't1_comment',
        postId: 't3_post',
      },
      subreddit: {
        name: 'PlasticModelExchange',
      },
    }, ctx, { clock: fixedClock() })

    expect(scheduler.runJob).not.toHaveBeenCalled()
  })
})
