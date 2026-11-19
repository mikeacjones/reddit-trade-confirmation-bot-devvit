/**
 * Adversarial audit of the Discord new-post notification as the app runs it (the `PostSubmit`
 * trigger registered by src/main.ts): bad or blank webhook settings, hostile post content in the
 * outgoing request, and a webhook that answers with errors or throws. `fetch` is always a stub;
 * no real webhook is ever called.
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG:` comment. This audit does not fix src/.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const WEBHOOK = 'https://discord.com/api/webhooks/123456/secret-token_AbC-9'
const WEBHOOK_SETTING = 'mod_new_post_discord_webhook'
const JSON_SETTING = 'mod_new_post_discord_include_json'


type Mocks = Parameters<typeof newApp>[0]

/**
 * One test per row, titled with the row's first cell. `test.for` does not hand the Devvit fixtures
 * to the test body, so the rows are expanded here instead.
 */
function each<T extends readonly [string | number, ...unknown[]]>(
  rows: readonly T[],
  title: string,
  run: (row: T, mocks: Mocks) => Promise<void>,
): void {
  for (const row of rows) test(title.replace('%s', String(row[0])), ({ mocks }) => run(row, mocks))
}

type Fetch = ReturnType<typeof stubFetch>

function stubFetch(impl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown> | unknown = () => new Response('{"attachments":[]}', { status: 200 })) {
  const spy = vi.fn(async (url: string, init: never) => impl(url, init))
  vi.stubGlobal('fetch', spy)
  return spy
}

function postEvent(overrides: { post?: Record<string, unknown>; author?: Record<string, unknown> | null } = {}) {
  return {
    post: {
      id: 't3_new',
      title: 'WTS: kit',
      selftext: 'body text',
      permalink: '/r/swaps/comments/new/wts_kit/',
      url: 'https://www.reddit.com/r/swaps/comments/new/wts_kit/',
      isSelf: true,
      createdAt: 1_700_000_000_000,
      ...overrides.post,
    },
    author: overrides.author === null ? undefined : { name: 'alice', id: 't2_alice', ...overrides.author },
    subreddit: { name: 'swaps', id: 't5_swaps' },
  }
}

function sentCard(fetchSpy: Fetch): { text: string; message: Record<string, any> } {
  const init = fetchSpy.mock.calls[0][1] as unknown as { body: string }
  const message = JSON.parse(init.body)
  const text = JSON.stringify(message.components, null, 1)
  return { text, message }
}

