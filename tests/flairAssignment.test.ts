import { describe, expect, it, vi } from 'vitest'
import { setUserFlairWithFallback, trySetUserFlairWithFallback } from '../src/flairAssignment'

function mockRedis() {
  const store = new Map<string, string>()
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

function mockContext(options: { setUserFlair?: any; setUserFlairBatch?: any } = {}) {
  const redis = mockRedis()
  const setUserFlair = options.setUserFlair ?? vi.fn(async () => undefined)
  const setUserFlairBatch = options.setUserFlairBatch ?? vi.fn(async () => [{ ok: true }])
  const ctx = {
    redis: redis.api,
    reddit: { setUserFlair, setUserFlairBatch },
  }
  return { ctx: ctx as any, setUserFlair, setUserFlairBatch }
}

const flairOptions = {
  subredditName: 'PlasticModelExchange',
  username: 'alice',
  text: 'Trades: 5',
  flairTemplateId: 'tpl-a',
}

describe('setUserFlairWithFallback', () => {
  it('calls setUserFlair once on the happy path', async () => {
    const { ctx, setUserFlair, setUserFlairBatch } = mockContext()

    await setUserFlairWithFallback(ctx, flairOptions, 'set flair')

    expect(setUserFlair).toHaveBeenCalledOnce()
    expect(setUserFlairBatch).not.toHaveBeenCalled()
  })

  it('rethrows non-404 errors without falling back', async () => {
    const { ctx, setUserFlairBatch } = mockContext({
      setUserFlair: vi.fn(async () => {
        throw new Error('reddit 500 server error')
      }),
    })

    await expect(setUserFlairWithFallback(ctx, flairOptions, 'set flair')).rejects.toThrow('500')
    expect(setUserFlairBatch).not.toHaveBeenCalled()
  })

  it('falls back to flaircsv on 404 and re-applies the template flair after success', async () => {
    const setUserFlair = vi.fn()
      .mockRejectedValueOnce(new Error('http status 404 Not Found'))
      .mockResolvedValueOnce(undefined)
    const { ctx, setUserFlairBatch } = mockContext({ setUserFlair })

    await setUserFlairWithFallback(ctx, flairOptions, 'set flair')

    expect(setUserFlair).toHaveBeenCalledTimes(2)
    expect(setUserFlairBatch).toHaveBeenCalledWith('PlasticModelExchange', [expect.objectContaining({
      username: 'alice',
      text: 'Trades: 5',
    })])
  })

  it('throws when flaircsv reports the user could not be flaired', async () => {
    const setUserFlair = vi.fn(async () => {
      throw new Error('http status 404 Not Found')
    })
    const { ctx } = mockContext({
      setUserFlair,
      setUserFlairBatch: vi.fn(async () => [{ ok: false, errors: { user: 'not found' } }]),
    })

    await expect(setUserFlairWithFallback(ctx, flairOptions, 'set flair')).rejects.toThrow('flaircsv failed')
  })

  it('throws when flaircsv returns no result row for the user', async () => {
    const setUserFlair = vi.fn(async () => {
      throw new Error('http status 404 Not Found')
    })
    const { ctx } = mockContext({
      setUserFlair,
      setUserFlairBatch: vi.fn(async () => []),
    })

    await expect(setUserFlairWithFallback(ctx, flairOptions, 'set flair')).rejects.toThrow('No flaircsv result')
  })

  it('swallows a second 404 after the flaircsv fallback', async () => {
    const setUserFlair = vi.fn(async () => {
      throw new Error('http status 404 Not Found')
    })
    const { ctx, setUserFlairBatch } = mockContext({ setUserFlair })

    await expect(setUserFlairWithFallback(ctx, flairOptions, 'set flair')).resolves.toBeUndefined()

    expect(setUserFlair).toHaveBeenCalledTimes(2)
    expect(setUserFlairBatch).toHaveBeenCalledOnce()
  })

  it('logs a warning but succeeds when flaircsv returns a text warning', async () => {
    const setUserFlair = vi.fn()
      .mockRejectedValueOnce(new Error('http status 404 Not Found'))
      .mockResolvedValueOnce(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { ctx } = mockContext({
      setUserFlair,
      setUserFlairBatch: vi.fn(async () => [{ ok: true, warnings: { text: 'flair too long' } }]),
    })

    await setUserFlairWithFallback(ctx, flairOptions, 'set flair')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('flaircsv warning'))
    warn.mockRestore()
  })
})

describe('trySetUserFlairWithFallback', () => {
  it('returns true on success', async () => {
    const { ctx } = mockContext()
    expect(await trySetUserFlairWithFallback(ctx, flairOptions, 'set flair')).toBe(true)
  })

  it('returns false on failure instead of throwing', async () => {
    const { ctx } = mockContext({
      setUserFlair: vi.fn(async () => {
        throw new Error('reddit 500 server error')
      }),
    })

    expect(await trySetUserFlairWithFallback(ctx, flairOptions, 'set flair')).toBe(false)
  })
})
