/**
 * Scenario tests for the monthly thread lifecycle and the hourly rescan, driven through the real
 * scheduler jobs and trigger registered by src/main.ts (src/monthly.ts, src/scheduling.ts and the
 * rescan in src/confirmations.ts). They guard current behavior.
 *
 * Time is controlled with vitest fake timers: the clock is pinned before each test, the monthly
 * rotation runs "at midnight on the 1st" and the rescan "at half past", and the tests move the clock
 * with vi.setSystemTime / vi.advanceTimersByTime instead of waiting. Each test builds its own world
 * (fresh Devvit mocks, Redis and FakeReddit), so tests share no state and can run in any order.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const HOUR_MS = 60 * 60 * 1000
const MONTHLY = 't3_monthly'
const DECEMBER_FIRST = new Date('2026-12-01T00:00:00Z')
const JANUARY_FIRST = new Date('2027-01-01T00:00:00Z')

beforeEach(() => {
  // setImmediate stays real: the Redis mocks and runJobAdvancingClock need real event-loop turns.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(DECEMBER_FIRST)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The world of the other scenarios, with the pointer on t3_monthly and the harness's clock fake. */
async function setup(mocks: Parameters<typeof newApp>[0]): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return app
}

async function currentPostId(app: AppHarness): Promise<string> {
  return (await app.ctx.redis.get('currentMonthlyPost'))!
}

function submittedPosts(app: AppHarness): number {
  return app.reddit.calls.filter(c => c.method === 'submitPost').length
}

/**
 * Run a job whose Reddit writes sleep on fake timers (the comment-submit slot spacing): keep moving
 * the clock until the job settles. The Redis mocks need real event-loop turns between awaits, so
 * the clock cannot just be advanced once up front.
 */
async function runJobAdvancingClock(app: AppHarness, name: string): Promise<void> {
  let settled = false
  const job = app.runJob(name).finally(() => { settled = true })
  while (!settled) {
    await vi.advanceTimersByTimeAsync(1000)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  await job
}

function tradeComments(app: AppHarness, postId = MONTHLY): void {
  app.reddit.addComment({ id: 't1_offer', parentId: postId, postId, authorName: 'alice', body: 'Sold a kit to u/bob' })
  app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId, authorName: 'bob', body: 'confirmed' })
}

function replyEvent(id: string, parentId: string, author: string, body: string, postId = MONTHLY) {
  return {
    comment: { id, body, parentId, postId, permalink: `/r/swaps/comments/${postId.slice(3)}/_/${id.slice(3)}/` },
    author: { name: author },
    subreddit: { name: 'swaps' },
  }
}

/** Nothing but the one trade: alice and bob at 1, a single claim, and exactly one bot reply. */
async function expectOneTradeCounted(app: AppHarness, replyTo = 't1_reply'): Promise<void> {
  expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
  expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
  expect(app.reddit.repliesTo(replyTo)).toHaveLength(1)
  expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
}

