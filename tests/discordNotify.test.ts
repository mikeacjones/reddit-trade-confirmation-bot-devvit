import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  absoluteRedditUrl,
  buildDiscordWebhookBody,
  buildDiscordMultipartRequest,
  buildRedditNewPostPayload,
  collectImageUrls,
  discordExecuteUrl,
  EMPTY_AUTHOR_PROFILE,
  formatAccountAge,
  isDiscordWebhookUrl,
  loadAuthorProfile,
  MOD_NEW_POST_DISCORD_INCLUDE_JSON_SETTING,
  MOD_NEW_POST_DISCORD_WEBHOOK_SETTING,
  normalizeDiscordWebhookUrl,
  oldRedditUrl,
  onPostSubmit,
  REDDIT_NEW_POST_ATTACHMENT,
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

type AnyComponent = { type: number; content?: string; components?: AnyComponent[]; [key: string]: unknown }

function flatten(components: AnyComponent[]): AnyComponent[] {
  return components.flatMap(c => [c, ...flatten(c.components ?? [])])
}

function textOf(components: AnyComponent[]): string {
  return flatten(components).filter(c => c.type === 10).map(c => c.content).join('\n')
}

async function parseMultipart(contentType: string, body: string) {
  const form = await new Request('https://discord.test', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  }).formData()
  const file = form.get('files[0]') as File
  return {
    message: JSON.parse(String(form.get('payload_json'))),
    file,
    attachedPayload: JSON.parse(await file.text()),
  }
}

describe('buildDiscordWebhookBody', () => {
  it('sends a Components V2 card with no json by default', () => {
    const payload = buildRedditNewPostPayload(sampleEvent())!
    const body = buildDiscordWebhookBody(payload)
    const components = body.components as AnyComponent[]
    expect(body.flags).toBe(1 << 15)
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(components).toHaveLength(1)
    expect(components[0]).toMatchObject({ type: 17, accent_color: 0xff4500 })
    const text = textOf(components)
    expect(text).toContain('`reddit.new_post`')
    expect(text).toContain('## [WTS vintage kit](https://www.reddit.com/r/PlasticModelExchange/comments/abc123/wts_vintage_kit/)')
    expect(text).toContain('`WTS` [u/seller42](https://www.reddit.com/user/seller42/)')
    expect(flatten(components).some(c => c.type === 10 && c.content === 'Looking to sell a sealed kit. DM me.')).toBe(true)
    expect(body.attachments).toBeUndefined()
  })

  it('adds a row of user links and a row of mod links', () => {
    const payload = buildRedditNewPostPayload(sampleEvent())!
    const rows = flatten(buildDiscordWebhookBody(payload).components as AnyComponent[]).filter(c => c.type === 1)
    const labels = rows.map(row => (row.components ?? []).map(b => b.label))
    expect(labels).toEqual([['Open post', 'Author profile', 'Message author'], ['Remove (old Reddit)', 'Mod queue']])
    const buttons = rows.flatMap(row => row.components ?? [])
    expect(buttons.every(b => b.style === 5 && String(b.url).startsWith('https://'))).toBe(true)
    expect(buttons[2]?.url).toBe('https://www.reddit.com/message/compose/?to=seller42')
    expect(buttons[3]?.url).toBe('https://old.reddit.com/r/PlasticModelExchange/comments/abc123/wts_vintage_kit/')
    expect(buttons[4]?.url).toBe('https://www.reddit.com/r/PlasticModelExchange/about/modqueue/')
  })

  it('attaches the json file and shows it as the last card component when enabled', () => {
    const payload = buildRedditNewPostPayload(sampleEvent())!
    const body = buildDiscordWebhookBody(payload, { includeJson: true })
    expect(body.attachments).toEqual([{ id: 0, filename: REDDIT_NEW_POST_ATTACHMENT, description: REDDIT_NEW_POST_EVENT }])
    expect(body.components).toHaveLength(1)
    const card = (body.components[0] as AnyComponent).components as AnyComponent[]
    expect(card.at(-1)).toEqual({ type: 13, file: { url: `attachment://${REDDIT_NEW_POST_ATTACHMENT}` } })
  })

  it('omits the json file component when disabled', () => {
    const payload = buildRedditNewPostPayload(sampleEvent())!
    const body = buildDiscordWebhookBody(payload)
    expect(flatten(body.components as AnyComponent[]).some(c => c.type === 13)).toBe(false)
  })

  it('escapes markdown in the title link', () => {
    const payload = buildRedditNewPostPayload(sampleEvent({ post: { title: 'WTS [Pelikan] *M800*' } }))!
    const components = buildDiscordWebhookBody(payload).components as AnyComponent[]
    expect(textOf(components)).toContain('## [WTS \\[Pelikan\\] \\*M800\\*](')
  })

  it('shows post images in a media gallery', () => {
    const payload = buildRedditNewPostPayload(sampleEvent({
      post: { galleryImages: ['https://i.redd.it/a.jpg', 'https://i.redd.it/b.jpg'], isImage: false },
    }))!
    const gallery = flatten(buildDiscordWebhookBody(payload).components as AnyComponent[]).find(c => c.type === 12)
    expect(gallery?.items).toEqual([
      { media: { url: 'https://i.redd.it/a.jpg' }, spoiler: false },
      { media: { url: 'https://i.redd.it/b.jpg' }, spoiler: false },
    ])
  })
})

