/**
 * Characterises where the Redis behind @devvit/test (ioredis-mock) differs from real Devvit Redis.
 * These tests pass today because they pin the *mock's* behaviour; if @devvit/test is upgraded and
 * one starts failing, the gap has closed and docs/testing.md and the harness can be simplified.
 * See docs/testing.md, "Redis".
 */
import { describe, expect } from 'vitest'
import { newApp, scenarioTest as test } from './scenario.js'

describe('@devvit/test Redis: what works for scenarios', () => {
  test('plain keys, nx and expiration behave like Redis', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    expect(await ctx.redis.set('k', 'a', { nx: true, expiration: new Date(Date.now() + 60_000) })).toBe('OK')
    expect(await ctx.redis.set('k', 'b', { nx: true })).toBe('')
    expect(await ctx.redis.get('k')).toBe('a')
    expect(await ctx.redis.expireTime('k')).toBeGreaterThan(Date.now() / 1000)
    await ctx.redis.del('k')
    expect(await ctx.redis.get('k')).toBeUndefined()
  })

  test('a WATCH/MULTI/EXEC transaction applies its writes', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    const tx = await ctx.redis.watch('a')
    await tx.multi()
    await tx.set('a', '1')
    await tx.set('b', '2')
    await tx.exec()
    expect(await ctx.redis.get('a')).toBe('1')
    expect(await ctx.redis.get('b')).toBe('2')
  })
})

describe('@devvit/test Redis: known gaps (use a real Redis for scenarios that depend on these)', () => {
  test('EXEC does not abort when a watched key was changed by someone else', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    const tx = await ctx.redis.watch('a')
    await ctx.redis.set('a', 'changed-by-another-writer')
    await tx.multi()
    await tx.set('a', 'mine')
    await tx.exec()
    // Real Redis would discard the transaction (EXEC returns null) and keep the other writer's value.
    expect(await ctx.redis.get('a')).toBe('mine')
  })

  test('a failed SET NX inside EXEC reports "" instead of null', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    await ctx.redis.set('claim', 'existing')
    const tx = await ctx.redis.watch('claim')
    await tx.multi()
    await tx.set('claim', 'new', { nx: true })
    const results = await tx.exec()
    // src/confirmations.ts treats null/false as "lost the claim"; '' would read as committed.
    expect(results[0]).toBe('')
    expect(await ctx.redis.get('claim')).toBe('existing')
  })
})
