/**
 * Tests for the race-scenario Redis adapter (tests/harness/redisAdapter.ts): the interleaving hooks
 * on the default RedisMock, and the real-Redis semantics the RedisMock lacks. The real-Redis tests
 * run only when REDIS_URL is set (see docs/testing.md).
 */
import { describe, expect } from 'vitest'
import { instrumentRedis, needsRealRedis, REDIS_URL, redisCall } from './redisAdapter.js'
import { newApp, scenarioTest as test } from './scenario.js'

describe('interleaving hooks (any backend)', () => {
  test('pause holds the first matching call until resumed', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    const redis = instrumentRedis(mocks, { backend: 'mock' })
    const pause = redis.pause(redisCall('Set', 'k'))

    const write = ctx.redis.set('k', 'v')
    const call = await pause.reached
    expect(call).toMatchObject({ method: 'Set', keys: ['k'] })
    expect(await ctx.redis.get('k')).toBeUndefined()

    pause.resume()
    await write
    expect(await ctx.redis.get('k')).toBe('v')
  })

  test('before runs code ahead of a matching call, every time unless once', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    const redis = instrumentRedis(mocks, { backend: 'mock' })
    const seen: string[] = []
    redis.before(redisCall('Get'), call => { seen.push(call.keys[0]) })
    await ctx.redis.get('a')
    await ctx.redis.get('b')
    expect(seen).toEqual(['a', 'b'])
  })

  test('calls inside a transaction carry the transaction id and keys are reported without the test prefix', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    const redis = instrumentRedis(mocks, { backend: 'mock' })
    const tx = await ctx.redis.watch('a')
    await tx.multi()
    await tx.set('a', '1')
    await tx.exec()
    const [watch, multi, set, exec] = redis.calls
    expect(watch).toMatchObject({ method: 'Watch', keys: ['a'] })
    expect(multi.method).toBe('Multi')
    expect(set).toMatchObject({ method: 'Set', keys: ['a'] })
    expect(set.transaction).toBeDefined()
    expect(set.transaction).toBe(exec.transaction)
  })

  test('instrumenting twice is refused', async ({ mocks }) => {
    newApp(mocks)
    instrumentRedis(mocks, { backend: 'mock' })
    expect(() => instrumentRedis(mocks, { backend: 'mock' })).toThrow('already instrumented')
  })
})

describe.skipIf(!REDIS_URL)(needsRealRedis('real Redis backend'), () => {
  test('EXEC is discarded when a watched key was changed by another writer', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    instrumentRedis(mocks, { backend: 'real' })
    const tx = await ctx.redis.watch('a')
    await ctx.redis.set('a', 'changed-by-another-writer')
    await tx.multi()
    await tx.set('a', 'mine')
    expect(await tx.exec()).toEqual([])
    expect(await ctx.redis.get('a')).toBe('changed-by-another-writer')
  })

  test('EXEC applies when nothing watched changed', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    instrumentRedis(mocks, { backend: 'real' })
    const tx = await ctx.redis.watch('a')
    await tx.multi()
    await tx.set('a', '1')
    await tx.set('b', '2')
    expect(await tx.exec()).toEqual(['OK', 'OK'])
    expect(await ctx.redis.get('b')).toBe('2')
  })

  test('a failed SET NX inside EXEC reports null, like real Devvit Redis', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    instrumentRedis(mocks, { backend: 'real' })
    await ctx.redis.set('claim', 'existing')
    const tx = await ctx.redis.watch('other')
    await tx.multi()
    await tx.set('claim', 'new', { nx: true })
    expect(await tx.exec()).toEqual([null])
    expect(await ctx.redis.get('claim')).toBe('existing')
  })

  test('keys are isolated per test: a second world does not see the first', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    instrumentRedis(mocks, { backend: 'real' })
    await ctx.redis.set('isolated', '1')
    expect(await ctx.redis.get('isolated')).toBe('1')
  })

  test('keys written by an earlier test were cleared with it', async ({ mocks }) => {
    const { ctx } = newApp(mocks)
    instrumentRedis(mocks, { backend: 'real' })
    expect(await ctx.redis.get('isolated')).toBeUndefined()
  })
})
