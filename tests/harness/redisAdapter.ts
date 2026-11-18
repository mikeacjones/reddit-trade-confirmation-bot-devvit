/**
 * Redis for race scenarios: the default `@devvit/test` RedisMock, optionally backed by a real Redis,
 * plus deterministic interleaving hooks.
 *
 * Why: the RedisMock (ioredis-mock) never aborts EXEC when a watched key changed and reports a
 * failed `SET … NX` inside EXEC as `''` (see tests/harness/redisFidelity.test.ts), so it cannot show
 * the lost-race path of `commitConfirmation`. When `REDIS_URL` is set, `instrumentRedis` re-points
 * the mock's plugin at a real Redis and gives WATCH/MULTI/EXEC real semantics (one connection per
 * transaction, as WATCH is per connection). When it is unset, nothing changes: the RedisMock stays
 * the backend and race scenarios that need a real Redis skip themselves.
 *
 * The adapter patches the plugin that `ctx.redis` already talks to (the one `createDevvitTest` put in
 * the Devvit config), so the real `@devvit/public-api` RedisClient/TxClient code runs unchanged on
 * top of it. Per-test isolation is the mock's: every key carries the test's random prefix and
 * `mocks.redis.clear()` (run by `scenarioTest` after each test) deletes only that prefix, so a shared
 * Redis server can serve parallel test files.
 *
 * Interleaving is controlled with hooks, never timers: `pause(match)` holds the first matching Redis
 * call until `resume()`, and `before(match, run)` runs code (for example a competing write) right
 * before a matching call. A call is identified by the plugin method (`Watch`, `Get`, `Set`, `Exec`,
 * …) and its keys.
 *
 * Differences from real Devvit Redis worth knowing:
 * - EXEC of an aborted transaction answers with no results (`[]`); the real server's exact answer is
 *   not documented, `commitConfirmation` accepts anything shorter than the queued commands.
 * - Only `set`, `get` and `del` can be queued inside a transaction here; that is all `src/` uses.
 * - `unwatch()` ends the transaction (the connection is closed).
 */
import { randomUUID } from 'node:crypto'
import type { DevvitFixtures } from '@devvit/test/server/vitest'
import Redis from 'ioredis'
import { afterAll, afterEach } from 'vitest'

/** The connection string race scenarios use; unset means "use the RedisMock and skip real-Redis scenarios". */
export const REDIS_URL = process.env.REDIS_URL || undefined

/** Name for `describe.skipIf(!REDIS_URL)` blocks, so the skip explains itself in the test report. */
export function needsRealRedis(title: string): string {
  return `${title} (needs a real Redis: set REDIS_URL, e.g. REDIS_URL=redis://localhost:6379; see docs/testing.md)`
}

export interface RedisCall {
  /** Plugin method: 'Get', 'Set', 'Del', 'Watch', 'Multi', 'Exec', 'Unwatch', 'Discard', … */
  method: string
  /** Keys as the app wrote them (without the per-test prefix). Empty for Multi/Exec/Unwatch/Discard. */
  keys: string[]
  /** The transaction the call belongs to, if any. */
  transaction?: string
}

export type CallMatcher = (call: RedisCall) => boolean

/** Match a plugin call by method and, optionally, its first key. */
export function redisCall(method: string, key?: string): CallMatcher {
  return call => call.method === method && (key === undefined || call.keys[0] === key)
}

export interface Pause {
  /** Resolves with the call that is now held. */
  reached: Promise<RedisCall>
  /** Lets the held call (and the code awaiting it) continue. */
  resume: () => void
}

export interface RedisHarness {
  backend: 'mock' | 'real'
  /** Every plugin call so far, in order. */
  calls: RedisCall[]
  /**
   * Run `run` right before each call matching `match` (every call, or only the first with `once`).
   * Calls `run` makes through `ctx.redis` are themselves visible to hooks. Returns an uninstaller.
   */
  before: (match: CallMatcher, run: (call: RedisCall) => unknown, options?: { once?: boolean }) => () => void
  /** Hold the first call matching `match` until `resume()`. */
  pause: (match: CallMatcher) => Pause
}

