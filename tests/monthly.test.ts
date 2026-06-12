import { describe, expect, it, vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import { MONTHLY_POST_JOB, processMonthlyPost } from '../src/monthly.js'

function fixedClock(value = '2026-05-01T00:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

function mockSettings(values: Record<string, string> = {}) {
  const getSetting = vi.fn(async (name: string) => values[name])
  return {
    settings: {
      get: async <T,>(name: string): Promise<T | undefined> =>
        getSetting(name) as Promise<T | undefined>,
    },
    getSetting,
  }
}

function mockContext(initial: Record<string, string> = {}, options: {
  previousPost?: any
  recentPosts?: any[]
  settings?: Record<string, string>
} = {}) {
  const store = new Map(Object.entries(initial))
  const redis = {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string, opts?: { nx?: boolean }) => {
      if (opts?.nx && store.has(key)) return ''
      store.set(key, value)
      return 'OK'
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key)
    }),
  }
  const previousPost = options.previousPost ?? {
    id: 't3_old',
    title: 'April 2026 Confirmed Trade Thread',
    permalink: 'https://reddit.test/old',
    stickied: true,
    locked: false,
    removed: false,
    spam: false,
    archived: false,
    unsticky: vi.fn(async () => undefined),
    lock: vi.fn(async () => undefined),
  }
  const newPost = {
    id: 't3_new',
    permalink: 'https://reddit.test/new',
    setSuggestedCommentSort: vi.fn(async () => undefined),
    sticky: vi.fn(async () => undefined),
  }
  const settings = mockSettings(options.settings)
  const reddit = {
    getCurrentSubreddit: vi.fn(async () => ({ name: 'PlasticModelExchange' })),
    getPostById: vi.fn(async () => previousPost),
    getAppUser: vi.fn(async () => ({ id: 't2_bot', username: 'swap-conf-bot' })),
    getPostsByUser: vi.fn(() => ({
      all: vi.fn(async () => options.recentPosts ?? []),
    })),
    submitPost: vi.fn(async () => newPost),
    modMail: {
      createConversation: vi.fn(async () => undefined),
    },
  }
  return {
    ctx: { redis, reddit, settings: settings.settings },
    store,
    redis,
    reddit,
    previousPost,
    newPost,
    getSetting: settings.getSetting,
  }
}

describe('processMonthlyPost', () => {
  it('creates a monthly post, locks the previous post, and stores currentMonthlyPost', async () => {
    const { ctx, store, reddit, previousPost, newPost } = mockContext({
      currentMonthlyPost: 't3_old',
    }, {
      settings: {
        monthly_post_title: '%B %Y Trades',
        monthly_post: 'Hello {subreddit_name}, previous {previous_month_submission.title}, bot {bot_name}, keyword {confirmation_keyword}',
        monthly_post_flair_id: 'flair-monthly',
      },
    })

    await expect(processMonthlyPost(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ status: 'created', postId: 't3_new' })

    expect(reddit.submitPost).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      title: 'May 2026 Trades',
      text: 'Hello PlasticModelExchange, previous April 2026 Confirmed Trade Thread, bot swap-conf-bot, keyword confirmed',
      sendreplies: false,
      flairId: 'flair-monthly',
    })
    expect(newPost.setSuggestedCommentSort).toHaveBeenCalledWith('NEW')
    expect(previousPost.unsticky).toHaveBeenCalledOnce()
    expect(previousPost.lock).toHaveBeenCalledOnce()
    expect(newPost.sticky).toHaveBeenCalledOnce()
    expect(store.get('currentMonthlyPost')).toBe('t3_new')
    expect(reddit.modMail.createConversation).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      subject: 'Monthly thread is up',
      body: 'Monthly trade-confirmation thread is live: https://reddit.test/new',
      to: null,
    })
    expect(store.get('monthlyPostClaim:plasticmodelexchange:2026-05')).toBeUndefined()
  })

  it('does not submit when another invocation owns the monthly claim', async () => {
    const { ctx, reddit } = mockContext({
      'monthlyPostClaim:plasticmodelexchange:2026-05': '1',
    })

    await expect(processMonthlyPost(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ status: 'skipped_claimed' })

    expect(reddit.submitPost).not.toHaveBeenCalled()
  })

  it('reuses an existing bot post for the same month', async () => {
    const existingPost = {
      id: 't3_existing',
      title: 'May 2026 Confirmed Trade Thread',
      subredditName: 'PlasticModelExchange',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      permalink: 'https://reddit.test/existing',
      stickied: false,
      locked: false,
      removed: false,
      spam: false,
      archived: false,
      sticky: vi.fn(async () => undefined),
      unsticky: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    }
    const { ctx, store, reddit } = mockContext({}, { recentPosts: [existingPost] })

    await expect(processMonthlyPost(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ status: 'reused', postId: 't3_existing' })

    expect(reddit.submitPost).not.toHaveBeenCalled()
    expect(existingPost.sticky).toHaveBeenCalledOnce()
    expect(store.get('currentMonthlyPost')).toBe('t3_existing')
  })

  it('creates a monthly post when the stored previous post is no longer readable', async () => {
    const { ctx, store, reddit } = mockContext({
      currentMonthlyPost: 't3_deleted',
    })
    reddit.getPostById.mockRejectedValueOnce(new Error('not found'))

    await expect(processMonthlyPost(ctx, { clock: fixedClock() }))
      .resolves.toEqual({ status: 'created', postId: 't3_new' })

    expect(reddit.submitPost).toHaveBeenCalledWith(expect.objectContaining({
      title: 'May 2026 Confirmed Trade Thread',
      text: expect.stringContaining('Previous monthly thread'),
    }))
    expect(store.get('currentMonthlyPost')).toBe('t3_new')
  })
})

describe('MONTHLY_POST_JOB', () => {
  it('uses the remote main job name', () => {
    expect(MONTHLY_POST_JOB).toBe('monthly-post')
  })
})
