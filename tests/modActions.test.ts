import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import {
  adjustCommentAuthorTradeCount,
  adjustNamedUserTradeCount,
  adjustUserTradesForm,
  onAdjustUserTradesFormSubmit,
  onManualConfirmationMenuAction,
  onQueueStatusMenuAction,
  onRetryFailedWorkMenuAction,
  onRescanMonthlyPostMenuAction,
  onSetCurrentConfirmationPostMenuAction,
  showAdjustUserTradesForm,
  showSetUserTradesForm,
} from '../src/modActions.js'
import { FAILED_QUEUE_KEY, READY_QUEUE_KEY, workItemKey } from '../src/workQueue.js'

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
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key)
    }),
  }
  const scheduler = {
    runJob: vi.fn(async () => 'job-id'),
  }
  const ui = {
    showForm: vi.fn(),
    showToast: vi.fn(),
  }
  const reddit = {
    getCommentById: vi.fn(async () => ({
      id: 't1_confirm',
      postId: 't3_post',
      authorName: 'seller',
    })),
    getCurrentSubredditName: vi.fn(async () => 'PlasticModelExchange'),
    getComments: vi.fn(() => ({
      all: vi.fn(async () => [
        { id: 't1_first', postId: 't3_post' },
        { id: 't1_second', postId: 't3_post' },
      ]),
    })),
    setUserFlair: vi.fn(async () => undefined),
  }
  return { ctx: { redis, scheduler, reddit, ui }, store, zsets, scheduler, reddit, ui }
}