function allWarnings(warn: { mock: { calls: unknown[][] } }): string {
  return warn.mock.calls.map(call => call.map(String).join(' ')).join('\n')
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function configured(mocks: Parameters<typeof newApp>[0], value: string = WEBHOOK): AppHarness {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  mocks.settings.put(WEBHOOK_SETTING, value)
  return app
}

describe('malformed webhook settings', () => {
  each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
  ] as const, '%s means "off": no request, no warning', async ([, value], mocks) => {
    const app = configured(mocks, value)
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', postEvent())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  test('an unset webhook setting uses the blank default and sends nothing', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', postEvent())

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  each([
    ['not a URL', 'hello world'],
    ['plain http', 'http://discord.com/api/webhooks/123/abc'],
    ['a look-alike host', 'https://discord.com.evil.example/api/webhooks/123/abc'],
    ['credentials that point at another host', 'https://discord.com@evil.example/api/webhooks/123/abc'],
    ['another host with the Discord URL in its path', 'https://evil.example/https://discord.com/api/webhooks/123/abc'],
    ['a channel link, not a webhook', 'https://discord.com/channels/1/2'],
    ['a webhook without a token', 'https://discord.com/api/webhooks/123'],
    ['a non-numeric webhook id', 'https://discord.com/api/webhooks/abc/def'],
    ['a URL with a space in it', 'https://discord.com/api/webhooks/123/ab c'],
  ] as const, '%s is refused: no request, one warning, no crash', async ([, value], mocks) => {
    const app = configured(mocks, value)
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', postEvent())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(allWarnings(warn)).toContain('not a valid Discord webhook URL')
  })

  test('a valid URL padded with whitespace is trimmed and normalised before it is called', async ({ mocks }) => {
    const app = configured(mocks, `  https://discordapp.com/api/webhooks/123456/tok#frag\n`)
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', postEvent())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://discord.com/api/webhooks/123456/tok?with_components=true&wait=true')
  })

  test('only the exact app-owned query is sent: a pasted ?wait=false or with_components=false is overridden', async ({ mocks }) => {
    const app = configured(mocks, `${WEBHOOK}?wait=false&with_components=false`)
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', postEvent())

    expect(new URL(fetchSpy.mock.calls[0][0]).searchParams.get('wait')).toBe('true')
    expect(new URL(fetchSpy.mock.calls[0][0]).searchParams.get('with_components')).toBe('true')
  })

  test('a PostSubmit without a post, or with a post that has no id, sends nothing', async ({ mocks }) => {
    const app = configured(mocks)
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', { subreddit: { name: 'swaps' } })
    await app.fireTrigger('PostSubmit', postEvent({ post: { id: '' } }))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  test('the include-JSON setting switches the request to multipart and back', async ({ mocks }) => {
    const app = configured(mocks)
    const fetchSpy = stubFetch()

    mocks.settings.put(JSON_SETTING, true)
    await app.fireTrigger('PostSubmit', postEvent())
    mocks.settings.put(JSON_SETTING, false)
    await app.fireTrigger('PostSubmit', postEvent())

    const types = fetchSpy.mock.calls.map(call => (call[1] as unknown as { headers: Record<string, string> }).headers['Content-Type'])
    expect(types[0]).toMatch(/^multipart\/form-data; boundary=/)
    expect(types[1]).toBe('application/json')
  })
})

describe('the outgoing request for hostile post content', () => {
  test('a title, body and author full of mentions send an empty allowed_mentions and escaped markup', async ({ mocks }) => {
    const app = configured(mocks)
    app.reddit.addUser('every_one')
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', postEvent({
      post: { title: '@everyone @here <@1> **WTS**', selftext: '@everyone `code` <@&2>', linkFlair: { text: '@here `x`' } },
      author: { name: 'every_one' },
    }))

    const { message, text } = sentCard(fetchSpy)
    expect(message.allowed_mentions).toEqual({ parse: [] })
    expect(text).toContain('\\\\<@1\\\\>')
    expect(text).toContain('every\\\\_one')
  })

  test('a 5,000 character title, a 200,000 character body and an emoji-only title give a small valid request', async ({ mocks }) => {
    const app = configured(mocks)
    const fetchSpy = stubFetch()

    await app.fireTrigger('PostSubmit', postEvent({ post: { title: 'T'.repeat(5_000), selftext: 'b'.repeat(200_000) } }))
    await app.fireTrigger('PostSubmit', postEvent({ post: { title: '🚀🚀🚀', selftext: '' } }))

    const first = JSON.parse((fetchSpy.mock.calls[0][1] as unknown as { body: string }).body)
    expect(JSON.stringify(first).length).toBeLessThan(4_000)
    const second = JSON.parse((fetchSpy.mock.calls[1][1] as unknown as { body: string }).body)
    expect(JSON.stringify(second)).toContain('🚀🚀🚀')
  })

  test('the stored trade count and flair of the author are shown; a malformed stored count is ignored', async ({ mocks }) => {
    const app = configured(mocks)
    app.reddit.addUser('alice', { linkKarma: 1_234, commentKarma: 56 })
    app.reddit.setFlair('alice', 'Trades: 4')
    const fetchSpy = stubFetch()

    await app.ctx.redis.set('confirmations:alice', 'garbage')
    await app.fireTrigger('PostSubmit', postEvent())
    await app.ctx.redis.set('confirmations:alice', '12')
    await app.fireTrigger('PostSubmit', postEvent())

    expect(sentCard(fetchSpy).text).toContain('**4** confirmed trades')
    expect(JSON.stringify(JSON.parse((fetchSpy.mock.calls[1][1] as unknown as { body: string }).body))).toContain('**12** confirmed trades')
  })

  test('the Reddit profile lookup failing, or the user being unknown, still sends the notification', async ({ mocks }) => {
    const app = configured(mocks)
    const fetchSpy = stubFetch()

    app.reddit.failNext('getUserByUsername', '503 Service Unavailable')
    await app.fireTrigger('PostSubmit', postEvent())
    await app.fireTrigger('PostSubmit', postEvent({ author: { name: 'nobody_known' } }))
    await app.fireTrigger('PostSubmit', postEvent({ author: null }))

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(sentCard(fetchSpy).text).toContain('Confirmed trades: **unknown**')
  })
})

