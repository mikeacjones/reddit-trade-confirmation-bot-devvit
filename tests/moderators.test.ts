import { describe, expect, it, vi } from 'vitest'
import { isUserModerator, onModAction, refreshModeratorCache } from '../src/moderators'

function mockRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    api: {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value)
        return true
      }),
    },
  }
}

function mockContext(options: {
  initial?: Record<string, string>
  moderators?: Array<{ username: string }>
  subredditName?: string
} = {}) {
  const redis = mockRedis(options.initial ?? {})
  const all = vi.fn(async () => options.moderators ?? [])
  const sub = { getModerators: vi.fn(() => ({ all })) }
  const ctx = {
    redis: redis.api,
    reddit: {
      getCurrentSubreddit: vi.fn(async () => ({ name: options.subredditName ?? 'PlasticModelExchange' })),
      getSubredditByName: vi.fn(async () => sub),
    },
  }
  return { ctx: ctx as any, redis, getModeratorsAll: all }
}

describe('refreshModeratorCache', () => {
  it('lowercases, filters, and sorts moderator usernames before caching', async () => {
    const { ctx, redis } = mockContext({
      moderators: [
        { username: 'Zelda' },
        { username: 'alice' },
        { username: '' },
        { username: 'Bob' },
      ],
    })

    const result = await refreshModeratorCache(ctx, 'PlasticModelExchange')

    expect([...result]).toEqual(['alice', 'bob', 'zelda'])
    const stored = JSON.parse(redis.store.get('moderators') ?? '{}')
    expect(stored.usernames).toEqual(['alice', 'bob', 'zelda'])
    expect(stored.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('isUserModerator', () => {
  it('returns false when subreddit or username is empty', async () => {
    const { ctx, getModeratorsAll } = mockContext()

    expect(await isUserModerator(ctx, '', 'alice')).toBe(false)
    expect(await isUserModerator(ctx, 'PlasticModelExchange', '')).toBe(false)
    expect(getModeratorsAll).not.toHaveBeenCalled()
  })

  it('uses the cache when it is valid and current', async () => {
    const cached = JSON.stringify({
      usernames: ['alice', 'bob'],
      syncedAt: '2026-05-08T00:00:00.000Z',
    })
    const { ctx, getModeratorsAll } = mockContext({
      initial: { moderators: cached },
    })

    expect(await isUserModerator(ctx, 'PlasticModelExchange', 'ALICE')).toBe(true)
    expect(await isUserModerator(ctx, 'PlasticModelExchange', 'carol')).toBe(false)
    expect(getModeratorsAll).not.toHaveBeenCalled()
  })

  it('refreshes from Reddit when the cache is missing', async () => {
    const { ctx, getModeratorsAll } = mockContext({
      moderators: [{ username: 'Alice' }],
    })

    expect(await isUserModerator(ctx, 'PlasticModelExchange', 'alice')).toBe(true)
    expect(getModeratorsAll).toHaveBeenCalledOnce()
  })

  it('refreshes from Reddit when the cached payload is malformed', async () => {
    const { ctx, getModeratorsAll } = mockContext({
      initial: { moderators: '{"usernames": [42]}' },
      moderators: [{ username: 'alice' }],
    })

    expect(await isUserModerator(ctx, 'PlasticModelExchange', 'alice')).toBe(true)
    expect(getModeratorsAll).toHaveBeenCalledOnce()
  })
})

describe('onModAction', () => {
  it('refreshes the cache when a membership-changing action fires', async () => {
    const { ctx, redis, getModeratorsAll } = mockContext({
      moderators: [{ username: 'alice' }],
    })

    await onModAction(
      { action: 'addmoderator', subreddit: { name: 'PlasticModelExchange' } } as any,
      ctx,
    )

    expect(getModeratorsAll).toHaveBeenCalledOnce()
    const stored = JSON.parse(redis.store.get('moderators') ?? '{}')
    expect(stored.usernames).toEqual(['alice'])
  })

  it('ignores non-membership actions', async () => {
    const { ctx, getModeratorsAll } = mockContext()

    await onModAction({ action: 'banuser' } as any, ctx)

    expect(getModeratorsAll).not.toHaveBeenCalled()
  })

  it('ignores events with no action set', async () => {
    const { ctx, getModeratorsAll } = mockContext()

    await onModAction({} as any, ctx)

    expect(getModeratorsAll).not.toHaveBeenCalled()
  })

  it('falls back to getCurrentSubreddit when the event omits the subreddit name', async () => {
    const { ctx, getModeratorsAll } = mockContext({
      moderators: [{ username: 'alice' }],
    })

    await onModAction({ action: 'removemoderator' } as any, ctx)

    expect(ctx.reddit.getCurrentSubreddit).toHaveBeenCalled()
    expect(getModeratorsAll).toHaveBeenCalledOnce()
  })
})
