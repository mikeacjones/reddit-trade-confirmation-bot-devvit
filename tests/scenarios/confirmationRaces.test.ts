/**
 * Adversarial race probes for the atomic commit in `commitConfirmation` (src/confirmations.ts):
 * WATCH on the claim key and both count keys, GET, MULTI, `SET confirmed:<id> NX` + count writes, EXEC,
 * and the retry loop around it.
 *
 * The RedisMock behind `@devvit/test` neither aborts EXEC on a WATCH conflict nor reports a failed
 * NX as null (docs/testing.md, "Redis"), so the lost-race scenarios run against a real Redis through
 * the adapter in tests/harness/redisAdapter.ts. They are skipped unless REDIS_URL is set:
 *
 *   docker run --rm -p 6379:6379 redis:7
 *   REDIS_URL=redis://localhost:6379 npm test
 *
 * Interleavings are controlled with explicit hooks (`pause`/`before` on the Redis calls, a held
 * `submitComment` on the Reddit fake), never with timers or sleeps: a flow is started, held at a named
 * point, the competing flow runs to completion, and the held flow is released.
 *
 * Probes that found a bug are `it.fails` repros with a `// BUG:` comment; they turn red once the bug
 * is fixed, which is the signal to turn them into ordinary tests.
 */
import { describe, expect } from 'vitest'
import {
  instrumentRedis,
  needsRealRedis,
  REDIS_URL,
  redisCall,
  type Pause,
  type RedisHarness,
} from '../harness/redisAdapter.js'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const MONTHLY = 't3_monthly'

function eventFor(comment: { id: string; body: string; parentId: string }, author: string) {
  return {
    comment: { ...comment, postId: MONTHLY, permalink: `/r/swaps/comments/monthly/_/${comment.id.slice(3)}/` },
    author: { name: author },
    subreddit: { name: 'swaps' },
  }
}

interface World {
  app: AppHarness
  redis: RedisHarness
}

/** The usual subreddit with Redis instrumented, and the bot's reply spacing slot freed on every claim. */
async function world(mocks: Parameters<typeof newApp>[0], backend: 'mock' | 'real' = 'real'): Promise<World> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  const redis = instrumentRedis(mocks, { backend })
  freeCommentSubmitSlotOnEveryClaim(mocks, app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return { app, redis }
}

/**
 * The bot spaces its comment submissions with a Redis slot (`SET … NX`) that expires after a few real
 * seconds; free it by hand instead of sleeping through the expiry. Freeing and claiming are one
 * critical section: with two replies in flight, the calls could run `del, del, set, set`, and the
 * second claim would fail and sleep for the full spacing (seen with a Dockerised Redis).
 */
function freeCommentSubmitSlotOnEveryClaim(mocks: Parameters<typeof newApp>[0], app: AppHarness): void {
  const slot = 'reddit:comment-submit-slot'
  const plugin = mocks.redis.plugin as unknown as { Set: (request: { key: string }, ...rest: unknown[]) => Promise<unknown> }
  const claim = plugin.Set.bind(plugin)
  let queue: Promise<unknown> = Promise.resolve()
  plugin.Set = (request, ...rest) => {
    if (request.key !== slot) return claim(request, ...rest)
    const turn = queue.then(async () => {
      await app.ctx.redis.del(slot)
      return claim(request, ...rest)
    })
    queue = turn.catch(() => undefined)
    return turn
  }
}

function addOffer(app: AppHarness, id: string, author: string, body: string): void {
  app.reddit.addComment({ id, parentId: MONTHLY, postId: MONTHLY, authorName: author, body })
}

/** Add a confirming reply and return the CommentSubmit event for it. */
function addReply(app: AppHarness, id: string, parentId: string, author: string, body = 'confirmed') {
  app.reddit.addComment({ id, parentId, postId: MONTHLY, authorName: author, body })
  return eventFor({ id, body, parentId }, author)
}

/** Hold the first bot reply the Reddit fake is asked to post, until resumed. */
function holdNextReply(app: AppHarness): Pause {
  const { client } = app.reddit
  const submit = client.submitComment
  let resume!: () => void
  let reached!: (call: { id: string }) => void
  const gate = new Promise<void>(r => { resume = r })
  const reachedPromise = new Promise<{ id: string }>(r => { reached = r })
  let held = false
  client.submitComment = async options => {
    if (!held) {
      held = true
      reached(options)
      await gate
    }
    return submit(options)
  }
  return { reached: reachedPromise as Promise<never>, resume }
}

