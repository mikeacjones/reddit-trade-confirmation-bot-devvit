/**
 * Adversarial audit of the Discord payload builders (src/discordNotify.ts): what the outgoing card
 * and JSON look like for hostile or extreme titles, authors, flair and post bodies. Nothing here
 * talks to Discord; the scenario file tests/scenarios/discordAudit.test.ts drives the handler with
 * a stubbed fetch.
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is an
 * `it.fails` repro with a `// BUG:` comment: it stays green now and turns red once the bug is
 * fixed, then drops `.fails`. This audit does not fix src/.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDiscordMultipartRequest,
  buildDiscordWebhookBody,
  buildRedditNewPostPayload,
  EMPTY_AUTHOR_PROFILE,
  escapeDiscordMarkdown,
  formatAccountAge,
  isDiscordWebhookUrl,
  normalizeDiscordWebhookUrl,
  truncateText,
  validateDiscordWebhookSetting,
  type AuthorProfile,
  type RedditNewPostPayload,
} from '../src/discordNotify'

type Component = { type: number; content?: string; components?: Component[]; [key: string]: unknown }

function flatten(components: Array<Record<string, unknown>>): Component[] {
  return (components as Component[]).flatMap(c => [c, ...flatten(c.components ?? [])])
}

function eventWith(post: Record<string, unknown> = {}, author: Record<string, unknown> | null = {}, subreddit = 'swaps') {
  return {
    post: {
      id: 't3_abc',
      title: 'WTS kit',
      selftext: 'body',
      permalink: '/r/swaps/comments/abc/wts_kit/',
      url: 'https://www.reddit.com/r/swaps/comments/abc/wts_kit/',
      isSelf: true,
      createdAt: 1_714_000_000,
      ...post,
    },
    author: author === null ? undefined : { id: 't2_a', name: 'seller', ...author },
    subreddit: { id: 't5_s', name: subreddit },
  } as any
}

function build(
  post: Record<string, unknown> = {},
  options: { author?: Record<string, unknown> | null; profile?: Partial<AuthorProfile>; includeJson?: boolean; subreddit?: string } = {},
) {
  const payload = buildRedditNewPostPayload(
    eventWith(post, options.author, options.subreddit),
    { ...EMPTY_AUTHOR_PROFILE, ...options.profile },
  )!
  const body = buildDiscordWebhookBody(payload, { includeJson: options.includeJson })
  const texts = flatten(body.components).filter(c => c.type === 10).map(c => c.content as string)
  return { payload, body, texts, text: texts.join('\n') }
}

/** True when `value` has a surrogate half that is not part of a pair (what a cut-through emoji leaves). */
const hasLoneSurrogate = (value: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)

