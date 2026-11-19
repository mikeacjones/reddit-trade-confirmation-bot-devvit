/**
 * Adversarial audit of the moderator cache (src/moderators.ts) as the app uses it: staleness and
 * expiry, the ModAction trigger, a damaged cache entry, Reddit failing while the list is read, and
 * the case of moderator names. Driven through the real triggers and the real confirmation flow
 * registered by src/main.ts.
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG:` comment. This audit does not fix src/.
 *
 * Time is pinned with vitest fake timers (setImmediate stays real: the Redis mocks need it).
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { runWithClock } from '../harness/clock.js'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const MONTHLY = 't3_monthly'
const HOUR = 60 * 60 * 1000

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

const cachedMods = async (app: AppHarness): Promise<string[] | undefined> => {
  const raw = await app.ctx.redis.get('moderators')
  return raw === undefined ? undefined : JSON.parse(raw).usernames
}

/** Fires a trigger and runs the fake clock until it settles, for flows that wait on the reply slot or a lock. */
const fire = (app: AppHarness, event: string, payload: Record<string, unknown>) => runWithClock(app.fireTrigger(event, payload))

/** alice offers a trade to `partner`, who confirms it. Returns the confirming comment's event. */
function trade(app: AppHarness, partner: string, offerId = 't1_offer', replyId = 't1_reply') {
  app.reddit.addComment({ id: offerId, parentId: MONTHLY, postId: MONTHLY, authorName: 'alice', body: `Sold a kit to u/${partner}` })
  app.reddit.addComment({ id: replyId, parentId: offerId, postId: MONTHLY, authorName: partner, body: 'confirmed' })
  return {
    comment: { id: replyId, body: 'confirmed', parentId: offerId, postId: MONTHLY, permalink: `/r/swaps/comments/monthly/_/${replyId}/` },
    author: { name: partner },
    subreddit: { name: 'swaps' },
  }
}

describe('expiry and staleness', () => {
  test('the cached list is served for 12 hours, then Reddit is asked again', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.fireTrigger('AppInstall', {})
    app.reddit.addModerator('newmod')
    const asked = () => app.reddit.calls.filter(c => c.method === 'getModerators').length
    expect(asked()).toBe(1)

    await vi.advanceTimersByTimeAsync(12 * HOUR - 30_000)
    await fire(app, 'CommentSubmit', trade(app, 'newmod'))
    expect(asked()).toBe(1)
    expect(app.reddit.flairOf('newmod')?.text).toBe('Trades: 1')

    await vi.advanceTimersByTimeAsync(30_000)
    await fire(app, 'CommentSubmit', trade(app, 'newmod', 't1_offer2', 't1_reply2'))
    expect(asked()).toBe(2)
    expect(await cachedMods(app)).toEqual(['mod1', 'newmod'])
    expect(app.reddit.flairOf('newmod')).toEqual({ text: 'Moderator | Trades: 2', flairTemplateId: 'tpl-mod' })
  })

  test('every membership-changing ModAction refreshes the cache; other actions and a missing action do not', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.fireTrigger('AppInstall', {})
    const asked = () => app.reddit.calls.filter(c => c.method === 'getModerators').length

    for (const action of ['addmoderator', 'acceptmoderatorinvite', 'removemoderator', 'setpermissions', 'reordermoderators']) {
      const before = asked()
      await app.fireTrigger('ModAction', { action, subreddit: { name: 'swaps' } })
      expect(asked(), action).toBe(before + 1)
    }

    const before = asked()
    for (const action of ['banuser', 'removelink', 'invitemoderator', 'ADDMODERATOR', '', undefined]) {
      await app.fireTrigger('ModAction', { action, subreddit: { name: 'swaps' } })
    }
    await app.fireTrigger('ModAction', {})
    expect(asked()).toBe(before)
  })

  test('a ModAction without a subreddit name falls back to the current subreddit', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addModerator('another')

    await app.fireTrigger('ModAction', { action: 'addmoderator' })
    await app.fireTrigger('ModAction', { action: 'addmoderator', subreddit: { name: '' } })

    expect(await cachedMods(app)).toEqual(['another', 'mod1'])
  })

  test('a refresh that fails leaves the previous list in place, and the ModAction reports the failure', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.fireTrigger('AppInstall', {})
    app.reddit.addModerator('newmod')
    app.reddit.failNext('getSubredditByName', '503 Service Unavailable')

    await expect(app.fireTrigger('ModAction', { action: 'addmoderator', subreddit: { name: 'swaps' } })).rejects.toThrow('503')

    expect(await cachedMods(app)).toEqual(['mod1'])
  })
})

