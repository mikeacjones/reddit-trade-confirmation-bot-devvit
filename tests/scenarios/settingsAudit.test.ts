/**
 * Adversarial audit of the settings the app declares in src/main.ts and of the flair data derived
 * from them: blank, whitespace-only or wrongly typed settings, labels and keywords with regex or
 * markdown characters, and flair templates or a cached flair list that do not parse. Driven through
 * the real app with the real settings client (`mocks.settings.put` is the moderator editing a
 * setting).
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG:` comment. This audit does not fix src/.
 *
 * Replies are rate limited to one per 6.5 seconds through a slot in Redis, so the fake clock runs
 * while a confirmation is processed.
 */
import { Devvit } from '@devvit/public-api'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { getLanguageSettings } from '../../src/language.js'
import { runWithClock } from '../harness/clock.js'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const MONTHLY = 't3_monthly'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-05-08T12:00:00Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Mocks = Parameters<typeof newApp>[0]

interface DeclaredSetting {
  name: string
  type: string
  defaultValue?: unknown
  onValidate?: (event: { value: unknown }) => string | void | Promise<string | void>
}

const declared = (): DeclaredSetting[] => (Devvit as unknown as { installationSettings: DeclaredSetting[] }).installationSettings

async function setup(mocks: Mocks): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return app
}

function trade(app: AppHarness, seller = 'alice', buyer = 'bob', keyword = 'confirmed', n = 1) {
  app.reddit.addComment({ id: `t1_offer${n}`, parentId: MONTHLY, postId: MONTHLY, authorName: seller, body: `Sold a kit to u/${buyer}` })
  app.reddit.addComment({ id: `t1_reply${n}`, parentId: `t1_offer${n}`, postId: MONTHLY, authorName: buyer, body: keyword })
  return {
    comment: { id: `t1_reply${n}`, body: keyword, parentId: `t1_offer${n}`, postId: MONTHLY, permalink: `/r/swaps/comments/monthly/_/reply${n}/` },
    author: { name: buyer },
    subreddit: { name: 'swaps' },
  }
}

/** Fires a CommentSubmit and runs the fake clock until it settles, so a reply waiting on the slot gets through. */
const fire = (app: AppHarness, event: Record<string, unknown>) => runWithClock(app.fireTrigger('CommentSubmit', event))

const count = (app: AppHarness, user: string) => app.ctx.redis.get(`confirmations:${user}`)

describe('the settings the app declares', () => {
  test('every setting the code reads is declared, with a blank or sensible default', async () => {
    const byName = Object.fromEntries(declared().map(s => [s.name, s]))

    for (const name of [
      'monthly_post_title', 'monthly_post', 'trade_confirmation', 'already_confirmed', 'cant_confirm_username',
      'old_confirmation_thread', 'monthly_post_flair_id', 'confirmation_keyword', 'flair_count_label',
      'moderator_flair_prefix', 'date_locale', 'mod_new_post_discord_webhook', 'mod_new_post_discord_include_json',
    ]) {
      expect(byName[name], name).toBeDefined()
    }
    expect(byName.mod_new_post_discord_webhook.defaultValue).toBe('')
    expect(byName.mod_new_post_discord_include_json.defaultValue).toBe(false)
    expect(byName.monthly_post_flair_id.defaultValue).toBe('')
  })

  test('the webhook setting is wired to the validator: only a Discord webhook URL or a blank saves', async () => {
    const field = declared().find(s => s.name === 'mod_new_post_discord_webhook')!

    expect(await field.onValidate!({ value: '' })).toBeUndefined()
    expect(await field.onValidate!({ value: 'https://discord.com/api/webhooks/1/abc' })).toBeUndefined()
    expect(await field.onValidate!({ value: 'https://example.com/hook' })).toMatch(/Discord webhook URL/)
    expect(await field.onValidate!({ value: 'https://discord.com.evil.example/api/webhooks/1/abc' })).toMatch(/Discord webhook URL/)
  })
})

describe('blank and wrongly typed settings fall back to the defaults (real settings client)', () => {
  const language = ['confirmation_keyword', 'flair_count_label', 'moderator_flair_prefix', 'date_locale']
  const values: Array<[string, unknown]> = [
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
    ['an empty string', ''],
    ['a number', 42],
    ['a boolean', true],
  ]
  for (const [name, value] of values) {
    test(`${name} in every language setting gives the defaults`, async ({ mocks }) => {
      const app = newApp(mocks)
      for (const setting of language) mocks.settings.put(setting, value as never)

      expect(await getLanguageSettings(app.ctx)).toEqual({
        confirmationKeyword: 'confirmed',
        flairCountLabel: 'Trades:',
        moderatorFlairPrefix: 'Moderator',
        dateLocale: 'en-US',
      })
    })
  }

  test('blank reply templates fall back to the built-in text, and the trade is still confirmed and answered', async ({ mocks }) => {
    const app = await setup(mocks)
    for (const name of ['trade_confirmation', 'already_confirmed', 'cant_confirm_username', 'old_confirmation_thread']) {
      mocks.settings.put(name, '   ')
    }

    await fire(app, trade(app))

    expect(await count(app, 'alice')).toBe('1')
    const [reply] = app.reddit.repliesTo('t1_reply1')
    expect(reply.body.trim().length).toBeGreaterThan(0)
    expect(reply.body).not.toMatch(/\{\w+\}/)
  })

  test('a reply template with unknown placeholders and replacement-pattern characters is posted as written', async ({ mocks }) => {
    const app = await setup(mocks)
    mocks.settings.put('trade_confirmation', 'Thanks {confirmer}! $& $1 $$ {nope} {parent_author} {constructor_missing}')

    await fire(app, trade(app))

    expect(app.reddit.repliesTo('t1_reply1')[0].body).toBe('Thanks bob! $& $1 $$ {nope} alice {constructor_missing}')
  })
})

