/**
 * Vitest globalSetup: gives CI a real Redis for the race scenarios without a workflow `services:`
 * block (pipelines may not edit .github/**).
 *
 * The real-Redis adapter (tests/harness/redisAdapter.ts) and the race scenarios skip themselves
 * unless `REDIS_URL` is set, and they read it at import time. A globalSetup runs once in the main
 * vitest process before any test worker is started, and workers inherit the main process's
 * environment, so setting `process.env.REDIS_URL` here is seen by the adapter in every worker.
 *
 * Decision logic, in `startRealRedis`:
 * - `REDIS_URL` already set: do nothing (the caller brought a Redis).
 * - `CI` not set: do nothing (local runs use the RedisMock unless the developer sets `REDIS_URL`).
 * - Otherwise start `redis:7` in Docker on port 6379, wait a bounded time for `redis-cli ping` to
 *   answer `PONG`, and set `REDIS_URL`. If Redis cannot be started or does not answer in time, the
 *   container is removed and the function throws, so the CI run fails instead of silently skipping.
 *
 * The docker calls and the clock are injected so tests/harness/ciWorkflow.test.ts can test the
 * decision logic without Docker.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const REDIS_IMAGE = 'redis:7'
export const REDIS_PORT = 6379
export const REDIS_URL_FOR_CI = `redis://localhost:${REDIS_PORT}`
/** How long to wait for the container to answer PING, and how often to ask. */
export const READY_TIMEOUT_MS = 30_000
export const READY_POLL_MS = 500

export interface Docker {
  /** Starts a detached, auto-removed redis container publishing the port; resolves to its id. */
  runRedis(): Promise<string>
  /** Runs `redis-cli ping` in the container; resolves to its output, rejects if the command fails. */
  ping(containerId: string): Promise<string>
  /** Stops (and so, with `--rm`, removes) the container. */
  stop(containerId: string): Promise<void>
}

export interface SetupDeps {
  env: Record<string, string | undefined>
  docker: Docker
  sleep(ms: number): Promise<void>
  now(): number
  timeoutMs?: number
  pollMs?: number
}

/** Whether the process is running under CI; `CI=false`/`0`/empty do not count. */
export function isCi(env: Record<string, string | undefined>): boolean {
  const value = env.CI?.trim().toLowerCase()
  return !!value && value !== 'false' && value !== '0'
}

/**
 * Starts Redis when CI is set and REDIS_URL is not, and sets `env.REDIS_URL`. Resolves to a stop
 * function, or `undefined` when it did nothing. Throws when Redis cannot be started in CI.
 */
export async function startRealRedis(deps: SetupDeps): Promise<(() => Promise<void>) | undefined> {
  const { env, docker, sleep, now } = deps
  if (env.REDIS_URL || !isCi(env)) return undefined

  const timeoutMs = deps.timeoutMs ?? READY_TIMEOUT_MS
  const pollMs = deps.pollMs ?? READY_POLL_MS

  let id: string
  try {
    id = (await docker.runRedis()).trim()
  } catch (error) {
    throw new Error(`CI is set but starting ${REDIS_IMAGE} failed, so the real-Redis tests cannot run: ${describe(error)}`)
  }
  if (!id) throw new Error(`CI is set but \`docker run\` for ${REDIS_IMAGE} printed no container id`)

  const stop = () => docker.stop(id)
  const deadline = now() + timeoutMs
  let last = 'no answer yet'
  for (;;) {
    try {
      const answer = (await docker.ping(id)).trim()
      if (answer === 'PONG') break
      last = `answered ${JSON.stringify(answer)}`
    } catch (error) {
      last = describe(error)
    }
    if (now() >= deadline) {
      await stop().catch(() => undefined)
      throw new Error(`${REDIS_IMAGE} (container ${id}) did not answer PONG within ${timeoutMs} ms: ${last}`)
    }
    await sleep(pollMs)
  }

  env.REDIS_URL = REDIS_URL_FOR_CI
  return stop
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const realDocker: Docker = {
  async runRedis() {
    const { stdout } = await execFileAsync('docker', ['run', '-d', '--rm', '-p', `${REDIS_PORT}:6379`, REDIS_IMAGE])
    return stdout
  },
  async ping(containerId) {
    const { stdout } = await execFileAsync('docker', ['exec', containerId, 'redis-cli', 'ping'])
    return stdout
  },
  async stop(containerId) {
    await execFileAsync('docker', ['stop', containerId])
  },
}

/** vitest calls the default export once before the workers start; the function it returns is the teardown. */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  return startRealRedis({
    env: process.env,
    docker: realDocker,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  })
}
