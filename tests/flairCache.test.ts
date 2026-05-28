import { describe, expect, it, vi } from 'vitest'
import { loadFlairTemplates, refreshFlairTemplateCache } from '../src/flairCache'

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
  templates?: Array<{ id: string; text: string; modOnly?: boolean }>
  settings?: Record<string, string>
} = {}) {
  const redis = mockRedis(options.initial ?? {})
  const getUserFlairTemplates = vi.fn(async () => options.templates ?? [])
  const sub = { getUserFlairTemplates }
  const settings = options.settings ?? {}
  const ctx = {
    redis: redis.api,
    settings: { get: vi.fn(async (name: string) => settings[name]) },
    reddit: {
      getSubredditByName: vi.fn(async () => sub),
    },
  }
  return { ctx: ctx as any, redis, getUserFlairTemplates }
}

describe('loadFlairTemplates', () => {
  it('returns parsed templates on cache hit without hitting Reddit', async () => {
    const cached = JSON.stringify([
      { min: 0, max: 99, id: 'tpl-a', template: 'Trades: 0-99', modOnly: false },
      { min: 100, max: 999, id: 'tpl-b', template: 'Trades: 100-999', modOnly: false },
    ])
    const { ctx, getUserFlairTemplates } = mockContext({
      initial: { 'flairTemplates:plasticmodelexchange:Trades%3A': cached },
    })

    const result = await loadFlairTemplates(ctx, 'PlasticModelExchange')

    expect(result.size).toBe(2)
    expect(getUserFlairTemplates).not.toHaveBeenCalled()
  })

  it('refreshes the cache when the cached JSON is malformed', async () => {
    const { ctx, redis, getUserFlairTemplates } = mockContext({
      initial: { 'flairTemplates:plasticmodelexchange:Trades%3A': 'not json' },
      templates: [{ id: 'tpl-a', text: 'Trades: 0-99', modOnly: false }],
    })

    const result = await loadFlairTemplates(ctx, 'PlasticModelExchange')

    expect(result.size).toBe(1)
    expect(getUserFlairTemplates).toHaveBeenCalledOnce()
    expect(redis.store.get('flairTemplates:plasticmodelexchange:Trades%3A')).not.toBe('not json')
  })

  it('refreshes the cache when cached entries are missing required fields', async () => {
    const cached = JSON.stringify([{ min: 0, max: 99, id: 'tpl-a' }])
    const { ctx, getUserFlairTemplates } = mockContext({
      initial: { 'flairTemplates:plasticmodelexchange:Trades%3A': cached },
      templates: [{ id: 'tpl-a', text: 'Trades: 0-99', modOnly: false }],
    })

    await loadFlairTemplates(ctx, 'PlasticModelExchange')

    expect(getUserFlairTemplates).toHaveBeenCalledOnce()
  })

  it('refreshes the cache when nothing is cached', async () => {
    const { ctx, getUserFlairTemplates } = mockContext({
      templates: [{ id: 'tpl-a', text: 'Trades: 0-99', modOnly: false }],
    })

    await loadFlairTemplates(ctx, 'PlasticModelExchange')

    expect(getUserFlairTemplates).toHaveBeenCalledOnce()
  })
})