describe('monthly-post job', () => {
  test('creates the new thread, stickies it, locks the previous thread and sends the modmail', async ({ mocks }) => {
    const app = await setup(mocks)

    await app.runJob('monthly-post')

    const newId = await currentPostId(app)
    expect(newId).not.toBe(MONTHLY)
    const created = app.reddit.posts.get(newId)!
    expect(created).toMatchObject({
      authorName: 'swapbot',
      title: 'December 2026 Confirmed Trade Thread',
      stickied: true,
      locked: false,
      suggestedSort: 'NEW',
    })
    // The body links back to the previous thread by its title.
    expect(created.body).toContain('Confirmed Trade Thread')
    expect(created.body).toContain('u/swapbot')
    // The previous thread is unstickied and locked.
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ stickied: false, locked: true })
    // One modmail to the mods, pointing at the new thread.
    expect(app.reddit.modmail).toEqual([{
      subredditName: 'swaps',
      subject: 'Monthly thread is up',
      body: `Monthly trade-confirmation thread is live: /r/swaps/comments/${newId.slice(3)}/`,
      to: null,
    }])
    expect(submittedPosts(app)).toBe(1)
  })

  test('rotates again a month later: each old thread ends up locked and only the newest is stickied', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.runJob('monthly-post')
    const december = await currentPostId(app)

    vi.setSystemTime(JANUARY_FIRST)
    await app.runJob('monthly-post')

    const january = await currentPostId(app)
    expect(january).not.toBe(december)
    expect(app.reddit.posts.get(january)).toMatchObject({ title: 'January 2027 Confirmed Trade Thread', stickied: true })
    expect(app.reddit.posts.get(december)).toMatchObject({ stickied: false, locked: true })
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ stickied: false, locked: true })
    expect([...app.reddit.posts.values()].filter(p => p.stickied).map(p => p.id)).toEqual([january])
    expect(app.reddit.modmail).toHaveLength(2)
  })

  test('creates the first thread when there is no previous one and sends the modmail', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    app.reddit.posts.clear()

    await app.runJob('monthly-post')

    const created = app.reddit.posts.get(await currentPostId(app))!
    expect(created).toMatchObject({ title: 'December 2026 Confirmed Trade Thread', stickied: true })
    expect(created.body).toContain('Previous monthly thread')
    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('running again in the same month reuses the thread instead of posting a second one', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.runJob('monthly-post')
    const december = await currentPostId(app)

    vi.advanceTimersByTime(3 * HOUR_MS)
    await app.runJob('monthly-post')

    expect(await currentPostId(app)).toBe(december)
    expect(submittedPosts(app)).toBe(1)
    expect(app.reddit.modmail).toHaveLength(1)
    expect(app.reddit.posts.get(december)).toMatchObject({ stickied: true, locked: false })
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ stickied: false, locked: true })
  })

  test('re-stickies the existing thread for the month if a moderator unstickied it', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.runJob('monthly-post')
    const december = await currentPostId(app)
    app.reddit.posts.get(december)!.stickied = false

    await app.runJob('monthly-post')

    expect(await currentPostId(app)).toBe(december)
    expect(app.reddit.posts.get(december)!.stickied).toBe(true)
    expect(submittedPosts(app)).toBe(1)
  })

  test('replaces an existing thread for the month that was removed', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.runJob('monthly-post')
    const first = await currentPostId(app)
    app.reddit.posts.get(first)!.removed = true

    await app.runJob('monthly-post')

    const second = await currentPostId(app)
    expect(second).not.toBe(first)
    expect(app.reddit.posts.get(second)).toMatchObject({ stickied: true, removed: false })
    expect(submittedPosts(app)).toBe(2)
  })

  test('skips while another run holds the month claim, and runs once the claim expires', async ({ mocks }) => {
    const app = await setup(mocks)
    // Another run is mid-flight: its claim is held for 15 minutes.
    await app.ctx.redis.set('monthlyPostClaim:swaps:2026-12', String(Date.now()), {
      nx: true,
      expiration: new Date(Date.now() + 15 * 60 * 1000),
    })

    await app.runJob('monthly-post')
    expect(submittedPosts(app)).toBe(0)
    expect(await currentPostId(app)).toBe(MONTHLY)
    expect(app.reddit.modmail).toEqual([])

    vi.advanceTimersByTime(15 * 60 * 1000 + 1)
    await app.runJob('monthly-post')
    expect(submittedPosts(app)).toBe(1)
    expect(await currentPostId(app)).not.toBe(MONTHLY)
  })

  test('releases its claim when it finishes, so a later job the same month is not skipped', async ({ mocks }) => {
    const app = await setup(mocks)

    await app.runJob('monthly-post')

    expect(await app.ctx.redis.get('monthlyPostClaim:swaps:2026-12')).toBeUndefined()
  })

  test('releases its claim when posting fails, and a retry creates the thread', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('submitPost', 'Reddit is down')

    await expect(app.runJob('monthly-post')).rejects.toThrow('Reddit is down')

    expect(await app.ctx.redis.get('monthlyPostClaim:swaps:2026-12')).toBeUndefined()
    expect(await currentPostId(app)).toBe(MONTHLY)
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ stickied: true, locked: false })
    expect(app.reddit.modmail).toEqual([])

    await app.runJob('monthly-post')
    expect(await currentPostId(app)).not.toBe(MONTHLY)
    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('points at the new thread even when stickying it fails, so replies are not rejected', async ({ mocks }) => {
    const app = await setup(mocks)
    // Fail the sticky after the post exists: make every sticky on the created post reject.
    const originalSubmit = app.reddit.client.submitPost
    app.reddit.client.submitPost = async options => {
      const post = await originalSubmit(options)
      post.sticky = async () => { throw new Error('400 bad request') }
      return post
    }

    await expect(app.runJob('monthly-post')).rejects.toThrow('400 bad request')

    const newId = await currentPostId(app)
    expect(newId).not.toBe(MONTHLY)
    // The previous thread is already locked, so the pointer must not be left on it.
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ locked: true })
  })
})