/** The points of commitConfirmation where a flow is held while a competing flow runs. */
const pausePoints: Array<[string, (claimKey: string) => ReturnType<typeof redisCall>]> = [
  ['at WATCH', key => redisCall('Watch', key)],
  ['at the GET of the claim key', key => redisCall('Get', key)],
  ['at EXEC', () => redisCall('Exec')],
]

const botReplies = (app: AppHarness, id: string) => app.reddit.repliesTo(id).filter(r => r.authorName === 'swapbot')
/**
 * A trader's stored count. A trader who was loaded for a confirmation is seeded with 0 from their (empty)
 * flair before the claim is checked, so "not counted" reads as '0' whether or not the key was seeded.
 */
const count = async (app: AppHarness, user: string) => (await app.ctx.redis.get(`confirmations:${user}`)) ?? '0'

describe.skipIf(!REDIS_URL)(needsRealRedis('commitConfirmation races'), () => {
  describe('CommentSubmit trigger vs the hourly rescan on the same confirmation', () => {
    for (const [name, point] of pausePoints) {
      test(`the rescan skips a comment the trigger holds while the trigger is paused ${name}`, async ({ mocks }) => {
        const { app, redis } = await world(mocks)
        addOffer(app, 't1_offer', 'alice', 'Sold a kit to u/bob')
        const event = addReply(app, 't1_reply', 't1_offer', 'bob')
        const pause = redis.pause(point('confirmed:t1_offer'))

        const trigger = app.fireTrigger('CommentSubmit', event)
        await pause.reached
        // The rescan walks the same comment while the trigger holds `processing:t1_reply`.
        await app.runJob('rescan-monthly-post')
        expect(await count(app, 'alice')).toBe('0')
        pause.resume()
        await trigger

        expect(await count(app, 'alice')).toBe('1')
        expect(await count(app, 'bob')).toBe('1')
        expect(botReplies(app, 't1_reply')).toHaveLength(1)
        expect(await app.ctx.redis.get('processing:t1_reply')).toBeUndefined()
        expect(await app.ctx.redis.get('processed:t1_reply')).toBe('1')
      })
    }

    test('if the processing claim is lost, the second flow replays the committed claim: one count, one reply', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      addOffer(app, 't1_offer', 'alice', 'Sold a kit to u/bob')
      const event = addReply(app, 't1_reply', 't1_offer', 'bob')
      const pause = redis.pause(redisCall('Exec'))

      const trigger = app.fireTrigger('CommentSubmit', event)
      await pause.reached
      // Simulate the 5-minute processing claim expiring while the trigger is stuck, then the rescan
      // runs the whole confirmation, including its reply.
      await app.ctx.redis.del('processing:t1_reply')
      await app.runJob('rescan-monthly-post')
      expect(await count(app, 'alice')).toBe('1')
      pause.resume()
      await trigger

      // The trigger's EXEC was aborted (the rescan changed the watched keys), it retried, found its own
      // comment in the claim and replayed instead of counting again.
      expect(redis.calls.filter(c => c.method === 'Exec')).toHaveLength(2)
      expect(await count(app, 'alice')).toBe('1')
      expect(await count(app, 'bob')).toBe('1')
      expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 1')
      expect(botReplies(app, 't1_reply')).toHaveLength(1)
    })

    // BUG: two flows replaying the same committed claim both post the confirmation reply when the second checks before the first has posted, severity low
    test.fails('only one confirmation reply is posted when a replaying flow overtakes the committing flow\'s reply', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      addOffer(app, 't1_offer', 'alice', 'Sold a kit to u/bob')
      const event = addReply(app, 't1_reply', 't1_offer', 'bob')
      const pause = redis.pause(redisCall('Exec'))

      const trigger = app.fireTrigger('CommentSubmit', event)
      await pause.reached
      await app.ctx.redis.del('processing:t1_reply')
      // The rescan commits, then is held just before it posts its reply.
      const held = holdNextReply(app)
      const rescan = app.runJob('rescan-monthly-post')
      await held.reached
      expect(await count(app, 'alice')).toBe('1')
      // The trigger's EXEC aborts, it replays the claim, sees no bot reply yet, and posts its own.
      pause.resume()
      await trigger
      held.resume()
      await rescan

      expect(await count(app, 'alice')).toBe('1')
      // Expected: one reply. Actual: both flows reply, so the thread gets two confirmations.
      expect(botReplies(app, 't1_reply')).toHaveLength(1)
    })

    // The mod-menu "Approve trade confirmation" does not take the processing claim, so unlike the
    // rescan it can overlap the trigger on the same comment without any claim expiry.
    test('a moderator approval racing the trigger for the same comment counts the trade once', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      addOffer(app, 't1_offer', 'alice', 'Sold a kit to u/bob')
      const event = addReply(app, 't1_reply', 't1_offer', 'bob')
      const pause = redis.pause(redisCall('Exec'))

      const trigger = app.fireTrigger('CommentSubmit', event)
      await pause.reached
      const effects = await app.pressMenuItem('Approve trade confirmation', { targetId: 't1_reply' })
      pause.resume()
      await trigger

      expect(effects.toasts[0]).toContain('Approved confirmation for u/alice and u/bob')
      expect(await count(app, 'alice')).toBe('1')
      expect(await count(app, 'bob')).toBe('1')
      expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 1')
      expect(botReplies(app, 't1_reply')).toHaveLength(1)
    })
  })

  describe('two different confirmers reply to the same trade comment', () => {
    test('paused at EXEC: the later committer wins, the other is refused and counted nowhere', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      addOffer(app, 't1_offer', 'alice', 'Sold kits to u/bob and u/carol')
      const bob = addReply(app, 't1_bob', 't1_offer', 'bob')
      const carol = addReply(app, 't1_carol', 't1_offer', 'carol')
      const pause = redis.pause(redisCall('Exec'))

      const first = app.fireTrigger('CommentSubmit', bob)
      await pause.reached
      await app.fireTrigger('CommentSubmit', carol)
      pause.resume()
      await first

      expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!).commentId).toBe('t1_carol')
      expect(await count(app, 'alice')).toBe('1')
      expect(await count(app, 'carol')).toBe('1')
      expect(await count(app, 'bob')).toBe('0')
      expect(app.reddit.flairOf('bob')).toBeUndefined()
      expect(botReplies(app, 't1_carol')[0].body).toContain('Trades: 1')
      expect(botReplies(app, 't1_bob')).toHaveLength(1)
      expect(botReplies(app, 't1_bob')[0].body).toContain('already been confirmed')
      // Bob's first EXEC was discarded; his retry saw carol's claim and stopped without a second EXEC.
      expect(redis.calls.filter(c => c.method === 'Exec')).toHaveLength(2)
    })

    for (const [name, point] of pausePoints) {
      if (name === 'at EXEC') continue
      test(`paused ${name}: still exactly one winner`, async ({ mocks }) => {
        const { app, redis } = await world(mocks)
        addOffer(app, 't1_offer', 'alice', 'Sold kits to u/bob and u/carol')
        const bob = addReply(app, 't1_bob', 't1_offer', 'bob')
        const carol = addReply(app, 't1_carol', 't1_offer', 'carol')
        const pause = redis.pause(point('confirmed:t1_offer'))

        const first = app.fireTrigger('CommentSubmit', bob)
        await pause.reached
        await app.fireTrigger('CommentSubmit', carol)
        pause.resume()
        await first

        expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!).commentId).toBe('t1_carol')
        expect(await count(app, 'alice')).toBe('1')
        expect(await count(app, 'bob')).toBe('0')
        expect(botReplies(app, 't1_bob')[0].body).toContain('already been confirmed')
      })
    }

    test('started together with no ordering control: one confirmation is recorded whoever wins', async ({ mocks }) => {
      const { app } = await world(mocks)
      addOffer(app, 't1_offer', 'alice', 'Sold kits to u/bob and u/carol')
      const bob = addReply(app, 't1_bob', 't1_offer', 'bob')
      const carol = addReply(app, 't1_carol', 't1_offer', 'carol')

      await Promise.all([app.fireTrigger('CommentSubmit', bob), app.fireTrigger('CommentSubmit', carol)])

      const winner = JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!).confirmer as string
      const loser = winner === 'bob' ? 'carol' : 'bob'
      expect(await count(app, 'alice')).toBe('1')
      expect(await count(app, winner)).toBe('1')
      expect(await count(app, loser)).toBe('0')
      expect(app.reddit.flairOf(loser)).toBeUndefined()
      expect(app.reddit.repliesTo('t1_bob')).toHaveLength(1)
      expect(app.reddit.repliesTo('t1_carol')).toHaveLength(1)
    })
  })

  describe('one user in two different trades at once', () => {
    test('paused at EXEC: the count key contention ends at +2 and the flair at the higher count', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      // carol is the trade comment author in trade 1 and the confirmer in trade 2.
      addOffer(app, 't1_offer1', 'carol', 'Sold a kit to u/bob')
      addOffer(app, 't1_offer2', 'dave', 'Sold a kit to u/carol')
      const trade1 = addReply(app, 't1_reply1', 't1_offer1', 'bob')
      const trade2 = addReply(app, 't1_reply2', 't1_offer2', 'carol')
      const pause = redis.pause(redisCall('Exec'))

      const first = app.fireTrigger('CommentSubmit', trade1)
      await pause.reached
      await app.fireTrigger('CommentSubmit', trade2)
      expect(await count(app, 'carol')).toBe('1')
      pause.resume()
      await first

      expect(await count(app, 'carol')).toBe('2')
      expect(await count(app, 'bob')).toBe('1')
      expect(await count(app, 'dave')).toBe('1')
      expect(app.reddit.flairOf('carol')?.text).toBe('Trades: 2')
      // The aborted trade-1 EXEC was retried against carol's new count.
      expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer1'))!)).toMatchObject({ parentPreviousCount: 1, parentCount: 2 })
    })

    test('as confirmer in both trades: +2 as well', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      addOffer(app, 't1_offer1', 'alice', 'Sold a kit to u/carol')
      addOffer(app, 't1_offer2', 'dave', 'Sold a kit to u/carol')
      const trade1 = addReply(app, 't1_reply1', 't1_offer1', 'carol')
      const trade2 = addReply(app, 't1_reply2', 't1_offer2', 'carol')
      const pause = redis.pause(redisCall('Exec'))

      const first = app.fireTrigger('CommentSubmit', trade1)
      await pause.reached
      await app.fireTrigger('CommentSubmit', trade2)
      pause.resume()
      await first

      expect(await count(app, 'carol')).toBe('2')
      expect(app.reddit.flairOf('carol')?.text).toBe('Trades: 2')
    })

    test('started together with no ordering control: +2, whoever commits first', async ({ mocks }) => {
      const { app } = await world(mocks)
      addOffer(app, 't1_offer1', 'carol', 'Sold a kit to u/bob')
      addOffer(app, 't1_offer2', 'dave', 'Sold a kit to u/carol')
      const trade1 = addReply(app, 't1_reply1', 't1_offer1', 'bob')
      const trade2 = addReply(app, 't1_reply2', 't1_offer2', 'carol')

      await Promise.all([app.fireTrigger('CommentSubmit', trade1), app.fireTrigger('CommentSubmit', trade2)])

      expect(await count(app, 'carol')).toBe('2')
      expect(app.reddit.flairOf('carol')?.text).toBe('Trades: 2')
    })

    test('the slower flow does not roll the flair back to the lower count', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      addOffer(app, 't1_offer1', 'carol', 'Sold a kit to u/bob')
      addOffer(app, 't1_offer2', 'dave', 'Sold a kit to u/carol')
      const trade1 = addReply(app, 't1_reply1', 't1_offer1', 'bob')
      const trade2 = addReply(app, 't1_reply2', 't1_offer2', 'carol')
      const exec = redis.pause(redisCall('Exec'))

      const first = app.fireTrigger('CommentSubmit', trade1)
      await exec.reached
      // Trade 2 commits (carol = 1) but is held before it takes carol's flair lock.
      const flair = redis.pause(redisCall('Set', 'userFlairLock:swaps:carol'))
      const second = app.fireTrigger('CommentSubmit', trade2)
      await flair.reached
      expect(await count(app, 'carol')).toBe('1')
      // Trade 1 retries, commits carol = 2 and sets her flair.
      exec.resume()
      await first
      expect(app.reddit.flairOf('carol')?.text).toBe('Trades: 2')
      // Trade 2 now applies its flair: the stored count is already higher, so it leaves the flair alone.
      flair.resume()
      await second

      expect(await count(app, 'carol')).toBe('2')
      expect(app.reddit.flairOf('carol')?.text).toBe('Trades: 2')
    })
  })

  describe('the 5-attempt retry runs out', () => {
    async function exhausted(mocks: Parameters<typeof newApp>[0]) {
      const w = await world(mocks)
      addOffer(w.app, 't1_offer', 'alice', 'Sold a kit to u/bob')
      const event = addReply(w.app, 't1_reply', 't1_offer', 'bob')
      // Another writer bumps alice's count right before every EXEC, so every attempt is discarded.
      let bumps = 0
      const stop = w.redis.before(redisCall('Exec'), async () => {
        await w.app.ctx.redis.set('confirmations:alice', String(++bumps))
      })
      return { ...w, event, stop, bumps: () => bumps }
    }

    test('the trigger fails loudly after five attempts, counts nothing of its own and leaves no claim', async ({ mocks }) => {
      const { app, redis, event, bumps } = await exhausted(mocks)

      await expect(app.fireTrigger('CommentSubmit', event)).rejects.toThrow('Failed to atomically commit confirmation confirmed:t1_offer')

      expect(redis.calls.filter(c => c.method === 'Exec')).toHaveLength(5)
      expect(bumps()).toBe(5)
      // Only the competing writer's values are in Redis: no claim, no count for bob, nothing doubled.
      expect(await count(app, 'alice')).toBe('5')
      expect(await count(app, 'bob')).toBe('0')
      expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
      // No flair, no reply; the comment is neither "processed" nor stuck "processing", so a rescan retries it.
      expect(app.reddit.flairOf('bob')).toBeUndefined()
      expect(app.reddit.repliesTo('t1_reply')).toHaveLength(0)
      expect(await app.ctx.redis.get('processed:t1_reply')).toBeUndefined()
      expect(await app.ctx.redis.get('processing:t1_reply')).toBeUndefined()
    })

    test('the hourly rescan survives the exhausted comment, and the next rescan commits it once', async ({ mocks }) => {
      const { app, stop } = await exhausted(mocks)

      // The rescan logs the failure and carries on: it does not throw.
      await app.runJob('rescan-monthly-post')

      expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
      expect(app.reddit.repliesTo('t1_reply')).toHaveLength(0)

      stop()
      await app.runJob('rescan-monthly-post')
      await app.runJob('rescan-monthly-post')

      // alice's 5 came from the competing writer; the confirmation adds exactly one.
      expect(await count(app, 'alice')).toBe('6')
      expect(await count(app, 'bob')).toBe('1')
      expect(botReplies(app, 't1_reply')).toHaveLength(1)
    })

    test('the moderator menu reports the failure instead of crashing', async ({ mocks }) => {
      const { app } = await exhausted(mocks)

      const effects = await app.pressMenuItem('Approve trade confirmation', { targetId: 't1_reply' })

      expect(effects.toasts).toEqual(['Failed to atomically commit confirmation confirmed:t1_offer'])
      expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
    })
  })

  describe('a claim written between the reads and EXEC', () => {
    test('is detected by WATCH: the loser is refused with already_confirmed and nothing is overwritten', async ({ mocks }) => {
      const { app, redis } = await world(mocks)
      addOffer(app, 't1_offer', 'alice', 'Sold a kit to u/bob')
      const event = addReply(app, 't1_reply', 't1_offer', 'bob')
      const competitor = JSON.stringify({ commentId: 't1_other', parentCount: 1, confirmerCount: 1 })
      redis.before(redisCall('Exec'), () => app.ctx.redis.set('confirmed:t1_offer', competitor), { once: true })

      await app.fireTrigger('CommentSubmit', event)

      expect(await app.ctx.redis.get('confirmed:t1_offer')).toBe(competitor)
      expect(await count(app, 'alice')).toBe('0')
      expect(await count(app, 'bob')).toBe('0')
      expect(app.reddit.repliesTo('t1_reply')[0].body).toContain('already been confirmed')
    })
  })
})

