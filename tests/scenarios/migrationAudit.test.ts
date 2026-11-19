/**
 * Adversarial audit of the trade-count migration (src/migration.ts): the first time a trader is
 * seen, the stored count `confirmations:<name>` is seeded from the "Trades: N" flair the user
 * already carries. Probes: running it again, partially migrated data, case of names, flairs that
 * do not hold a count, and Reddit failing in the middle of a migration. Driven through the real
 * CommentSubmit flow and, for the function itself, with the app's real context.
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG:` comment. This audit does not fix src/.
 *
 * Replies are rate limited to one per 6.5 seconds through a slot in Redis, so a test with several
 * confirmations lets the fake clock run between them.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { seedTradeCountFromFlair } from '../../src/migration.js'
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

async function setup(mocks: Parameters<typeof newApp>[0]): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return app
}

const count = (app: AppHarness, user: string) => app.ctx.redis.get(`confirmations:${user}`)

function trade(app: AppHarness, seller: string, buyer: string, n = 1) {
  const offerId = `t1_offer${n}`
  const replyId = `t1_reply${n}`
  app.reddit.addComment({ id: offerId, parentId: MONTHLY, postId: MONTHLY, authorName: seller, body: `Sold a kit to u/${buyer}` })
  app.reddit.addComment({ id: replyId, parentId: offerId, postId: MONTHLY, authorName: buyer, body: 'confirmed' })
  return {
    comment: { id: replyId, body: 'confirmed', parentId: offerId, postId: MONTHLY, permalink: `/r/swaps/comments/monthly/_/${replyId}/` },
    author: { name: buyer },
    subreddit: { name: 'swaps' },
  }
}

/** Fires a CommentSubmit and runs the fake clock until it settles, so a reply waiting on the slot gets through. */
const fire = (app: AppHarness, event: Record<string, unknown>) => runWithClock(app.fireTrigger('CommentSubmit', event))

describe('seeding from the flair', () => {
  test('the first confirmation continues from the count in the flair, for both traders', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')
    app.reddit.setFlair('bob', 'Trades: 41')

    await fire(app, trade(app, 'alice', 'bob'))

    expect(await count(app, 'alice')).toBe('8')
    expect(await count(app, 'bob')).toBe('42')
    expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 8')
    expect(app.reddit.flairOf('bob')?.text).toBe('Trades: 42')
  })

  test('a count that crosses a template boundary is carried over and moves the flair template', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 99')

    await fire(app, trade(app, 'alice', 'bob'))

    expect(await count(app, 'alice')).toBe('100')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 100', flairTemplateId: 'tpl-100' })
  })

  test('a moderator\'s "Moderator | Trades: N" flair is seeded too', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('mod1', 'Moderator | Trades: 12')

    await fire(app, trade(app, 'alice', 'mod1'))

    expect(await count(app, 'mod1')).toBe('13')
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 13', flairTemplateId: 'tpl-mod' })
  })

  test('the stored count is under the lower-case name whatever case the account and the flair lookup use', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('Alice', 'Trades: 3')

    await fire(app, trade(app, 'Alice', 'Bob'))

    expect(await count(app, 'alice')).toBe('4')
    expect(await count(app, 'Alice')).toBeUndefined()
  })

  test('no flair at all seeds zero and the trade makes it one', async ({ mocks }) => {
    const app = await setup(mocks)

    await fire(app, trade(app, 'alice', 'bob'))

    expect(await count(app, 'alice')).toBe('1')
  })
})