describe('refreshFlairTemplateCache', () => {
  it('skips templates that do not match the Trades range pattern', async () => {
    const { ctx, redis } = mockContext({
      templates: [
        { id: 'tpl-a', text: 'Trades: 0-99', modOnly: false },
        { id: 'tpl-b', text: 'Helpful contributor', modOnly: false },
        { id: 'tpl-c', text: 'Trades: 100-999', modOnly: true },
      ],
    })

    const result = await refreshFlairTemplateCache(ctx, 'PlasticModelExchange')

    expect(result.size).toBe(2)
    const stored = JSON.parse(redis.store.get('flairTemplates:plasticmodelexchange:Trades%3A') ?? '[]')
    expect(stored).toHaveLength(2)
    expect(stored.map((t: any) => t.id)).toEqual(['tpl-a', 'tpl-c'])
  })

  it('defaults modOnly to false when the template omits the flag', async () => {
    const { ctx, redis } = mockContext({
      templates: [{ id: 'tpl-a', text: 'Trades: 0-99' }],
    })

    await refreshFlairTemplateCache(ctx, 'PlasticModelExchange')

    const stored = JSON.parse(redis.store.get('flairTemplates:plasticmodelexchange:Trades%3A') ?? '[]')
    expect(stored[0].modOnly).toBe(false)
  })

  it('lowercases the subreddit name in the cache key', async () => {
    const { ctx, redis } = mockContext({
      templates: [{ id: 'tpl-a', text: 'Trades: 0-99', modOnly: false }],
    })

    await refreshFlairTemplateCache(ctx, 'PlasticModelExchange')

    expect(redis.store.has('flairTemplates:plasticmodelexchange:Trades%3A')).toBe(true)
  })

  it('matches the configured flair count label', async () => {
    const { ctx, redis } = mockContext({
      settings: { flair_count_label: 'Negocios:' },
      templates: [
        { id: 'tpl-es', text: 'Negocios: 0-99', modOnly: false },
        { id: 'tpl-en', text: 'Trades: 0-99', modOnly: false },
      ],
    })

    const result = await refreshFlairTemplateCache(ctx, 'PlasticModelExchange')

    expect(result.size).toBe(1)
    const stored = JSON.parse(redis.store.get('flairTemplates:plasticmodelexchange:Negocios%3A') ?? '[]')
    expect(stored.map((t: any) => t.id)).toEqual(['tpl-es'])
  })

  it('writes the cache under a key namespaced by the configured label', async () => {
    const { ctx, redis } = mockContext({
      settings: { flair_count_label: 'Negocios:' },
      templates: [{ id: 'tpl-es', text: 'Negocios: 0-99', modOnly: false }],
    })

    await refreshFlairTemplateCache(ctx, 'PlasticModelExchange')

    expect(redis.store.has('flairTemplates:plasticmodelexchange:Negocios%3A')).toBe(true)
    expect(redis.store.has('flairTemplates:plasticmodelexchange:Trades%3A')).toBe(false)
  })
})

describe('cache invalidation on label change', () => {
  it('treats a label change as a cache miss and refreshes from Reddit', async () => {
    const staleCache = JSON.stringify([
      { min: 0, max: 99, id: 'tpl-old', template: 'Trades: 0-99', modOnly: false },
    ])
    const { ctx, redis, getUserFlairTemplates } = mockContext({
      initial: { 'flairTemplates:plasticmodelexchange:Trades%3A': staleCache },
      settings: { flair_count_label: 'Negocios:' },
      templates: [{ id: 'tpl-new', text: 'Negocios: 0-99', modOnly: false }],
    })

    const result = await loadFlairTemplates(ctx, 'PlasticModelExchange')

    expect(getUserFlairTemplates).toHaveBeenCalledOnce()
    const fresh = redis.store.get('flairTemplates:plasticmodelexchange:Negocios%3A')
    expect(fresh).toBeDefined()
    expect(JSON.parse(fresh!).map((t: any) => t.id)).toEqual(['tpl-new'])
    expect([...result.values()].map(t => t.id)).toEqual(['tpl-new'])
  })

  it('keeps the cache under the old key untouched (it TTLs out)', async () => {
    const staleCache = JSON.stringify([
      { min: 0, max: 99, id: 'tpl-old', template: 'Trades: 0-99', modOnly: false },
    ])
    const { ctx, redis } = mockContext({
      initial: { 'flairTemplates:plasticmodelexchange:Trades%3A': staleCache },
      settings: { flair_count_label: 'Negocios:' },
      templates: [{ id: 'tpl-new', text: 'Negocios: 0-99', modOnly: false }],
    })

    await loadFlairTemplates(ctx, 'PlasticModelExchange')

    expect(redis.store.get('flairTemplates:plasticmodelexchange:Trades%3A')).toBe(staleCache)
  })

  it('hits the cache again after the label-change refresh', async () => {
    const { ctx, getUserFlairTemplates } = mockContext({
      settings: { flair_count_label: 'Negocios:' },
      templates: [{ id: 'tpl-new', text: 'Negocios: 0-99', modOnly: false }],
    })

    await loadFlairTemplates(ctx, 'PlasticModelExchange')
    await loadFlairTemplates(ctx, 'PlasticModelExchange')

    expect(getUserFlairTemplates).toHaveBeenCalledOnce()
  })
})