describe('scheduling', () => {
  test('AppInstall schedules the monthly rotation at midnight on the 1st and the rescan at half past each hour', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)

    await app.fireTrigger('AppInstall', {})

    const cronByJob = Object.fromEntries(
      mocks.scheduler.getScheduledActions().map(a => [a.request.action?.type, a.request.cron]),
    )
    expect(cronByJob).toEqual({ 'monthly-post': '0 0 1 * *', 'rescan-monthly-post': '30 * * * *' })
    // The rescan never fires in the minute of the rotation.
    const [rescanMinute] = cronByJob['rescan-monthly-post']!.split(' ')
    expect(Number(rescanMinute)).not.toBe(0)
  })

  test('AppUpgrade after a manual job removal only schedules the missing job', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    await app.fireTrigger('AppInstall', {})
    const rescan = mocks.scheduler.getScheduledActions().find(a => a.request.action?.type === 'rescan-monthly-post')!
    await app.ctx.scheduler.cancelJob(rescan.id)

    await app.fireTrigger('AppUpgrade', {})

    const types = mocks.scheduler.getScheduledActions().map(a => a.request.action?.type).sort()
    expect(types).toEqual(['monthly-post', 'rescan-monthly-post'])
  })

  test('the "Trigger monthly post now" menu item schedules a one-off monthly-post run', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)

    await app.pressMenuItem('Trigger monthly post now')

    const types = mocks.scheduler.getScheduledActions().map(a => a.request.action?.type)
    expect(types).toEqual(['monthly-post'])
  })
})