describe('collectImageUrls', () => {
  it('collects https gallery, media, and direct image urls without duplicates', () => {
    expect(collectImageUrls({
      galleryImages: ['https://i.redd.it/a.jpg'],
      mediaUrls: ['https://i.redd.it/a.jpg', 'http://insecure.example/b.png'],
      url: 'https://preview.redd.it/c.png?width=640&amp;format=png',
      isImage: false,
    } as any)).toEqual(['https://i.redd.it/a.jpg', 'https://preview.redd.it/c.png?width=640&format=png'])
  })
})

describe('buildDiscordMultipartRequest', () => {
  it('produces multipart form data with payload_json and the full json file', async () => {
    const longBody = `see \`\`\`code\`\`\` and "quotes" ${'x'.repeat(3000)}`
    const payload = buildRedditNewPostPayload(sampleEvent({ post: { selftext: longBody } }))!
    const body = buildDiscordWebhookBody(payload, { includeJson: true })
    const request = buildDiscordMultipartRequest(body, payload)

    expect(request.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const parsed = await parseMultipart(request.contentType, request.body)
    expect(parsed.message).toEqual(body)
    expect(parsed.file.name).toBe(REDDIT_NEW_POST_ATTACHMENT)
    expect(parsed.attachedPayload).toEqual(payload)
    expect(parsed.attachedPayload.body).toBe(longBody)
  })
})

describe('oldRedditUrl', () => {
  it('rewrites reddit permalinks to old reddit and rejects other hosts', () => {
    expect(oldRedditUrl('https://www.reddit.com/r/x/comments/1/t/')).toBe('https://old.reddit.com/r/x/comments/1/t/')
    expect(oldRedditUrl('https://example.com/r/x')).toBeNull()
    expect(oldRedditUrl('')).toBeNull()
  })
})

describe('discordExecuteUrl', () => {
  it('enables components and waits for Discord to confirm the message', () => {
    expect(discordExecuteUrl('https://discord.com/api/webhooks/1/token'))
      .toBe('https://discord.com/api/webhooks/1/token?with_components=true&wait=true')
  })
})

const sampleProfile = {
  tradeCount: 17,
  flair: 'Trades: 17',
  accountCreatedAt: '2023-01-15T00:00:00.000Z',
  postKarma: 1200,
  commentKarma: 3456,
}

describe('trade-focused card fields', () => {
  it('shows trade count, user flair, account age, and karma', () => {
    const payload = buildRedditNewPostPayload(sampleEvent(), sampleProfile)!
    const text = textOf(buildDiscordWebhookBody(payload).components as AnyComponent[])
    expect(text).toContain('**17** confirmed trades · flair `Trades: 17`')
    expect(text).toMatch(/Account \*\*\d+y( \d+mo)?\*\* old · \*\*4,656\*\* karma \(1,200 post · 3,456 comment\)/)
  })

  it('falls back gracefully when the profile is unavailable', () => {
    const payload = buildRedditNewPostPayload(sampleEvent({ post: { linkFlair: undefined, nsfw: true } }))!
    const text = textOf(buildDiscordWebhookBody(payload).components as AnyComponent[])
    expect(text).toContain('Confirmed trades: **unknown**')
    expect(text).not.toContain('karma')
    expect(text).toContain('**NSFW**')
    expect(text).not.toContain('`WTS`')
  })

  it('includes the author profile in the json payload', () => {
    const payload = buildRedditNewPostPayload(sampleEvent(), sampleProfile)!
    expect(payload).toMatchObject({
      authorTradeCount: 17,
      authorFlair: 'Trades: 17',
      authorAccountCreatedAt: '2023-01-15T00:00:00.000Z',
      authorPostKarma: 1200,
      authorCommentKarma: 3456,
    })
  })
})

describe('formatAccountAge', () => {
  const now = new Date('2026-10-09T12:00:00Z')
  it('formats years, months, and days', () => {
    expect(formatAccountAge('2023-07-01T00:00:00Z', now)).toBe('3y 3mo')
    expect(formatAccountAge('2024-10-01T00:00:00Z', now)).toBe('2y')
    expect(formatAccountAge('2026-06-20T00:00:00Z', now)).toBe('3mo')
    expect(formatAccountAge('2026-10-02T00:00:00Z', now)).toBe('7d')
  })
})

describe('loadAuthorProfile', () => {
  function profileCtx(options: { stored?: string; flairText?: string; userError?: boolean } = {}) {
    const user = {
      createdAt: new Date('2023-01-15T00:00:00Z'),
      linkKarma: 10,
      commentKarma: 20,
      getUserFlairBySubreddit: vi.fn(async () => ({ flairText: options.flairText })),
    }
    return {
      redis: { get: vi.fn(async () => options.stored) },
      reddit: {
        getUserByUsername: vi.fn(async () => {
          if (options.userError) throw new Error('http status 404 Not Found')
          return user
        }),
      },
      settings: { get: vi.fn(async () => undefined) },
    }
  }

  it('prefers the stored trade count and loads account details and flair', async () => {
    const profile = await loadAuthorProfile(profileCtx({ stored: '9', flairText: 'Trades: 7' }) as any, 'PenSwap', 'Seller')
    expect(profile).toEqual({
      tradeCount: 9,
      flair: 'Trades: 7',
      accountCreatedAt: '2023-01-15T00:00:00.000Z',
      postKarma: 10,
      commentKarma: 20,
    })
  })

  it('falls back to the count in user flair when nothing is stored', async () => {
    const profile = await loadAuthorProfile(profileCtx({ flairText: 'Trades: 7' }) as any, 'PenSwap', 'Seller')
    expect(profile.tradeCount).toBe(7)
  })

  it('keeps what it can when the Reddit user lookup fails', async () => {
    const profile = await loadAuthorProfile(profileCtx({ stored: '3', userError: true }) as any, 'PenSwap', 'Seller')
    expect(profile).toEqual({ ...EMPTY_AUTHOR_PROFILE, tradeCount: 3 })
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
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit & { headers: Record<string, string>; body: string }) => ({
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
          if (name === MOD_NEW_POST_DISCORD_INCLUDE_JSON_SETTING) return true
          return undefined
        }),
      },
    }

    await onPostSubmit(sampleEvent(), ctx as any)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://discord.com/api/webhooks/99/secret-token?with_components=true&wait=true')
    expect(init.method).toBe('POST')
    const sent = await parseMultipart(init.headers['Content-Type'], init.body)
    expect(sent.message.flags).toBe(1 << 15)
    expect(textOf(sent.message.components)).toContain('[u/seller42](https://www.reddit.com/user/seller42/)')
    expect(sent.attachedPayload.event).toBe('reddit.new_post')
    expect(sent.attachedPayload.postId).toBe('t3_abc123')
  })

  it('leaves the json out when the include-json setting is off', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit & { body: string }) => ({
      ok: true,
      status: 204,
      statusText: 'No Content',
      text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = {
      settings: {
        get: vi.fn(async (name: string) =>
          name === MOD_NEW_POST_DISCORD_WEBHOOK_SETTING ? 'https://discord.com/api/webhooks/1/token' : undefined),
      },
    }

    await onPostSubmit(sampleEvent(), ctx as any)

    const init = fetchMock.mock.calls[0][1] as RequestInit & { body: string; headers: Record<string, string> }
    expect(init.headers['Content-Type']).toBe('application/json')
    const sent = JSON.parse(init.body)
    expect(sent.attachments).toBeUndefined()
    expect(textOf(sent.components)).toContain('WTS vintage kit')
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