describe('onManualConfirmationMenuAction', () => {
  it('enqueues manual confirmation work for the selected comment and nudges the worker', async () => {
    const { ctx, store, zsets, scheduler, reddit } = mockContext()

    const result = await onManualConfirmationMenuAction({
      location: 'comment',
      targetId: 't1_confirm',
    }, ctx, { clock: fixedClock() })

    expect(result).toEqual({ enqueued: true, workId: 'manual-confirmation:t1_confirm' })
    expect(reddit.getCommentById).toHaveBeenCalledWith('t1_confirm')
    expect(JSON.parse(store.get(workItemKey('manual-confirmation:t1_confirm')) ?? '{}')).toEqual(expect.objectContaining({
      kind: 'manual-confirmation',
      commentId: 't1_confirm',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
    }))
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([
      { member: 'manual-confirmation:t1_confirm', score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])
    expect(scheduler.runJob).toHaveBeenCalledOnce()
  })

  it('ignores non-comment menu locations', async () => {
    const { ctx, scheduler, reddit } = mockContext()

    await expect(onManualConfirmationMenuAction({
      location: 'post',
      targetId: 't3_post',
    }, ctx, { clock: fixedClock() })).resolves.toEqual({ enqueued: false })

    expect(reddit.getCommentById).not.toHaveBeenCalled()
    expect(scheduler.runJob).not.toHaveBeenCalled()
  })

  it('does not nudge the worker when manual confirmation work already exists', async () => {
    const { ctx, scheduler } = mockContext({
      [workItemKey('manual-confirmation:t1_confirm')]: JSON.stringify({ workId: 'manual-confirmation:t1_confirm' }),
    })

    await expect(onManualConfirmationMenuAction({
      location: 'comment',
      targetId: 't1_confirm',
    }, ctx, { clock: fixedClock() })).resolves.toEqual({
      enqueued: false,
      workId: 'manual-confirmation:t1_confirm',
    })

    expect(scheduler.runJob).not.toHaveBeenCalled()
  })
})

describe('onRetryFailedWorkMenuAction', () => {
  it('requeues failed work for the selected comment and nudges the worker', async () => {
    const workId = 'confirmation-comment:t1_confirm'
    const { ctx, store, zsets, scheduler } = mockContext({
      [workItemKey(workId)]: JSON.stringify({
        workId,
        kind: 'confirmation-comment',
        commentId: 't1_confirm',
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

    await expect(onRetryFailedWorkMenuAction({
      location: 'comment',
      targetId: 't1_confirm',
    }, ctx, { clock: fixedClock() })).resolves.toEqual({ retried: true, workId })

    expect(JSON.parse(store.get(workItemKey(workId)) ?? '{}')).toEqual(expect.objectContaining({
      status: 'queued',
      nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
    }))
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([
      { member: workId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])
    expect(zsets.get(FAILED_QUEUE_KEY)).toEqual([])
    expect(scheduler.runJob).toHaveBeenCalledOnce()
  })

  it('does not nudge when no failed work exists for the selected comment', async () => {
    const { ctx, scheduler } = mockContext()

    await expect(onRetryFailedWorkMenuAction({
      location: 'comment',
      targetId: 't1_confirm',
    }, ctx, { clock: fixedClock() })).resolves.toEqual({ retried: false })

    expect(scheduler.runJob).not.toHaveBeenCalled()
  })
})

describe('onQueueStatusMenuAction', () => {
  it('shows pending and failed work counts to moderators', async () => {
    const readyWorkId = 'confirmation-comment:t1_ready'
    const failedWorkId = 'confirmation-comment:t1_failed'
    const { ctx, zsets, ui } = mockContext({
      [workItemKey(readyWorkId)]: JSON.stringify({
        workId: readyWorkId,
        kind: 'confirmation-comment',
        commentId: 't1_ready',
        postId: 't3_post',
        subredditName: 'PlasticModelExchange',
        enqueuedAt: '2026-06-11T11:00:00.000Z',
        status: 'queued',
        attempts: 0,
        nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
      }),
      [workItemKey(failedWorkId)]: JSON.stringify({
        workId: failedWorkId,
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
    zsets.set(READY_QUEUE_KEY, [
      { member: readyWorkId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])
    zsets.set(FAILED_QUEUE_KEY, [
      { member: failedWorkId, score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])

    const result = await onQueueStatusMenuAction(ctx)

    expect(result).toEqual({ pending: 1, failed: 1 })
    expect(ui.showToast).toHaveBeenCalledWith('Work queue: 1 pending, 1 failed. Failed: t1_failed')
  })
})

describe('onRescanMonthlyPostMenuAction', () => {
  it('enqueues comments from the current monthly post and shows a summary', async () => {
    const { ctx, store, zsets, scheduler, ui } = mockContext({
      currentMonthlyPost: 't3_post',
    })

    await expect(onRescanMonthlyPostMenuAction(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ scanned: 2, enqueued: 2 })

    expect(store.has(workItemKey('confirmation-comment:t1_first'))).toBe(true)
    expect(store.has(workItemKey('confirmation-comment:t1_second'))).toBe(true)
    expect(zsets.get(READY_QUEUE_KEY)).toEqual([
      { member: 'confirmation-comment:t1_first', score: Date.parse('2026-06-11T12:00:00.000Z') },
      { member: 'confirmation-comment:t1_second', score: Date.parse('2026-06-11T12:00:00.000Z') },
    ])
    expect(scheduler.runJob).toHaveBeenCalledOnce()
    expect(ui.showToast).toHaveBeenCalledWith('Re-scan: 2 comments, 2 enqueued')
  })
})

describe('onSetCurrentConfirmationPostMenuAction', () => {
  it('stores the selected post as the current confirmation post', async () => {
    const { ctx, store, ui } = mockContext()

    await expect(onSetCurrentConfirmationPostMenuAction({
      location: 'post',
      targetId: 't3_monthly',
    }, ctx)).resolves.toEqual({ updated: true, postId: 't3_monthly' })

    expect(store.get('currentMonthlyPost')).toBe('t3_monthly')
    expect(ui.showToast).toHaveBeenCalledWith('Current confirmation post set to t3_monthly')
  })

  it('ignores non-post menu locations', async () => {
    const { ctx, ui } = mockContext()

    await expect(onSetCurrentConfirmationPostMenuAction({
      location: 'comment',
      targetId: 't1_confirm',
    }, ctx)).resolves.toEqual({ updated: false })

    expect(ctx.redis.set).not.toHaveBeenCalled()
    expect(ui.showToast).not.toHaveBeenCalled()
  })
})

describe('adjustCommentAuthorTradeCount', () => {
  it('adjusts the selected comment author without requiring a username input', async () => {
    const { ctx, store, reddit } = mockContext()

    const result = await adjustCommentAuthorTradeCount(ctx, {
      commentId: 't1_confirm',
      count: 9,
    }, fixedClock())

    expect(result).toEqual({ username: 'seller', count: 9, flairText: 'Trades: 9' })
    expect(reddit.getCommentById).toHaveBeenCalledWith('t1_confirm')
    expect(store.get('confirmations:seller')).toBe('9')
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'seller',
      text: 'Trades: 9',
    })
  })
})

describe('adjustNamedUserTradeCount', () => {
  it('adjusts a named user from the subreddit menu path', async () => {
    const { ctx, store, reddit } = mockContext()

    const result = await adjustNamedUserTradeCount(ctx, {
      username: 'u/buyer',
      count: 12,
    }, fixedClock())

    expect(result).toEqual({ username: 'buyer', count: 12, flairText: 'Trades: 12' })
    expect(store.get('confirmations:buyer')).toBe('12')
    expect(reddit.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'buyer',
      text: 'Trades: 12',
    })
  })
})

describe('adjust user trades form actions', () => {
  it('builds a form that carries the selected comment id and count', () => {
    expect(adjustUserTradesForm({ commentId: 't1_confirm' })).toEqual({
      title: "Adjust comment author's trades",
      acceptLabel: 'Update',
      fields: [
        {
          type: 'string',
          name: 'commentId',
          label: 'Comment ID',
          defaultValue: 't1_confirm',
          required: true,
        },
        {
          type: 'number',
          name: 'count',
          label: 'Trades',
          required: true,
        },
      ],
    })
  })

  it('builds a subreddit form for username and count', () => {
    expect(adjustUserTradesForm({})).toEqual({
      title: 'Set user trades',
      acceptLabel: 'Update',
      fields: [
        {
          type: 'string',
          name: 'username',
          label: 'Username',
          required: true,
        },
        {
          type: 'number',
          name: 'count',
          label: 'Trades',
          required: true,
        },
      ],
    })
  })

  it('opens the adjustment form for a selected comment', async () => {
    const { ctx, ui } = mockContext()

    await showAdjustUserTradesForm({
      location: 'comment',
      targetId: 't1_confirm',
    }, ctx, 'form-key' as any)

    expect(ui.showForm).toHaveBeenCalledWith('form-key', { commentId: 't1_confirm' })
  })

  it('opens the adjustment form for a named user from the subreddit menu', async () => {
    const { ctx, ui } = mockContext()

    await showSetUserTradesForm(ctx, 'form-key' as any)

    expect(ui.showForm).toHaveBeenCalledWith('form-key')
  })

  it('submits an adjustment for the selected comment author', async () => {
    const { ctx, store, ui } = mockContext()

    await onAdjustUserTradesFormSubmit({
      values: {
        commentId: 't1_confirm',
        count: 9,
      },
    }, ctx, { clock: fixedClock() })

    expect(store.get('confirmations:seller')).toBe('9')
    expect(ui.showToast).toHaveBeenCalledWith('Updated u/seller to Trades: 9')
  })

  it('submits an adjustment for a named user', async () => {
    const { ctx, store, ui } = mockContext()

    await onAdjustUserTradesFormSubmit({
      values: {
        username: '/u/buyer',
        count: 12,
      },
    }, ctx, { clock: fixedClock() })

    expect(store.get('confirmations:buyer')).toBe('12')
    expect(ui.showToast).toHaveBeenCalledWith('Updated u/buyer to Trades: 12')
  })
})