describe('SET NX inside EXEC answering "" (the RedisMock behaviour)', () => {
  // The RedisMock answers '' where real Devvit Redis answers null. With a real EXEC this cannot
  // happen, because WATCH on the claim key discards the transaction first, so this is a robustness
  // gap rather than a live data-loss bug: commitConfirmation only treats null/false as a lost claim.
  // BUG: commitConfirmation treats '' (a failed SET NX reply) as a won claim and double-confirms, severity low
  test.fails('a failed claim reported as "" is treated as lost, not committed', async ({ mocks }) => {
    const { app, redis } = await world(mocks, 'mock')
    addOffer(app, 't1_offer', 'alice', 'Sold a kit to u/bob')
    const event = addReply(app, 't1_reply', 't1_offer', 'bob')
    const competitor = JSON.stringify({ commentId: 't1_other', parentCount: 1, confirmerCount: 1 })
    // Another writer claims the trade after our reads, before EXEC. The mock does not abort EXEC, so
    // the queued `SET confirmed:t1_offer NX` fails inside it and answers ''.
    redis.before(redisCall('Exec'), () => app.ctx.redis.set('confirmed:t1_offer', competitor), { once: true })

    await app.fireTrigger('CommentSubmit', event)

    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBe(competitor)
    expect(app.reddit.repliesTo('t1_reply')[0].body).toContain('already been confirmed')
  })
})
