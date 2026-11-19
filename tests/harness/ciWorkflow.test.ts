/**
 * The race scenarios (tests/scenarios/confirmationRaces.test.ts) skip themselves unless REDIS_URL is
 * set. CI cannot get it from the workflow (pipelines may not edit .github/**), so the vitest
 * globalSetup in tests/harness/globalSetup.ts starts Redis in Docker when CI is set. These tests
 * cover its decision logic with the docker calls injected, and that it is registered.
 */
import { describe, expect, it } from 'vitest'
import config from '../../vitest.config.js'
import {
  type Docker,
  isCi,
  READY_TIMEOUT_MS,
  REDIS_URL_FOR_CI,
  startRealRedis,
} from './globalSetup.js'

function fakeDocker(pings: Array<string | Error> = ['PONG'], runResult: string | Error = 'abc123\n') {
  const calls: string[] = []
  const queue = [...pings]
  const docker: Docker = {
    async runRedis() {
      calls.push('run')
      if (runResult instanceof Error) throw runResult
      return runResult
    },
    async ping(id) {
      calls.push(`ping ${id}`)
      const next = queue.length > 1 ? queue.shift()! : queue[0]!
      if (next instanceof Error) throw next
      return next
    },
    async stop(id) {
      calls.push(`stop ${id}`)
    },
  }
  return { docker, calls }
}

function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

describe('Redis globalSetup', () => {
  it('is registered as a vitest globalSetup', () => {
    expect(config.test?.globalSetup).toEqual(['tests/harness/globalSetup.ts'])
  })

  it('does nothing outside CI', async () => {
    const { docker, calls } = fakeDocker()
    const env: Record<string, string | undefined> = {}
    expect(await startRealRedis({ env, docker, ...clock() })).toBeUndefined()
    expect(calls).toEqual([])
    expect(env.REDIS_URL).toBeUndefined()
  })

  it('does nothing when REDIS_URL is already set, even in CI', async () => {
    const { docker, calls } = fakeDocker()
    const env: Record<string, string | undefined> = { CI: 'true', REDIS_URL: 'redis://elsewhere:1234' }
    expect(await startRealRedis({ env, docker, ...clock() })).toBeUndefined()
    expect(calls).toEqual([])
    expect(env.REDIS_URL).toBe('redis://elsewhere:1234')
  })

  it('treats CI=false, CI=0 and CI="" as not CI', () => {
    expect(isCi({ CI: 'false' })).toBe(false)
    expect(isCi({ CI: '0' })).toBe(false)
    expect(isCi({ CI: '' })).toBe(false)
    expect(isCi({})).toBe(false)
    expect(isCi({ CI: 'true' })).toBe(true)
    expect(isCi({ CI: '1' })).toBe(true)
  })

  it('treats an empty REDIS_URL as unset, as the adapter does', async () => {
    const { docker } = fakeDocker()
    const env: Record<string, string | undefined> = { CI: 'true', REDIS_URL: '' }
    await startRealRedis({ env, docker, ...clock() })
    expect(env.REDIS_URL).toBe(REDIS_URL_FOR_CI)
  })

  it('in CI starts redis, waits for PONG, sets REDIS_URL, and returns a stop for the container', async () => {
    const { docker, calls } = fakeDocker([new Error('not ready'), 'LOADING', 'PONG\n'])
    const env: Record<string, string | undefined> = { CI: 'true' }
    const stop = await startRealRedis({ env, docker, ...clock() })
    expect(env.REDIS_URL).toBe('redis://localhost:6379')
    expect(calls).toEqual(['run', 'ping abc123', 'ping abc123', 'ping abc123'])
    await stop!()
    expect(calls.at(-1)).toBe('stop abc123')
  })

  it('does not set REDIS_URL before the container answers PONG', async () => {
    const { docker } = fakeDocker([new Error('not ready')])
    const env: Record<string, string | undefined> = { CI: 'true' }
    await expect(startRealRedis({ env, docker, ...clock() })).rejects.toThrow()
    expect(env.REDIS_URL).toBeUndefined()
  })

  it('in CI fails the run, and removes the container, when redis never answers within the bound', async () => {
    const { docker, calls } = fakeDocker([new Error('not ready')])
    const c = clock()
    const env: Record<string, string | undefined> = { CI: 'true' }
    await expect(startRealRedis({ env, docker, ...c })).rejects.toThrow(/did not answer PONG within 30000 ms: not ready/)
    expect(c.now()).toBeLessThanOrEqual(READY_TIMEOUT_MS)
    expect(calls.at(-1)).toBe('stop abc123')
  })

  it('in CI fails the run when docker run fails', async () => {
    const { docker, calls } = fakeDocker(['PONG'], new Error('docker: command not found'))
    const env: Record<string, string | undefined> = { CI: 'true' }
    await expect(startRealRedis({ env, docker, ...clock() })).rejects.toThrow(/starting redis:7 failed.*docker: command not found/)
    expect(calls).toEqual(['run'])
    expect(env.REDIS_URL).toBeUndefined()
  })

  it('in CI fails the run when docker run prints no container id', async () => {
    const { docker } = fakeDocker(['PONG'], '\n')
    await expect(startRealRedis({ env: { CI: 'true' }, docker, ...clock() })).rejects.toThrow(/no container id/)
  })
})
