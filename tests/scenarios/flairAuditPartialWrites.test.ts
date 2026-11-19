/**
 * Adversarial regression tests for flair writes that half-succeed (flaircsv fallback) and for a
 * confirmation replayed after a moderator corrected the count by hand.
 *
 * Both probes found bugs that are now fixed: manual adjustments take the flair lock and never undo a
 * count that moved on or a flair text that was already written, and a confirmation's flair step only
 * writes while the stored count is still the one it committed.
 */
import { describe, expect, vi } from 'vitest'
import { adjustUserTradeCount } from '../../src/adjustments.js'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

vi.mock('../../src/utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils.js')>(),
  sleep: vi.fn(async () => {}),
}))

const MONTHLY = 't3_monthly'

async function setup(mocks: Parameters<typeof newApp>[0]): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return app
}

describe('flair writes that half-succeed', () => {
  test('a manual adjustment whose flaircsv text write succeeded but whose template retry then fails keeps count and flair in step', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '9')
    app.reddit.setFlair('alice', 'Trades: 9')
    const original = app.reddit.client.setUserFlair
    let calls = 0
    app.reddit.client.setUserFlair = async options => {
      calls++
      if (calls === 1) throw new Error('404 not found')
      if (calls === 2) throw new Error('500 server error')
      return original(options)
    }

    await expect(adjustUserTradeCount(app.ctx, 'alice', 120)).rejects.toThrow('500 server error')

    // adjustUserTradeCount restored the old count, so the flair must not keep showing the new one.
    const stored = await app.ctx.redis.get('confirmations:alice')
    expect(app.reddit.flairOf('alice')?.text).toBe(`Trades: ${stored}`)
  })

  test('a confirmation whose flair write failed does not overwrite a count a moderator set by hand before the rescan', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '10')
    await app.ctx.redis.set('confirmations:bob', '1')
    app.reddit.setFlair('alice', 'Trades: 10')
    app.reddit.addComment({ id: 't1_offer1', parentId: MONTHLY, postId: MONTHLY, authorName: 'alice', body: 'Sold a kit to u/bob' })
    app.reddit.addComment({ id: 't1_reply1', parentId: 't1_offer1', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
    const c = app.reddit.comments.get('t1_reply1')!
    app.reddit.failNext('setUserFlair', 'Reddit exploded')
    await expect(app.fireTrigger('CommentSubmit', {
      comment: { id: c.id, body: c.body, parentId: c.parentId, postId: c.postId, permalink: '/r/swaps/comments/monthly/_/t1_reply1/' },
      author: { name: 'bob' },
      subreddit: { name: 'swaps' },
    })).rejects.toThrow('Reddit exploded')
    // The confirmation committed alice=11; a moderator notices the stale flair and sets 5 by hand.
    await adjustUserTradeCount(app.ctx, 'alice', 5)

    await app.runJob('rescan-monthly-post')

    const stored = await app.ctx.redis.get('confirmations:alice')
    expect(app.reddit.flairOf('alice')?.text).toBe(`Trades: ${stored}`)
  })
})
