import { afterEach, describe, expect, it, vi } from 'vitest'
import { adjustUserTradeCount, onMonthlyPost } from '../src/handlers'

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

function mockMonthlyContext(initial: Record<string, string> = {}) {
  const redis = mockRedis(initial)
  const previousPost = {
    id: 't3_old',
    title: 'April Confirmed Trade Thread',
    permalink: 'https://reddit.test/r/PlasticModelExchange/comments/old',
    stickied: true,
    locked: false,
    unsticky: vi.fn(async () => undefined),
    lock: vi.fn(async () => undefined),
  }
  const newPost = {
    id: 't3_new',
    permalink: 'https://reddit.test/r/PlasticModelExchange/comments/new',
    setSuggestedCommentSort: vi.fn(async () => undefined),
    sticky: vi.fn(async () => undefined),
  }
  const submitPost = vi.fn(async () => newPost)
  const ctx = {
    redis: redis.api,
    settings: {
      get: vi.fn(async () => undefined),
    },
    reddit: {
      getCurrentSubreddit: vi.fn(async () => ({ name: 'PlasticModelExchange' })),
      getPostById: vi.fn(async () => previousPost),
      getAppUser: vi.fn(async () => ({ id: 't2_bot', username: 'swap-conf-bot' })),
      getPostsByUser: vi.fn(() => ({
        all: vi.fn(async () => []),
      })),
      submitPost,
      modMail: {
        createConversation: vi.fn(async () => undefined),
      },
    },
  }
  return { ctx: ctx as any, redis, previousPost, newPost, submitPost }
}

afterEach(() => {
  vi.useRealTimers()
})

function mockContext(options: {
  existingFlair?: string | null
  setUserFlair?: any
  moderators?: string[]
}) {
  const subredditName = 'PlasticModelExchange'
  const redis = mockRedis({
    'flairTemplates:plasticmodelexchange': JSON.stringify([
      { min: 0, max: 99, id: 'tpl-user', template: 'Trades: 0-99', modOnly: false },
      { min: 0, max: 99999, id: 'tpl-mod', template: 'Moderator | Trades: 0-99999', modOnly: true },
    ]),
    moderators: JSON.stringify({
      usernames: options.moderators ?? [],
      syncedAt: '2026-05-08T00:00:00.000Z',
    }),
    'confirmations:alice': '4',
  })
  const setUserFlair = options.setUserFlair ?? vi.fn(async () => undefined)
  const sub = {
    getUserFlair: vi.fn(async () => ({
      users: options.existingFlair === null ? [] : [{ flairText: options.existingFlair ?? 'Trades: 4' }],
    })),
  }
  const ctx = {
    redis: redis.api,
    reddit: {
      getCurrentSubreddit: vi.fn(async () => ({ name: subredditName })),
      getSubredditByName: vi.fn(async () => sub),
      setUserFlair,
    },
  }
  return { ctx: ctx as any, redis, setUserFlair }
}

describe('adjustUserTradeCount', () => {
  it('sets Redis count and user flair for a manual adjustment', async () => {
    const { ctx, redis, setUserFlair } = mockContext({})

    const result = await adjustUserTradeCount(ctx, 'u/Alice', 7)

    expect(result).toEqual({
      username: 'Alice',
      count: 7,
      oldFlair: 'Trades: 4',
      newFlair: 'Trades: 7',
    })
    expect(redis.store.get('confirmations:alice')).toBe('7')
    expect(setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'Alice',
      text: 'Trades: 7',
      flairTemplateId: 'tpl-user',
    })
  })

  it('uses the moderator flair template for cached moderators', async () => {
    const { ctx, setUserFlair } = mockContext({ moderators: ['alice'] })

    await adjustUserTradeCount(ctx, '/u/alice', 12)

    expect(setUserFlair).toHaveBeenCalledWith(expect.objectContaining({
      flairTemplateId: 'tpl-mod',
      text: 'Moderator | Trades: 12',
      username: 'alice',
    }))
  })

  it('rolls back the Redis count when Reddit rejects the flair write', async () => {
    const { ctx, redis } = mockContext({
      setUserFlair: vi.fn(async () => {
        throw new Error('reddit write failed')
      }),
    })

    await expect(adjustUserTradeCount(ctx, 'Alice', 8)).rejects.toThrow('reddit write failed')

    expect(redis.store.get('confirmations:alice')).toBe('4')
  })
})

describe('onMonthlyPost', () => {
  it('creates a new monthly post and locks the previous monthly post', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)))
    const { ctx, redis, previousPost, newPost, submitPost } = mockMonthlyContext({
      currentMonthlyPost: 't3_old',
    })

    await onMonthlyPost(undefined as any, ctx)

    expect(submitPost).toHaveBeenCalledOnce()
    expect(previousPost.unsticky).toHaveBeenCalledOnce()
    expect(previousPost.lock).toHaveBeenCalledOnce()
    expect(newPost.setSuggestedCommentSort).toHaveBeenCalledWith('NEW')
    expect(newPost.sticky).toHaveBeenCalledOnce()
    expect(redis.store.get('currentMonthlyPost')).toBe('t3_new')
  })

  it('does not submit when another monthly-post invocation owns the claim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)))
    const { ctx, submitPost } = mockMonthlyContext({
      'monthlyPostClaim:plasticmodelexchange:2026-05': '1',
    })

    await onMonthlyPost(undefined as any, ctx)

    expect(submitPost).not.toHaveBeenCalled()
  })
})