describe('a damaged cache entry', () => {
  const damaged: Array<[string, string]> = [
    ['an unterminated object', '{"usernames":["mod1"'],
    ['an empty array', '[]'],
    ['null', 'null'],
    ['a bare string', '"mod1"'],
    ['a number', '42'],
    ['usernames that is a string', '{"usernames":"mod1"}'],
    ['usernames with a non-string', '{"usernames":["mod1",7]}'],
    ['an object without usernames', '{"syncedAt":"2026-05-08T00:00:00Z"}'],
  ]
  for (const [name, raw] of damaged) {
    test(`${name} is replaced from Reddit, not trusted`, async ({ mocks }) => {
      const app = await setup(mocks)
      await app.ctx.redis.set('moderators', raw)

      await fire(app, 'CommentSubmit', trade(app, 'mod1'))

      expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 1', flairTemplateId: 'tpl-mod' })
      expect(await cachedMods(app)).toEqual(['mod1'])
    })
  }

  test('an empty cached string is a miss', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('moderators', '')

    await fire(app, 'CommentSubmit', trade(app, 'mod1'))

    expect(await cachedMods(app)).toEqual(['mod1'])
  })

  test('an entry written with mixed-case names still matches, and a cached empty list means nobody is a moderator', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addModerator('ModGuy')
    await app.ctx.redis.set('moderators', JSON.stringify({ usernames: ['MODGUY'], syncedAt: new Date().toISOString() }))

    await fire(app, 'CommentSubmit', trade(app, 'ModGuy'))
    expect(app.reddit.flairOf('modguy')?.flairTemplateId).toBe('tpl-mod')

    await app.ctx.redis.set('moderators', JSON.stringify({ usernames: [], syncedAt: new Date().toISOString() }))
    await fire(app, 'CommentSubmit', trade(app, 'ModGuy', 't1_offer2', 't1_reply2'))
    expect(app.reddit.flairOf('modguy')).toEqual({ text: 'Trades: 2', flairTemplateId: 'tpl-0' })
  })
})

describe('names and the list from Reddit', () => {
  test('a moderator listed twice, or in another case, is counted once and the name matches in any case', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addModerator('Alpha')
    app.reddit.moderators.add('alpha')

    const toasts = (await app.pressMenuItem('Refresh moderator cache')).toasts

    expect(toasts).toEqual(['Moderator cache refreshed (2 mods)'])
    for (const name of ['ALPHA', 'alpha', 'Alpha']) {
        await fire(app, 'CommentSubmit', trade(app, name, `t1_o_${name}`, `t1_r_${name}`))
    }
    expect(app.reddit.flairOf('alpha')?.flairTemplateId).toBe('tpl-mod')
  })

  test('an Reddit read that fails while the list is needed stops the confirmation before anything is counted, and a redelivery succeeds once', async ({ mocks }) => {
    const app = await setup(mocks)
    const event = trade(app, 'mod1')
    app.reddit.failNext('getSubredditByName', '503 Service Unavailable')

    await expect(fire(app, 'CommentSubmit', event)).rejects.toThrow('503')

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
    expect(await app.ctx.redis.get('processing:t1_reply')).toBeUndefined()
    expect(await app.ctx.redis.get('processed:t1_reply')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(0)

    await fire(app, 'CommentSubmit', event)
    await fire(app, 'CommentSubmit', event)

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:mod1')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  // BUG: refreshModeratorCache stores whatever list Reddit returns, so an empty list (a bad response; the app account is always a moderator) is cached for 12 hours and every real moderator is flaired as an ordinary trader until then, severity low
  test.fails('does not cache an empty moderator list for 12 hours', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.moderators.clear()
    await app.fireTrigger('AppInstall', {})
    app.reddit.addModerator('mod1')

    await fire(app, 'CommentSubmit', trade(app, 'mod1'))

    expect(app.reddit.flairOf('mod1')?.flairTemplateId).toBe('tpl-mod')
  })
})
