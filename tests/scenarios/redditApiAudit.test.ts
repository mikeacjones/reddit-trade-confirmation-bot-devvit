/**
 * Adversarial audit of how the Reddit API wrapper (src/redditApi.ts) behaves inside the real
 * confirmation flow: a rate-limited or timed-out reply or flair write must be retried or redelivered
 * without double-posting a reply or recounting a trade.
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG:` comment. This audit does not fix src/.
 *
 * Time is faked, so the waits for a rate limit pass without delay.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
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

function trade(app: AppHarness) {
  app.reddit.addComment({ id: 't1_offer', parentId: MONTHLY, postId: MONTHLY, authorName: 'alice', body: 'Sold a kit to u/bob' })
  app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
  return {
    comment: { id: 't1_reply', body: 'confirmed', parentId: 't1_offer', postId: MONTHLY, permalink: '/r/swaps/comments/monthly/_/reply/' },
    author: { name: 'bob' },
    subreddit: { name: 'swaps' },
  }
}

/** Fires the trigger and runs the fake clock until it settles, so every rate-limit wait is passed. */
const fire = (app: AppHarness, event: Record<string, unknown>) => runWithClock(app.fireTrigger('CommentSubmit', event))

const rateLimit = (seconds = 3) => new Error(`RATELIMIT: you are doing that too much. Take a break for ${seconds} seconds before trying again`)
const submits = (app: AppHarness) => app.reddit.calls.filter(c => c.method === 'submitComment').length
const flairWrites = (app: AppHarness) => app.reddit.calls.filter(c => c.method === 'setUserFlair').length

describe('a rate limit during a confirmation', () => {
  test('a rate-limited reply is retried once and the bot ends up with exactly one reply', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('submitComment', rateLimit())

    await fire(app, trade(app))

    expect(submits(app)).toBe(2)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
  })

  test('a rate-limited flair write is retried and each flair is written once', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('setUserFlair', rateLimit())

    await fire(app, trade(app))

    expect(flairWrites(app)).toBe(3)
    expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 1')
    expect(app.reddit.flairOf('bob')?.text).toBe('Trades: 1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('rate-limit metadata (retry-after) instead of text is honoured on a reply', async ({ mocks }) => {
    const app = await setup(mocks)
    const error = Object.assign(new Error('429 too many requests'), { metadata: { get: (key: string) => (key === 'retry-after' ? '2' : undefined) } })
    app.reddit.failNext('submitComment', error)

    await fire(app, trade(app))

    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('a reply that keeps being rate limited fails the trigger after three tries, with the trade counted and no reply posted', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('submitComment', rateLimit(), 3)

    await expect(fire(app, trade(app))).rejects.toThrow('RATELIMIT')

    expect(submits(app)).toBe(3)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(0)
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('processed:t1_reply')).toBeUndefined()
  })

  test('the redelivery after that finishes the job: one reply, no recount, flairs as before', async ({ mocks }) => {
    const app = await setup(mocks)
    const event = trade(app)
    app.reddit.failNext('submitComment', rateLimit(), 3)
    await expect(fire(app, event)).rejects.toThrow('RATELIMIT')
    const flairsBefore = { alice: app.reddit.flairOf('alice'), bob: app.reddit.flairOf('bob') }

    await fire(app, event)

    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    // The replay may write a flair again (the first run could have died before it), always to the same text.
    expect({ alice: app.reddit.flairOf('alice'), bob: app.reddit.flairOf('bob') }).toEqual(flairsBefore)
    expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 1')
  })
})

describe('an error that may have posted the comment is never retried by the wrapper', () => {
  test('a reply that Reddit stored but whose answer was lost (timeout) is not posted again by the retry or the redelivery', async ({ mocks }) => {
    const app = await setup(mocks)
    const event = trade(app)
    const submit = app.reddit.client.submitComment
    let lost = true
    app.reddit.client.submitComment = async options => {
      const posted = await submit(options)
      if (lost) { lost = false; throw new Error('DEADLINE_EXCEEDED: the reply to submitComment was lost') }
      return posted
    }

    await expect(fire(app, event)).rejects.toThrow('DEADLINE_EXCEEDED')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)

    await fire(app, event)
    await runWithClock(app.runJob('rescan-monthly-post'))

    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
  })

  test('a 5xx on the reply fails the trigger on the first try, with exactly one submit attempt', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('submitComment', '503 Service Unavailable')

    await expect(fire(app, trade(app))).rejects.toThrow('503')

    expect(submits(app)).toBe(1)
  })

  test('a permanent 403 on a flair write is not retried', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('setUserFlair', '403 Forbidden')

    await expect(fire(app, trade(app))).rejects.toThrow('403')

    expect(flairWrites(app)).toBe(1)
  })
})

describe('a rate limit on a read', () => {
  test('the read is retried and the flow carries on', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('getCommentById', rateLimit())

    await fire(app, trade(app))

    expect(app.reddit.calls.filter(c => c.method === 'getCommentById').length).toBeGreaterThanOrEqual(2)
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
  })

  test('a long "take a break for 5 minutes" limit stops the flow at once instead of sleeping, and the next event after the cool-down works', async ({ mocks }) => {
    const app = await setup(mocks)
    const event = trade(app)
    app.reddit.failNext('getPostById', rateLimit(0))
    app.reddit.failNext('getPostById', new Error('RATELIMIT: take a break for 5 minutes before trying again'))

    await expect(fire(app, event)).rejects.toThrow(/RATELIMIT|backoff active/)
    await expect(fire(app, event)).rejects.toThrow(/backoff active/)
    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(6 * 60_000)
    await fire(app, event)

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })
})
