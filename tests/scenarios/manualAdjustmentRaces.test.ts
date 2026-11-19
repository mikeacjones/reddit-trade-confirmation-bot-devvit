/**
 * Race probes for the count write and the rollback in `adjustUserTradeCount` (src/adjustments.ts): when the flair write
 * fails the count is restored only while it still holds the value the adjustment wrote, using
 * WATCH/MULTI/EXEC on the count key.
 *
 * The RedisMock cannot abort EXEC when a watched key changed, so the interleaving that matters (a
 * confirmation committing between the compare and the restore) only runs against a real Redis:
 *
 *   REDIS_URL=redis://localhost:6379 npm test
 */
import { describe, expect, vi } from 'vitest'
import { adjustUserTradeCount } from '../../src/adjustments.js'
import { instrumentRedis, needsRealRedis, REDIS_URL, redisCall } from '../harness/redisAdapter.js'
import { newApp, scenarioTest as test, seedSwapsWorld } from '../harness/scenario.js'

vi.mock('../../src/utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils.js')>(),
  sleep: vi.fn(async () => {}),
}))

describe.skipIf(!REDIS_URL)(needsRealRedis('manual adjustment rollback races'), () => {
  test('a trade committed between the rollback compare and its EXEC aborts the restore and survives', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    const redis = instrumentRedis(mocks, { backend: 'real' })
    await app.ctx.redis.set('confirmations:alice', '9')
    app.reddit.failNext('setUserFlair', 'Reddit exploded')
    // The rollback has read its own value back and is about to restore 9 when a confirmation commits 121.
    // The first EXEC is the count swap, the second is the rollback's.
    let execs = 0
    redis.before(redisCall('Exec'), async () => {
      if (++execs === 2) await app.ctx.redis.set('confirmations:alice', '121')
    })

    await expect(adjustUserTradeCount(app.ctx, 'alice', 120)).rejects.toThrow('Reddit exploded')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('121')
    // The aborted EXEC sent the rollback round again, which then saw 121 and left it alone.
    expect(redis.calls.filter(c => c.method === 'Watch')).toHaveLength(3)
  })

  test('an untouched count is restored to its previous value, and a never-stored one is removed', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    instrumentRedis(mocks, { backend: 'real' })
    await app.ctx.redis.set('confirmations:alice', '9')
    app.reddit.failNext('setUserFlair', 'Reddit exploded', 2)

    await expect(adjustUserTradeCount(app.ctx, 'alice', 120)).rejects.toThrow('Reddit exploded')
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('9')

    await expect(adjustUserTradeCount(app.ctx, 'carol', 120)).rejects.toThrow('Reddit exploded')
    expect(await app.ctx.redis.get('confirmations:carol')).toBeUndefined()
  })

  test('a failed set restores the count it actually overwrote, not an earlier read that a committed trade has passed', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    const redis = instrumentRedis(mocks, { backend: 'real' })
    await app.ctx.redis.set('confirmations:alice', '9')
    // A confirmation commits alice's 10th trade after the manual set read 9 and before its EXEC writes 120.
    // Only a real Redis aborts that EXEC (the RedisMock cannot), so the swap reads 10 on its retry.
    let seenByInjection: string | undefined
    redis.before(redisCall('Exec'), async () => {
      seenByInjection = await app.ctx.redis.get('confirmations:alice')
      await app.ctx.redis.set('confirmations:alice', '10')
    }, { once: true })
    app.reddit.failNext('setUserFlair', 'Reddit exploded')

    await expect(adjustUserTradeCount(app.ctx, 'alice', 120)).rejects.toThrow('Reddit exploded')

    expect(seenByInjection).toBe('9') // the commit landed before the manual write, not during the rollback
    // The committed trade (10) must survive the failed manual set; restoring the stale read loses it.
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('10')
  })
})