describe('a webhook that fails never fails the handler', () => {
  const leak = (fetchSpy: Fetch) => {
    expect(allWarnings(warn)).not.toContain('secret-token_AbC-9')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  }

  each([
    [400, 'Bad Request', '{"message": "Invalid Form Body", "code": 50035}'],
    [401, 'Unauthorized', '{"message": "Invalid Webhook Token", "code": 50027}'],
    [403, 'Forbidden', ''],
    [404, 'Not Found', '{"message": "Unknown Webhook", "code": 10015}'],
    [429, 'Too Many Requests', '{"message": "You are being rate limited.", "retry_after": 1.5, "global": false}'],
    [500, 'Internal Server Error', '<html>oops</html>'],
    [502, 'Bad Gateway', ''],
    [503, 'Service Unavailable', 'x'.repeat(100_000)],
  ] as const, 'HTTP %i is logged without the token and the handler resolves', async ([status, statusText, text], mocks) => {
    const app = configured(mocks)
    const fetchSpy = stubFetch(() => new Response(text === '' ? null : String(text), { status, statusText }))

    await expect(app.fireTrigger('PostSubmit', postEvent())).resolves.toBeUndefined()

    leak(fetchSpy)
    expect(allWarnings(warn)).toContain(String(status))
    expect(allWarnings(warn).length).toBeLessThan(1_000)
  })

  each([
    ['a network error', () => { throw new TypeError('fetch failed') }],
    ['a rejected promise with a string', () => Promise.reject('connection refused')],
    ['an abort', () => { throw new DOMException('The operation was aborted', 'AbortError') }],
    ['a non-error object', () => Promise.reject({ code: 'ECONNRESET' })],
  ] as const, '%s is logged and the handler resolves', async ([, impl], mocks) => {
    const app = configured(mocks)
    const fetchSpy = stubFetch(impl)

    await expect(app.fireTrigger('PostSubmit', postEvent())).resolves.toBeUndefined()

    leak(fetchSpy)
    expect(allWarnings(warn)).toContain('Discord webhook request failed')
  })

  test('a 200 whose body is not JSON, or whose body cannot be read, still counts as sent', async ({ mocks }) => {
    const app = configured(mocks)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    stubFetch(() => new Response('not json', { status: 200 }))
    await expect(app.fireTrigger('PostSubmit', postEvent())).resolves.toBeUndefined()

    stubFetch(() => ({ ok: true, status: 200, statusText: 'OK', json: () => Promise.reject(new Error('stream broke')), text: () => Promise.reject(new Error('stream broke')) }))
    await expect(app.fireTrigger('PostSubmit', postEvent())).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
  })

  test('a failed error-body read on a 4xx is swallowed', async ({ mocks }) => {
    const app = configured(mocks)
    stubFetch(() => ({ ok: false, status: 400, statusText: 'Bad Request', text: () => Promise.reject(new Error('stream broke')) }))

    await expect(app.fireTrigger('PostSubmit', postEvent())).resolves.toBeUndefined()

    expect(allWarnings(warn)).toContain('400')
  })

  test('a failing webhook does not touch trade counting: a confirmation made around it is still counted', async ({ mocks }) => {
    const app = configured(mocks)
    stubFetch(() => new Response('boom', { status: 500 }))
    const { reddit } = app
    await app.ctx.redis.set('currentMonthlyPost', 't3_monthly')
    reddit.addComment({ id: 't1_offer', parentId: 't3_monthly', postId: 't3_monthly', authorName: 'alice', body: 'Sold a kit to u/bob' })
    reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: 't3_monthly', authorName: 'bob', body: 'confirmed' })

    await app.fireTrigger('PostSubmit', postEvent())
    await app.fireTrigger('CommentSubmit', {
      comment: { id: 't1_reply', body: 'confirmed', parentId: 't1_offer', postId: 't3_monthly', permalink: '/r/swaps/comments/monthly/_/reply/' },
      author: { name: 'bob' },
      subreddit: { name: 'swaps' },
    })
    await app.fireTrigger('PostSubmit', postEvent())

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('a webhook that answers 429 is called once per post, not in a retry loop', async ({ mocks }) => {
    const app = configured(mocks)
    const fetchSpy = stubFetch(() => new Response('{"retry_after": 0.1}', { status: 429, headers: { 'Retry-After': '1' } }))

    await app.fireTrigger('PostSubmit', postEvent())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