describe('labels and keywords with special characters', () => {
  const labels = ['Trades (confirmed):', '[T]*:', 'Swaps? $1.', 'Tauschen|Handel:', '交易:', 'Trades\\:']
  for (const label of labels) {
    test(`flair label ${JSON.stringify(label)} is matched literally by the cache, the seeding and the flair text`, async ({ mocks }) => {
      const app = newApp(mocks)
      seedSwapsWorld(app)
      app.reddit.flairTemplates.length = 0
      app.reddit.addFlairTemplate(`${label} 0-99`, { id: 'tpl-a' })
      app.reddit.addFlairTemplate(`${label} 100-199`, { id: 'tpl-b' })
      await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
      mocks.settings.put('flair_count_label', label)
      app.reddit.setFlair('alice', `${label} 99`)

      await fire(app, trade(app))

      expect(await count(app, 'alice')).toBe('100')
      expect(app.reddit.flairOf('alice')).toEqual({ text: `${label} 100`, flairTemplateId: 'tpl-b' })
      expect(app.reddit.flairOf('bob')).toEqual({ text: `${label} 1`, flairTemplateId: 'tpl-a' })
    })
  }

  for (const keyword of ['.*', '(', 'conf[irmed', '\\', 'bestätigt', 'ÇONFIRMADO', '✅']) {
    test(`keyword ${JSON.stringify(keyword)} is a plain substring, matched without regard to case`, async ({ mocks }) => {
      const app = await setup(mocks)
      mocks.settings.put('confirmation_keyword', `  ${keyword}  `)

      await fire(app, trade(app, 'alice', 'bob', `yes, ${keyword.toLowerCase()} thanks`))

      expect(await count(app, 'alice')).toBe('1')
    })
  }

  test('a keyword that is not in the reply does not confirm, whatever the other settings say', async ({ mocks }) => {
    const app = await setup(mocks)
    mocks.settings.put('confirmation_keyword', '.*')

    await fire(app, trade(app, 'alice', 'bob', 'confirmed'))

    expect(await count(app, 'alice')).toBeUndefined()
  })
})

describe('flair templates and the cached flair list that do not parse', () => {
  const damaged: Array<[string, string]> = [
    ['an unterminated array', '[{"min":0,"max":99'],
    ['an object, not an array', '{"min":0,"max":99}'],
    ['null', 'null'],
    ['a template whose range is a string', '[{"min":"0","max":"99","id":"t","template":"Trades: 0-99","modOnly":false}]'],
    ['a template without an id', '[{"min":0,"max":99,"template":"Trades: 0-99","modOnly":false}]'],
    ['a NaN range written as null', '[{"min":null,"max":null,"id":"t","template":"Trades: 0-99","modOnly":false}]'],
    ['modOnly as a string', '[{"min":0,"max":99,"id":"t","template":"Trades: 0-99","modOnly":"false"}]'],
    ['an array with a null entry', '[null]'],
  ]
  for (const [name, raw] of damaged) {
    test(`${name} in the cache is replaced from Reddit and the trade gets its flair`, async ({ mocks }) => {
      const app = await setup(mocks)
      await app.ctx.redis.set('flairTemplates:swaps:Trades%3A', raw)

      await fire(app, trade(app))

      expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
      expect(app.reddit.calls.filter(c => c.method === 'getUserFlairTemplates')).toHaveLength(1)
    })
  }

  test('a cached list that is valid JSON but empty is refreshed from Reddit when a count has no template', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('flairTemplates:swaps:Trades%3A', '[]')

    await fire(app, trade(app))

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  })

  test('templates whose range does not parse are skipped, the others still work, and nothing throws', async ({ mocks }) => {
    const app = newApp(mocks)
    await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
    app.reddit.addPost({ id: MONTHLY, title: 'Confirmed Trade Thread', stickied: true })
    for (const text of ['Trades: a-b', 'Trades: 5-', 'Trades: -5', 'Trades: 1,000-2,000', 'Trades 0-99', 'Trades: 0 - 99', '']) {
      app.reddit.addFlairTemplate(text || 'x', { id: `bad-${text}` })
    }
    app.reddit.addFlairTemplate('Trades: 0-99', { id: 'good' })

    await fire(app, trade(app))

    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('good')
    expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 1')
  })

  test('a reversed range (100-50) never matches and does not shadow a valid template', async ({ mocks }) => {
    const app = newApp(mocks)
    await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
    app.reddit.addPost({ id: MONTHLY, title: 'Confirmed Trade Thread', stickied: true })
    app.reddit.addFlairTemplate('Trades: 100-0', { id: 'reversed' })
    app.reddit.addFlairTemplate('Trades: 0-99', { id: 'good' })
    app.reddit.setFlair('alice', 'Trades: 40')

    await fire(app, trade(app))

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 41', flairTemplateId: 'good' })
  })

  test('with no parseable template at all the trades are still counted and the flairs are left alone', async ({ mocks }) => {
    const app = newApp(mocks)
    await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
    app.reddit.addPost({ id: MONTHLY, title: 'Confirmed Trade Thread', stickied: true })
    app.reddit.addFlairTemplate('Seller', { id: 'plain' })
    app.reddit.setFlair('alice', 'Seller')

    await fire(app, trade(app))

    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.flairOf('alice')?.text).toBe('Seller')
    expect(app.reddit.repliesTo('t1_reply1')).toHaveLength(1)
  })
})