describe('mentions and pings', () => {
  const pings = '@everyone @here <@123456789012345678> <@&987654321098765432> <#111>'

  it('never lets the message ping anyone, whatever the title, author, flair or body says', () => {
    const { body } = build(
      { title: pings, selftext: pings, linkFlair: { text: pings } },
      { author: { name: 'everyone' }, profile: { flair: pings } },
    )

    expect(body.allowed_mentions).toEqual({ parse: [] })
  })

  it('the multipart request carries the same empty allowed_mentions in its payload_json', async () => {
    const { body, payload } = build({ selftext: pings }, { includeJson: true })
    const { contentType, body: raw } = buildDiscordMultipartRequest(body, payload)

    const form = await new Request('https://discord.test', { method: 'POST', headers: { 'Content-Type': contentType }, body: raw }).formData()

    expect(JSON.parse(String(form.get('payload_json'))).allowed_mentions).toEqual({ parse: [] })
  })

  it('escapes the angle brackets of a mention in the title and author so it does not render as a mention', () => {
    const { texts } = build({ title: '<@123456789012345678> <@&5> <#7> <t:0:R> <https://evil.example>' })
    const titleBlock = texts[0]

    expect(titleBlock).toContain('\\<@123456789012345678\\>')
    expect(titleBlock).toContain('\\<@&5\\>')
    expect(titleBlock).toContain('\\<#7\\>')
    expect(titleBlock.split('\n')[1]).not.toMatch(/(^|[^\\])<[@#&t]/)
  })
})

describe('markdown in titles, authors and flair', () => {
  it('escapes every markdown control character in a title so it cannot end the link early', () => {
    const { texts } = build({ title: 'x](https://evil.example)[y **bold** _it_ ~~s~~ ||spoiler|| `code` \\' })
    const heading = texts[0].split('\n')[1]

    expect(heading.startsWith('## [')).toBe(true)
    expect(heading.endsWith('](https://www.reddit.com/r/swaps/comments/abc/wts_kit/)')).toBe(true)
    const label = heading.slice(4, heading.lastIndexOf(']('))
    expect(label).not.toMatch(/(^|[^\\])[\]\[*_~|`]/)
    expect(label).toContain('x\\](https://evil.example)\\[y')
  })

  it('escapes a backslash so that it cannot swallow the escape of the character after it', () => {
    expect(escapeDiscordMarkdown('\\*')).toBe('\\\\\\*')
  })

  it('escapes markdown in the author name and keeps the real profile URL', () => {
    const { texts } = build({}, { author: { name: 'a_b*c_d' } })

    expect(texts[0]).toContain('[u/a\\_b\\*c\\_d](https://www.reddit.com/user/a_b*c_d/)')
  })

  it('turns backticks in link flair and in the author flair into apostrophes so the code span cannot break', () => {
    const { texts } = build({ linkFlair: { text: 'WTS `x` ``y``' } }, { profile: { flair: 'Trades: 4 `oops`', tradeCount: 4 } })

    expect(texts[0]).toContain("`WTS 'x' ''y''`")
    expect(texts[1]).toContain("flair `Trades: 4 'oops'`")
  })

  it('renders a post by a deleted author without a profile link or message button', () => {
    const { body, text } = build({}, { author: null })
    const urls = flatten(body.components).map(c => c.url).filter(Boolean)

    expect(text).toContain('unknown author')
    expect(urls.some(u => String(u).includes('/user/'))).toBe(false)
    expect(urls.some(u => String(u).includes('message/compose'))).toBe(false)
  })

  it('percent-encodes the author in the message-author link', () => {
    const { body } = build({}, { author: { name: 'a b&c=d' } })
    const url = flatten(body.components).map(c => String(c.url)).find(u => u.includes('message/compose'))

    expect(url).toBe('https://www.reddit.com/message/compose/?to=a%20b%26c%3Dd')
  })

  it('shows a placeholder for an empty title and "unknown" for a missing subreddit', () => {
    const { texts } = build({ title: '' }, { subreddit: '' })

    expect(texts[0]).toContain('(no title)')
    expect(texts[0]).toContain('New post in r/unknown')
  })
})

describe('size limits', () => {
  it('cuts a very long title to 200 characters plus an ellipsis', () => {
    const { texts } = build({ title: 'T'.repeat(50_000) })
    const label = texts[0].split('\n')[1]

    expect(label).toBe(`## [${'T'.repeat(199)}…](https://www.reddit.com/r/swaps/comments/abc/wts_kit/)`)
  })

  it('cuts a very long body to a 900 character preview and says it was cut', () => {
    const { texts } = build({ selftext: 'b'.repeat(500_000) })
    const preview = texts.at(-1)!

    expect(preview.startsWith('b'.repeat(899) + '…')).toBe(true)
    expect(preview).toContain('Preview truncated')
    expect(preview.length).toBeLessThan(1_100)
  })

  it('keeps all text in the card under Discord\'s 4000 character total for worst-case input', () => {
    const { texts, body } = build(
      {
        title: '_'.repeat(5_000),
        selftext: '`'.repeat(5_000),
        linkFlair: { text: 'F'.repeat(500) },
      },
      {
        author: { name: 'A'.repeat(100) },
        profile: { flair: 'G'.repeat(500), tradeCount: 123_456_789, accountCreatedAt: '2001-01-01T00:00:00.000Z', postKarma: 9_999_999, commentKarma: 9_999_999 },
        subreddit: 'S'.repeat(50),
      },
    )

    expect(texts.join('').length).toBeLessThanOrEqual(4_000)
    expect(JSON.stringify(body).length).toBeLessThan(6_000)
  })

  it('keeps link-button labels within 80 characters and their URLs within 512 for realistic posts', () => {
    const { body } = build({ permalink: `/r/swaps/comments/abc/${'slug_'.repeat(20)}/` }, { author: { name: 'a'.repeat(20) }, subreddit: 'S'.repeat(21) })
    const buttons = flatten(body.components).filter(c => c.type === 2)

    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(String(button.label).length).toBeLessThanOrEqual(80)
      expect(String(button.url).length).toBeLessThanOrEqual(512)
      expect(String(button.url)).toMatch(/^https:\/\//)
    }
  })

  it('shows at most four gallery images and spoilers them for NSFW posts', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://i.redd.it/${i}.png`)
    const { body } = build({ galleryImages: urls, nsfw: true })
    const gallery = flatten(body.components).find(c => c.type === 12) as Component & { items: Array<{ media: { url: string }; spoiler: boolean }> }

    expect(gallery.items).toHaveLength(4)
    expect(gallery.items.every(i => i.spoiler)).toBe(true)
  })

  // BUG: truncateText cuts by UTF-16 code unit, so a body or title whose limit falls inside an emoji keeps half of a surrogate pair and the message carries an invalid character, severity low
  it.fails('does not leave half an emoji at the end of a truncated body preview', () => {
    const { texts } = build({ selftext: `${'a'.repeat(898)}😀${'b'.repeat(100)}` })

    expect(texts.some(hasLoneSurrogate)).toBe(false)
  })
})

describe('unicode', () => {
  const unicode = '日本語のタイトル 🚀 Ünïcödé עברית \u202eRTL\u202c a\u0301'

  it('passes CJK, emoji, accents and bidirectional text through to the card unchanged', () => {
    const { text } = build({ title: unicode, selftext: unicode })

    expect(text).toContain(unicode)
    expect(hasLoneSurrogate(text)).toBe(false)
  })

  it('round-trips unicode through JSON.stringify and the multipart request', async () => {
    const { body, payload } = build({ title: unicode, selftext: unicode }, { includeJson: true })
    const { contentType, body: raw } = buildDiscordMultipartRequest(body, payload)

    const form = await new Request('https://discord.test', { method: 'POST', headers: { 'Content-Type': contentType }, body: raw }).formData()
    const file = form.get('files[0]') as File

    expect(JSON.parse(await file.text()).body).toBe(unicode)
    expect(JSON.stringify(JSON.parse(String(form.get('payload_json'))))).toBe(JSON.stringify(body))
  })

  it('a body full of CRLFs and boundary-looking lines cannot split the request, and the boundary appears only as a delimiter', async () => {
    const evil = 'x\r\n------swapbot123\r\nContent-Disposition: form-data; name="files[1]"; filename="evil.json"\r\n\r\n{}\r\n------swapbot123--\r\n'
    const { body, payload } = build({ selftext: evil }, { includeJson: true })
    const { contentType, body: raw } = buildDiscordMultipartRequest(body, payload)
    const boundary = contentType.split('boundary=')[1]

    // two part openings and the closing delimiter, nothing else
    expect(raw.split(`--${boundary}`)).toHaveLength(4)
    const form = await new Request('https://discord.test', { method: 'POST', headers: { 'Content-Type': contentType }, body: raw }).formData()

    expect([...form.keys()].sort()).toEqual(['files[0]', 'payload_json'])
    expect(JSON.parse(await (form.get('files[0]') as File).text()).body).toBe(evil)
  })
})

describe('the post body preview', () => {
  it('shows the link of a link post without a body, and nothing for an empty self post', () => {
    expect(build({ selftext: '', isSelf: false, url: 'https://example.com/item' }).text).toContain('https://example.com/item')
    expect(build({ selftext: '', isSelf: true }).texts).toHaveLength(2)
  })

  it('keeps a body with backticks, code fences and a stray closing bracket intact as JSON', () => {
    const selftext = '```js\nconsole.log(`x`)\n```\n]) ((\n'
    const { body } = build({ selftext })

    expect(JSON.parse(JSON.stringify(body))).toEqual(body)
    expect(flatten(body.components).some(c => c.content?.includes(selftext))).toBe(true)
  })

  // BUG: the title and author are escaped but the body preview is sent as raw markdown, so a post body can put a live [label](url) link, a heading or a spoiler into the moderators' Discord card, severity low
  it.fails('does not turn markdown in the post body into live formatting in the card', () => {
    const { texts } = build({ selftext: '[u/mod_team: verify your account](https://phish.example/login)' })

    expect(texts.at(-1)).not.toContain('](https://phish.example')
  })
})

describe('the webhook URL', () => {
  it.each([
    'https://discord.com/api/webhooks/123/abc',
    'https://discordapp.com/api/webhooks/123/abc-DEF_ghi/',
    '  https://discord.com/api/webhooks/123/abc  ',
    '\thttps://discord.com/api/webhooks/123/abc\n',
    'https://DISCORD.com/api/webhooks/123/abc',
  ])('accepts %j', value => {
    expect(isDiscordWebhookUrl(value)).toBe(true)
    expect(validateDiscordWebhookSetting(value)).toBeUndefined()
  })

  it.each([
    '',
    ' ',
    'discord',
    'not a url',
    'http://discord.com/api/webhooks/123/abc',
    'ftp://discord.com/api/webhooks/123/abc',
    'https://discord.com/api/webhooks/123',
    'https://discord.com/api/webhooks/abc/def',
    'https://discord.com/api/webhooks/123/abc/extra',
    'https://discord.com.evil.example/api/webhooks/123/abc',
    'https://evil.example/discord.com/api/webhooks/123/abc',
    'https://discord.com@evil.example/api/webhooks/123/abc',
    'https://notdiscord.com/api/webhooks/123/abc',
    'https://ptb.discord.com/api/webhooks/123/abc',
    'javascript:alert(1)',
  ])('rejects %j as a webhook URL', value => {
    expect(isDiscordWebhookUrl(value)).toBe(false)
  })

  it('the settings validator allows blank and undefined, and rejects everything that is not a webhook URL', () => {
    expect(validateDiscordWebhookSetting('')).toBeUndefined()
    expect(validateDiscordWebhookSetting(undefined)).toBeUndefined()
    expect(validateDiscordWebhookSetting(null)).toBeUndefined()
    expect(validateDiscordWebhookSetting('nope')).toMatch(/Discord webhook URL/)
    expect(validateDiscordWebhookSetting(123)).toMatch(/Discord webhook URL/)
    expect(validateDiscordWebhookSetting({})).toMatch(/Discord webhook URL/)
    // A value of only spaces is not "blank" to the validator, although the handler treats it as unset.
    expect(validateDiscordWebhookSetting('   ')).toMatch(/Discord webhook URL/)
  })

  it('normalises host, whitespace, fragment and trailing slash', () => {
    expect(normalizeDiscordWebhookUrl(' https://discordapp.com/api/webhooks/1/tok/#frag ')).toBe('https://discord.com/api/webhooks/1/tok')
  })

  // BUG: normalizeDiscordWebhookUrl drops the whole query string, so a webhook URL for a forum or thread (…?thread_id=123) that the validator accepts posts to the parent channel instead, severity low
  it.fails('keeps thread_id when the webhook URL targets a thread', () => {
    expect(normalizeDiscordWebhookUrl('https://discord.com/api/webhooks/1/tok?thread_id=123')).toContain('thread_id=123')
  })
})

describe('helpers at their edges', () => {
  it('truncateText leaves text at exactly the limit alone and cuts one over', () => {
    expect(truncateText('abc', 3)).toEqual({ text: 'abc', truncated: false })
    expect(truncateText('abcd', 3)).toEqual({ text: 'ab…', truncated: true })
    expect(truncateText('abc', 0)).toEqual({ text: '…', truncated: true })
  })

  it('formatAccountAge handles a creation date in the future and one on the same day', () => {
    const now = new Date('2026-05-08T12:00:00Z')

    expect(formatAccountAge('2026-06-01T00:00:00Z', now)).toBe('0d')
    expect(formatAccountAge('2026-05-08T00:00:00Z', now)).toBe('0d')
    expect(formatAccountAge('2025-05-09T00:00:00Z', now)).toBe('11mo')
    expect(formatAccountAge('2025-05-08T00:00:00Z', now)).toBe('1y')
  })

  it('the card tolerates zero karma, negative karma and a trade count of one', () => {
    const { text } = build({}, { profile: { tradeCount: 1, accountCreatedAt: '2020-01-01T00:00:00Z', postKarma: -10, commentKarma: 0 } })

    expect(text).toContain('**1** confirmed trade\n')
    expect(text).toContain('**-10** karma (-10 post · 0 comment)')
  })

  it('a payload never has a NaN timestamp, whatever createdAt looks like', () => {
    for (const createdAt of [undefined, 0, NaN, 1_714_000_000, 1_714_000_000_000]) {
      const { text } = build({ createdAt })
      expect(text).toMatch(/<t:\d+:R>/)
    }
  })

  it('exposes the payload type used by the JSON attachment', () => {
    const payload: RedditNewPostPayload = build().payload
    expect(payload.event).toBe('reddit.new_post')
  })
})