describe('rescan-monthly-post job', () => {
  test('processes a confirmation whose trigger was missed, then logs the result', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await app.runJob('rescan-monthly-post')

    await expectOneTradeCounted(app)
    expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!)).toMatchObject({
      commentId: 't1_reply',
      parentAuthor: 'alice',
      confirmer: 'bob',
      modApproval: false,
    })
    expect(log).toHaveBeenCalledWith('Hourly rescan: 2 comments, 1 newly processed')
  })

  test('does nothing when no monthly thread is recorded', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    tradeComments(app)

    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(app.reddit.calls.filter(c => c.method === 'getComments')).toEqual([])
  })

  test('running the rescan again, hour after hour, never counts the trade twice', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    await app.runJob('rescan-monthly-post')
    const writesAfterFirst = app.reddit.calls.filter(c => c.method === 'setUserFlair' || c.method === 'setUserFlairBatch').length
    const claim = await app.ctx.redis.get('confirmed:t1_offer')

    for (let hour = 0; hour < 5; hour++) {
      vi.advanceTimersByTime(HOUR_MS)
      await app.runJob('rescan-monthly-post')
    }

    await expectOneTradeCounted(app)
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBe(claim)
    expect(app.reddit.calls.filter(c => c.method === 'setUserFlair' || c.method === 'setUserFlairBatch')).toHaveLength(writesAfterFirst)
    expect(app.reddit.commentsBy('swapbot')).toHaveLength(1)
  })

  test('two rescans racing on the same missed confirmation count it once', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)

    await Promise.allSettled([app.runJob('rescan-monthly-post'), app.runJob('rescan-monthly-post')])
    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.commentsBy('swapbot')).toHaveLength(1)
  })

  test('the trigger and then the rescan on the same confirmation count it once', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_offer', parentId: MONTHLY, postId: MONTHLY, authorName: 'alice', body: 'Sold a kit to u/bob' })
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))
    await expectOneTradeCounted(app)

    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    await app.runJob('rescan-monthly-post')

    await expectOneTradeCounted(app)
  })

  test('the rescan and then a late trigger delivery on the same confirmation count it once', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    await app.runJob('rescan-monthly-post')
    await expectOneTradeCounted(app)

    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))

    await expectOneTradeCounted(app)
    expect(app.reddit.commentsBy('swapbot')).toHaveLength(1)
  })

  test('the trigger and the rescan running at the same time count the confirmation once', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)

    await Promise.allSettled([
      app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed')),
      app.runJob('rescan-monthly-post'),
    ])
    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.commentsBy('swapbot')).toHaveLength(1)
  })

  test('finishes a confirmation the trigger committed but could not flair, without recounting it', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    app.reddit.failNext('setUserFlair', '500 server error')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed')).catch(() => {})
    const countedByTrigger = await app.ctx.redis.get('confirmations:alice')
    expect(countedByTrigger).toBe('1')

    vi.advanceTimersByTime(HOUR_MS)
    await app.runJob('rescan-monthly-post')
    vi.advanceTimersByTime(HOUR_MS)
    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.commentsBy('swapbot')).toHaveLength(1)
  })

  test('counts two different trades in one rescan, each once, spacing the bot replies by the comment slot', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    app.reddit.addComment({ id: 't1_offer2', parentId: MONTHLY, postId: MONTHLY, authorName: 'carol', body: 'Bought from u/dave' })
    app.reddit.addComment({ id: 't1_reply2', parentId: 't1_offer2', postId: MONTHLY, authorName: 'dave', body: 'confirmed' })

    // The second reply waits for the 6.5s comment-submit slot; fake timers run that wait instantly.
    await runJobAdvancingClock(app, 'rescan-monthly-post')
    vi.advanceTimersByTime(HOUR_MS)
    await app.runJob('rescan-monthly-post')

    for (const user of ['alice', 'bob', 'carol', 'dave']) {
      expect(await app.ctx.redis.get(`confirmations:${user}`)).toBe('1')
    }
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(app.reddit.repliesTo('t1_reply2')).toHaveLength(1)
  })
})

describe('monthly rotation and the rescan together', () => {
  test('after the rotation the rescan scans the new thread and no longer counts trades in the locked one', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    await app.runJob('monthly-post')
    const december = await currentPostId(app)
    expect(december).not.toBe(MONTHLY)

    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    await app.runJob('rescan-monthly-post')

    // The missed confirmation sits in the old, now locked thread: it is not counted.
    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmations:bob')).toBeUndefined()
    expect(app.reddit.calls.filter(c => c.method === 'getComments').at(-1)!.args[0]).toMatchObject({ postId: december })

    // A trade in the new thread is.
    app.reddit.addComment({ id: 't1_offer_new', parentId: december, postId: december, authorName: 'alice', body: 'Sold a kit to u/bob' })
    app.reddit.addComment({ id: 't1_reply_new', parentId: 't1_offer_new', postId: december, authorName: 'bob', body: 'confirmed' })
    vi.advanceTimersByTime(HOUR_MS)
    await app.runJob('rescan-monthly-post')
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
  })
})