export interface InstrumentOptions {
  /** Default: real when REDIS_URL is set, otherwise the RedisMock. */
  backend?: 'mock' | 'real'
}

interface RealTransaction {
  conn: Redis
  multi: boolean
  commands: Array<{ args: Array<string | number>; toResponse: (value: unknown) => Record<string, unknown> }>
}

// One shared connection for plain commands and as the template for per-transaction connections.
let shared: Redis | undefined
const transactionConns = new Set<Redis>()

if (REDIS_URL) {
  afterEach(() => {
    for (const conn of transactionConns) conn.disconnect()
    transactionConns.clear()
  })
  afterAll(async () => {
    if (shared) await shared.quit().catch(() => undefined)
    shared = undefined
  })
}

function sharedConnection(): Redis {
  if (!REDIS_URL) throw new Error('REDIS_URL is not set: a real Redis backend is not available')
  shared ??= new Redis(REDIS_URL, { maxRetriesPerRequest: 1 })
  return shared
}

// The RedisPluginMock is not exported by @devvit/test, so the parts the adapter touches are typed here.
interface PluginInternals {
  _makeKey: (key: string, scope?: unknown) => string
  _store: { conn: unknown; keyPrefix: string }
  [method: string]: any
}

export function instrumentRedis(mocks: DevvitFixtures['mocks'], options: InstrumentOptions = {}): RedisHarness {
  const backend = options.backend ?? (REDIS_URL ? 'real' : 'mock')
  const plugin = mocks.redis.plugin as unknown as PluginInternals
  if ((plugin as { __instrumented?: boolean }).__instrumented) throw new Error('Redis is already instrumented for this test')
  ;(plugin as { __instrumented?: boolean }).__instrumented = true

  if (backend === 'real') useRealRedis(plugin)

  const calls: RedisCall[] = []
  const hooks: Array<{ match: CallMatcher; run: (call: RedisCall) => unknown; once: boolean }> = []
  const prefix = plugin._store.keyPrefix ? `${plugin._store.keyPrefix.replace(/:$/, '')}:` : ''
  const unprefixed = (key: string) => (prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key)

  for (const name of methodNames(plugin)) {
    const original = plugin[name].bind(plugin) as (request: any, ...rest: unknown[]) => Promise<unknown>
    plugin[name] = async (request: any, ...rest: unknown[]) => {
      const call = describeCall(name, request, unprefixed)
      calls.push(call)
      for (const hook of [...hooks]) {
        if (!hook.match(call)) continue
        if (hook.once) hooks.splice(hooks.indexOf(hook), 1)
        await hook.run(call)
      }
      return original(request, ...rest)
    }
  }

  const before: RedisHarness['before'] = (match, run, opts = {}) => {
    const hook = { match, run, once: opts.once ?? false }
    hooks.push(hook)
    return () => {
      const at = hooks.indexOf(hook)
      if (at >= 0) hooks.splice(at, 1)
    }
  }

  return {
    backend,
    calls,
    before,
    pause(match) {
      let resume!: () => void
      let reached!: (call: RedisCall) => void
      const gate = new Promise<void>(resolve => { resume = resolve })
      const reachedPromise = new Promise<RedisCall>(resolve => { reached = resolve })
      before(match, async call => {
        reached(call)
        await gate
      }, { once: true })
      return { reached: reachedPromise, resume }
    },
  }
}

function methodNames(plugin: object): string[] {
  const names = new Set<string>()
  for (let proto = Object.getPrototypeOf(plugin); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (/^[A-Z]/.test(name) && typeof plugin[name as keyof typeof plugin] === 'function') names.add(name)
    }
  }
  for (const name of Object.keys(plugin)) {
    if (/^[A-Z]/.test(name) && typeof plugin[name as keyof typeof plugin] === 'function') names.add(name)
  }
  return [...names]
}

