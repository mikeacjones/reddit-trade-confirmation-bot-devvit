import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import { enqueueCurrentMonthlyPostComments, RESCAN_CONFIRMATION_COMMENTS_CRON } from '../src/rescan.js'
import { processedWorkKey, READY_QUEUE_KEY, workItemKey } from '../src/workQueue.js'

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
  }
  const scheduler = {
    runJob: vi.fn(async () => 'job-id'),
  }
  const reddit = {
    getCurrentSubredditName: vi.fn(async () => 'PlasticModelExchange'),
    getComments: vi.fn(() => ({
      all: vi.fn(async () => [
        { id: 't1_parent', postId: 't3_post' },
        { id: 't1_confirm', postId: 't3_post' },
      ]),
    })),
  }
  return { ctx: { redis, scheduler, reddit }, store, zsets, scheduler, reddit }
}

describe('enqueueCurrentMonthlyPostComments', () => {
  it('runs at half past the hour to avoid monthly post rotation', () => {
    expect(RESCAN_CONFIRMATION_COMMENTS_CRON).toBe('30 * * * *')
  })

  it('returns without reading Reddit when there is no current monthly post', async () => {
    const { ctx, scheduler, reddit } = mockContext()

    await expect(enqueueCurrentMonthlyPostComments(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ scanned: 0, enqueued: 0 })

    expect(reddit.getCurrentSubredditName).not.toHaveBeenCalled()
    expect(reddit.getComments).not.toHaveBeenCalled()
    expect(scheduler.runJob).not.toHaveBeenCalled()
  })

  it('enqueues comments from the current monthly post and nudges the worker once', async () => {
    const { ctx, store, zsets, scheduler, reddit } = mockContext({
      currentMonthlyPost: 't3_post',
    })

    const result = await enqueueCurrentMonthlyPostComments(ctx, { clock: fixedClock() })

    expect(result).toEqual({ scanned: 2, enqueued: 2 })
    expect(reddit.getComments).toHaveBeenCalledWith({
      postId: 't3_post',
      sort: 'new',
      limit: 1000,
      pageSize: 100,
    })
    expect(JSON.parse(store.get(workItemKey('confirmation-comment:t1_confirm')) ?? '{}')).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
    }))
    expect(zsets.get(READY_QUEUE_KEY)?.map(item => item.member)).toEqual([
      'confirmation-comment:t1_parent',
      'confirmation-comment:t1_confirm',
    ])
    expect(scheduler.runJob).toHaveBeenCalledOnce()
  })

  it('does not nudge the worker when rescanned comments are already queued', async () => {
    const { ctx, scheduler } = mockContext({
      currentMonthlyPost: 't3_post',
      [workItemKey('confirmation-comment:t1_parent')]: JSON.stringify({ workId: 'confirmation-comment:t1_parent' }),
      [workItemKey('confirmation-comment:t1_confirm')]: JSON.stringify({ workId: 'confirmation-comment:t1_confirm' }),
    })

    await expect(enqueueCurrentMonthlyPostComments(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ scanned: 2, enqueued: 0 })

    expect(scheduler.runJob).not.toHaveBeenCalled()
  })

  it('does not enqueue comments that already reached a terminal processed state', async () => {
    const { ctx, scheduler } = mockContext({
      currentMonthlyPost: 't3_post',
      [processedWorkKey('confirmation-comment:t1_parent')]: JSON.stringify({ commentId: 't1_parent' }),
      [processedWorkKey('confirmation-comment:t1_confirm')]: JSON.stringify({ commentId: 't1_confirm' }),
    })

    await expect(enqueueCurrentMonthlyPostComments(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ scanned: 2, enqueued: 0 })

    expect(scheduler.runJob).not.toHaveBeenCalled()
  })
})