describe('seeding is idempotent and never loses a count', () => {
  const cases: Array<[string, string]> = [
    ['custom flair text', 'Verified seller'],
    ['a non-numeric count', 'Trades: many'],
    ['a template range, not a count', 'Trades: 100-199'],
    ['another label', 'Swaps: 30'],
  ]
  for (const [name, flair] of cases) {
    test(`${name} is not seeded: nothing is stored until the trade, which counts as the first`, async ({ mocks }) => {
      const app = await setup(mocks)
      app.reddit.setFlair('alice', flair)

      await seedTradeCountFromFlair(app.ctx, 'swaps', 'alice', 'Trades:')
      expect(await count(app, 'alice')).toBeUndefined()

      await fire(app, trade(app, 'alice', 'bob'))
      expect(await count(app, 'alice')).toBe('1')
    })
  }

  test('running the migration again, many times, changes nothing', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')

    for (let i = 0; i < 4; i++) await seedTradeCountFromFlair(app.ctx, 'swaps', 'alice', 'Trades:')

    expect(await count(app, 'alice')).toBe('7')
    expect(app.reddit.calls.filter(c => c.method === 'getUserFlair')).toHaveLength(1)
  })

  test('running it after the count has moved on, or the flair has changed, keeps the stored count', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')
    await seedTradeCountFromFlair(app.ctx, 'swaps', 'alice', 'Trades:')
    await app.ctx.redis.set('confirmations:alice', '9')
    app.reddit.setFlair('alice', 'Trades: 50')

    await seedTradeCountFromFlair(app.ctx, 'swaps', 'ALICE', 'Trades:')

    expect(await count(app, 'alice')).toBe('9')
  })

  test('a stored zero is a count: it is not replaced by the flair', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '0')
    app.reddit.setFlair('alice', 'Trades: 50')

    await fire(app, trade(app, 'alice', 'bob'))

    expect(await count(app, 'alice')).toBe('1')
  })

  test('partially migrated data: counts already stored win, the rest are seeded, nobody is double counted', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '5') // migrated earlier
    app.reddit.setFlair('alice', 'Trades: 3') // flair is behind the stored count
    app.reddit.setFlair('bob', 'Trades: 7') // not migrated yet
    app.reddit.setFlair('carol', 'Trades: 20')

    await fire(app, trade(app, 'alice', 'bob', 1))
    await fire(app, trade(app, 'carol', 'alice', 2))

    expect(await count(app, 'alice')).toBe('7')
    expect(await count(app, 'bob')).toBe('8')
    expect(await count(app, 'carol')).toBe('21')
    expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 7')
    expect(app.reddit.flairOf('bob')?.text).toBe('Trades: 8')
    expect(app.reddit.flairOf('carol')?.text).toBe('Trades: 21')
  })

  test('delivering the same confirmation again, and then the hourly rescan, leaves seeded counts as they are', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')
    const event = trade(app, 'alice', 'bob')

    await fire(app, event)
    await fire(app, event)
    await runWithClock(app.runJob('rescan-monthly-post'))

    expect(await count(app, 'alice')).toBe('8')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply1')).toHaveLength(1)
  })
})

describe('Reddit failing in the middle of a migration', () => {
  test('a flair lookup that fails stops the confirmation with nothing counted; a redelivery counts it once from the flair', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')
    app.reddit.setFlair('bob', 'Trades: 41')
    const event = trade(app, 'alice', 'bob')
    app.reddit.failNext('getUserFlair', '503 Service Unavailable')

    await expect(fire(app, event)).rejects.toThrow('503')

    expect(await count(app, 'alice')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmed:t1_offer1')).toBeUndefined()
    expect(await app.ctx.redis.get('processing:t1_reply1')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_reply1')).toHaveLength(0)

    await fire(app, event)
    await fire(app, event)

    expect(await count(app, 'alice')).toBe('8')
    expect(await count(app, 'bob')).toBe('42')
    expect(app.reddit.repliesTo('t1_reply1')).toHaveLength(1)
  })

  test('the first trader seeded and the second failing leaves a seeded count that the retry builds on, not one that is added twice', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')
    app.reddit.setFlair('bob', 'Trades: 41')
    const event = trade(app, 'alice', 'bob')
    const getUserFlair = app.reddit.client.getSubredditByName
    let lookups = 0
    app.reddit.client.getSubredditByName = async name => {
      const sub = await getUserFlair(name)
      const original = sub.getUserFlair
      sub.getUserFlair = async options => {
        if (++lookups === 2) throw new Error('503 Service Unavailable')
        return original(options)
      }
      return sub
    }

    await expect(fire(app, event)).rejects.toThrow('503')
    expect(await count(app, 'alice')).toBe('7')
    expect(await count(app, 'bob')).toBeUndefined()

    await fire(app, event)

    expect(await count(app, 'alice')).toBe('8')
    expect(await count(app, 'bob')).toBe('42')
  })

  test('a failed seed called directly leaves no key behind and can be run again', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')
    app.reddit.failNext('getUserFlair', '503 Service Unavailable')

    await expect(seedTradeCountFromFlair(app.ctx, 'swaps', 'alice', 'Trades:')).rejects.toThrow('503')
    expect(await count(app, 'alice')).toBeUndefined()

    await seedTradeCountFromFlair(app.ctx, 'swaps', 'alice', 'Trades:')
    expect(await count(app, 'alice')).toBe('7')
  })
})