function describeCall(method: string, request: any, unprefixed: (key: string) => string): RedisCall {
  if (method === 'Multi' || method === 'Exec' || method === 'Unwatch' || method === 'Discard') {
    return { method, keys: [], transaction: request?.id }
  }
  const keys: string[] = request?.keys ?? (request?.key !== undefined ? [request.key] : [])
  return { method, keys: keys.map(unprefixed), transaction: request?.transactionId?.id }
}

/** Point the mock plugin at the real Redis and give transactions real WATCH/MULTI/EXEC semantics. */
function useRealRedis(plugin: PluginInternals): void {
  plugin._store.conn = sharedConnection()
  const transactions = new Map<string, RealTransaction>()
  const original = {
    Set: plugin.Set.bind(plugin),
    Get: plugin.Get.bind(plugin),
    Del: plugin.Del.bind(plugin),
  }

  const open = (id: string): RealTransaction => {
    const tx = transactions.get(id)
    if (!tx) throw new Error(`Unknown or closed transaction ${id}`)
    return tx
  }
  const close = (id: string) => {
    const tx = transactions.get(id)
    if (!tx) return
    transactions.delete(id)
    transactionConns.delete(tx.conn)
    tx.conn.disconnect()
  }
  const queue = (id: string, args: Array<string | number>, toResponse: RealTransaction['commands'][number]['toResponse']) => {
    const tx = open(id)
    if (!tx.multi) throw new Error(`Transaction ${id} must call multi() before executing commands`)
    tx.commands.push({ args, toResponse })
    return {}
  }
  const nilOr = (value: unknown) => (value === null ? { nil: {} } : { str: String(value) })

  plugin.Watch = async (request: { keys: string[]; transactionId?: { id: string } }) => {
    const keys = request.keys.map(key => plugin._makeKey(key))
    if (request.transactionId) {
      await open(request.transactionId.id).conn.watch(...keys)
      return request.transactionId
    }
    const id = randomUUID()
    const conn = sharedConnection().duplicate()
    transactionConns.add(conn)
    transactions.set(id, { conn, multi: false, commands: [] })
    await conn.watch(...keys)
    return { id }
  }

  plugin.Multi = async (request: { id: string }) => {
    const tx = open(request.id)
    if (tx.multi) throw new Error(`Transaction ${request.id} already started`)
    tx.multi = true
    return {}
  }

  plugin.Set = async (request: any, ...rest: unknown[]) => {
    if (!request.transactionId) return original.Set(request, ...rest)
    if (request.nx && request.xx) throw new Error('invalid Set: nx and xx cannot both be true')
    const args: Array<string | number> = ['set', plugin._makeKey(request.key, request.scope), request.value]
    if (request.expiration && request.expiration > 0) args.push('EX', request.expiration)
    if (request.nx) args.push('NX')
    else if (request.xx) args.push('XX')
    return queue(request.transactionId.id, args, nilOr)
  }

  plugin.Get = async (request: any, ...rest: unknown[]) => {
    if (!request.transactionId) return original.Get(request, ...rest)
    return queue(request.transactionId.id, ['get', plugin._makeKey(request.key, request.scope)], nilOr)
  }

  plugin.Del = async (request: any, ...rest: unknown[]) => {
    if (!request.transactionId) return original.Del(request, ...rest)
    const keys = request.keys.map((key: string) => plugin._makeKey(key, request.scope))
    return queue(request.transactionId.id, ['del', ...keys], value => ({ num: Number(value) }))
  }

  plugin.Exec = async (request: { id: string }) => {
    const tx = open(request.id)
    if (!tx.multi) throw new Error(`Transaction ${request.id} must call multi() before exec()`)
    try {
      const results = await tx.conn.multi(tx.commands.map(command => command.args)).exec()
      // ioredis answers null when a watched key changed: the transaction was discarded.
      if (results === null) return { response: [] }
      return {
        response: results.map(([error, value], index) => {
          if (error) throw error
          return tx.commands[index].toResponse(value)
        }),
      }
    } finally {
      close(request.id)
    }
  }

  plugin.Discard = async (request: { id: string }) => {
    close(request.id)
    return {}
  }

  plugin.Unwatch = async (request: { id: string }) => {
    open(request.id)
    close(request.id)
    return {}
  }
}
