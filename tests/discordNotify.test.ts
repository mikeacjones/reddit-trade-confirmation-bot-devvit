import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  absoluteRedditUrl,
  buildDiscordWebhookBody,
  buildRedditNewPostPayload,
  isDiscordWebhookUrl,
  MOD_NEW_POST_DISCORD_WEBHOOK_SETTING,
  normalizeDiscordWebhookUrl,
  onPostSubmit,
  REDDIT_NEW_POST_EVENT,
  truncateText,
  validateDiscordWebhookSetting,
} from '../src/discordNotify'

function sampleEvent(overrides: Record<string, unknown> = {}) {
  return {
    post: {
      id: 't3_abc123',
      title: 'WTS vintage kit',
      selftext: 'Looking to sell a sealed kit. DM me.',
      authorId: 't2_author',
      subredditId: 't5_sub',
      permalink: '/r/PlasticModelExchange/comments/abc123/wts_vintage_kit/',
      url: 'https://www.reddit.com/r/PlasticModelExchange/comments/abc123/wts_vintage_kit/',
      isSelf: true,
      nsfw: false,
      isSpoiler: false,
      createdAt: 1_714_000_000,
      linkFlair: { text: 'WTS' },
      ...(overrides.post as object | undefined),
    },
    author: {
      id: 't2_author',
      name: 'seller42',
      ...(overrides.author as object | undefined),
    },
    subreddit: {
      id: 't5_sub',
      name: 'PlasticModelExchange',
      ...(overrides.subreddit as object | undefined),
    },
  } as any
}

describe('discord webhook helpers', () => {
  it('accepts discord.com and discordapp.com webhook URLs', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/123/abc-def_ghi')).toBe(true)
    expect(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/123/token')).toBe(true)
    expect(isDiscordWebhookUrl('https://example.com/api/webhooks/123/token')).toBe(false)
    expect(isDiscordWebhookUrl('not-a-url')).toBe(false)
  })

  it('normalizes discordapp.com to discord.com', () => {
    expect(normalizeDiscordWebhookUrl('https://discordapp.com/api/webhooks/1/token?wait=true'))
      .toBe('https://discord.com/api/webhooks/1/token')
  })

  it('validates the install setting', () => {
    expect(validateDiscordWebhookSetting('')).toBeUndefined()
    expect(validateDiscordWebhookSetting(undefined)).toBeUndefined()
    expect(validateDiscordWebhookSetting('https://discord.com/api/webhooks/1/token')).toBeUndefined()
    expect(validateDiscordWebhookSetting('https://evil.example/hook')).toMatch(/Discord webhook URL/)
  })

  it('builds absolute reddit URLs and truncates text', () => {
    expect(absoluteRedditUrl('/r/test/comments/1')).toBe('https://www.reddit.com/r/test/comments/1')
    expect(absoluteRedditUrl('https://reddit.com/r/test')).toBe('https://reddit.com/r/test')
    expect(truncateText('abcdef', 5)).toEqual({ text: 'abcd…', truncated: true })
    expect(truncateText('hi', 5)).toEqual({ text: 'hi', truncated: false })
  })
})

describe('buildRedditNewPostPayload', () => {
  it('includes title, author, body, and automation marker fields', () => {
    const payload = buildRedditNewPostPayload(sampleEvent())
    expect(payload).toMatchObject({
      event: REDDIT_NEW_POST_EVENT,
      postId: 't3_abc123',
      title: 'WTS vintage kit',
      author: 'seller42',
      body: 'Looking to sell a sealed kit. DM me.',
      bodyTruncated: false,
      subreddit: 'PlasticModelExchange',
      linkFlair: 'WTS',
      isSelf: true,
    })
    expect(payload?.permalink).toContain('PlasticModelExchange')
    expect(payload?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns null without a post id', () => {
    expect(buildRedditNewPostPayload({} as any)).toBeNull()
  })
})

describe('buildDiscordWebhookBody', () => {
  it('embeds human-readable fields and a parseable json block', () => {
    const payload = buildRedditNewPostPayload(sampleEvent())!
    const body = buildDiscordWebhookBody(payload)
    expect(body.content).toContain(REDDIT_NEW_POST_EVENT)
    expect(body.content).toContain('```json')
    expect(body.content).toContain('"title": "WTS vintage kit"')
    expect(body.content).toContain('"author": "seller42"')
    expect(body.embeds[0]?.title).toBe('WTS vintage kit')
    expect(body.embeds[0]?.description).toContain('Looking to sell')
    expect(body.allowed_mentions).toEqual({ parse: [] })
  })
})

describe('onPostSubmit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('no-ops when webhook setting is blank', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = {
      settings: { get: vi.fn(async () => '') },
    }

    await onPostSubmit(sampleEvent(), ctx as any)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts a formatted webhook payload when configured', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 204,
      statusText: 'No Content',
      text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = {
      settings: {
        get: vi.fn(async (name: string) => {
          if (name === MOD_NEW_POST_DISCORD_WEBHOOK_SETTING) {
            return 'https://discordapp.com/api/webhooks/99/secret-token'
          }
          return undefined
        }),
      },
    }

    await onPostSubmit(sampleEvent(), ctx as any)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://discord.com/api/webhooks/99/secret-token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    const sent = JSON.parse(init.body)
    expect(sent.content).toContain('"event": "reddit.new_post"')
    expect(sent.embeds[0].author.name).toBe('u/seller42')
    expect(sent.embeds[0].description).toContain('Looking to sell')
  })

  it('logs and swallows non-OK webhook responses', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'Unknown Webhook',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = {
      settings: {
        get: vi.fn(async () => 'https://discord.com/api/webhooks/1/token'),
      },
    }

    await onPostSubmit(sampleEvent(), ctx as any)

    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('404')
  })
})
