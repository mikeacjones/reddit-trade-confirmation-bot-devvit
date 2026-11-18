# Testing

`npm test` runs everything with vitest; `npm run typecheck` type-checks `src/` and `tests/`.

There are two kinds of tests:

- **Unit tests** in `tests/*.test.ts` call one module with a hand-made context. They predate the
  harness and stay as they are.
- **Scenario tests** in `tests/scenarios/` run the app registered in `src/main.ts` the way Devvit
  does: they fire a trigger, run a scheduler job, press a menu item or submit a form, and then
  check state in Redis and on Reddit. They use the shared harness in `tests/harness/` and no
  per-test hand mocks. New scenario tests should be written this way.

## Outcome of the `@devvit/test` spike

`@devvit/test` 0.15.4 (a devDependency pinned to the same version as `@devvit/public-api`) **can**
drive this Blocks app end to end for everything except the Reddit API. The one thing it cannot do
is act as the Reddit API for this app, so that side is a small in-repo fake. A real Redis is needed only
for the race scenarios.

Why it works: `@devvit/test/server/vitest` exports `createDevvitTest`, which installs the Devvit
global (`globalThis.devvit`) per test and wires mock plugins for Redis, settings, scheduler, media,
HTTP and so on. The `@devvit/public-api` clients (`redis`, `settings`, `scheduler`, built by
`makeAPIClients()`) resolve their plugins from that global, so they run against the mocks
unchanged. Importing `src/main.ts` registers every trigger, job, menu item and form on the `Devvit`
class, and the harness reads that registry and calls the handlers the same way the runtime does
(see `tests/harness/app.ts`). `@devvit/test` itself has no helper for Blocks apps (it targets
`@devvit/web` servers), so the registry lookup and the context construction are the harness's job.
The registry getters (`Devvit.triggerOnEventHandlers`, `scheduledJobHandlers`, `menuItems`,
`formDefinitions`) and `UIClient.__effects` are internal to `@devvit/public-api`, so the harness
casts to reach them; a Devvit upgrade can break `tests/harness/app.ts` and nothing else.

### What goes through what

| Surface in `src/main.ts` | Goes through | Notes |
| --- | --- | --- |
| Triggers: `CommentSubmit`, `ModAction`, `PostSubmit`, `AppInstall`, `AppUpgrade` | Real handlers from the `Devvit` registry, via `app.fireTrigger` | Same fan-out and error propagation as the runtime's combined handler. |
| Scheduler jobs: `monthly-post`, `rescan-monthly-post` | Real handlers, via `app.runJob` | `@devvit/test`'s `SchedulerMock` only records `runJob` requests; it never fires them. `AppInstall` scheduling is asserted on `mocks.scheduler.getScheduledActions()`, and a job's body is run by calling `app.runJob`. |
| Menu items | Real `onPress` handlers, via `app.pressMenuItem` | Returns the toasts and forms the press produced. |
| Forms: `adjustTradeCountForm` | Real form definition and `onSubmit`, via `app.submitForm` | The form shown by a menu item is read from the real `UIClient` effects, then submitted with chosen values. Field validation done by the Devvit client (`required`, etc.) is not run. |
| Redis | `@devvit/test` (`RedisMock`, on ioredis-mock), through the real public-api client | See the gaps below. |
| Settings | `@devvit/test` (`SettingsMock`) | Defaults come from `Devvit.addSettings`; override per test with `mocks.settings.put(name, value)`. |
| Reddit API (`ctx.reddit`) | **Fallback:** `FakeReddit` in `tests/harness/redditFake.ts` | See below. |
| Discord webhook (`fetch`) | `vi.stubGlobal('fetch', …)` in the test | No real Discord calls are made. |

### Reddit API: the fallback

The Reddit plugin mock in `@devvit/test` implements users, subreddit-about and posts only.
Comments, flair, moderators, modmail and listings throw "not mocked", and it has no way to
submit or read comments, which the confirmation flow needs. So `ctx.reddit` is `FakeReddit`, one
stateful fake shared by all scenarios. It holds users, posts, comments, flair templates, user flair,
moderators and modmail, implements exactly the `ctx.reddit` calls `src/` makes, and exposes
`failNext(method, error)` to inject API failures. Seed it with `addUser`, `addModerator`,
`addFlairTemplate`, `addPost`, `addComment`; inspect it with `repliesTo`, `commentsBy`, `flairOf`,
`modmail`, `calls`. `seedSwapsWorld` in `tests/harness/scenario.ts` sets up the usual subreddit.
When `src/` starts using another `ctx.reddit` method, add it to the fake (calling it before then
fails loudly with "is not a function").

The fake is hand-written, so it can drift from the real API. It is only as faithful as the
behaviour the app depends on (shape of the objects, 404 for unknown ids, replies lists).

### Redis: what `@devvit/test` does not do

Plain keys, `nx`, expiration, `watch`/`multi`/`exec` writes and `expireTime` work and are what
scenario tests use. Two gaps, pinned by `tests/harness/redisFidelity.test.ts`:

- `EXEC` never aborts when a watched key was changed by another writer. Real Redis discards the
  transaction. Scenarios cannot exercise the lost-race path in `commitConfirmation`.
- A `SET … NX` that fails inside `EXEC` yields `''` where real Devvit Redis yields `null`;
  `commitConfirmation` treats only `null`/`false` as a lost claim.

Scenarios that depend on either need a real Redis, which the race scenarios get through the adapter
described next.

### Race scenarios and the real-Redis adapter

`tests/harness/redisAdapter.ts` backs the same `ctx.redis` with a real Redis when `REDIS_URL` is set.
`instrumentRedis(mocks)` patches the plugin that the `@devvit/public-api` Redis client already talks to
(the one `createDevvitTest` installed), so the real client code runs unchanged:

- Plain commands go to the real server. Keys keep the mock's per-test random prefix and `scenarioTest`
  clears only that prefix after each test, so parallel test files can share one server.
- `watch`/`multi`/`exec` are real: every transaction gets its own connection (WATCH is per connection),
  an `exec` whose watched key changed is discarded and answers `[]`, and a failed `SET … NX` inside an
  `exec` answers `null`. Only `set`, `get` and `del` can be queued in a transaction, which is all `src/`
  uses. `unwatch()` ends the transaction.
- With `REDIS_URL` unset, nothing changes: the RedisMock stays the backend, and scenarios that need the
  real one are skipped (the skipped block's name says "needs a real Redis: set REDIS_URL").

Interleavings are controlled by hooks, never by timers. `redis.pause(redisCall('Exec'))` holds the first
matching Redis call (method plus optional first key: `Watch`, `Get`, `Set`, `Exec`, …) until
`pause.resume()`; `redis.before(match, run, { once })` runs code, such as a competing write, right before
a matching call. The pattern is: start flow A without awaiting it, `await pause.reached`, run flow B to
completion, `resume()`, await A. `tests/scenarios/confirmationRaces.test.ts` uses it to probe
`commitConfirmation`; `tests/harness/redisAdapter.test.ts` tests the adapter itself.

Run them locally with a throwaway Redis:

```sh
docker run --rm -d --name swapbot-redis -p 6379:6379 redis:7
REDIS_URL=redis://localhost:6379 npm test
docker stop swapbot-redis
```

(`redis-server` from a package manager works the same: point `REDIS_URL` at it.) In CI, the `devvit-test`
job needs a Redis service container and the variable:

```yaml
    services:
      redis:
        image: redis:7
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping" --health-interval 5s --health-timeout 3s --health-retries 10
    env:
      REDIS_URL: redis://localhost:6379
```

Probes that found a bug are kept as `it.fails`/`test.fails` repros with a `// BUG: …, severity …`
comment, so the suite stays green and flips red when the bug is fixed.

## Writing a scenario

```ts
import { newApp, scenarioTest as test, seedSwapsWorld } from '../harness/scenario.js'

test('a valid confirmation updates both traders', async ({ mocks }) => {
  const app = newApp(mocks)
  const { monthlyPostId } = seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', monthlyPostId)
  app.reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'Sold a kit to u/bob' })
  app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: monthlyPostId, authorName: 'bob', body: 'confirmed' })

  await app.fireTrigger('CommentSubmit', { comment: { /* … */ }, author: { name: 'bob' }, subreddit: { name: 'swaps' } })

  expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
  expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 1')
})
```

Use `scenarioTest` (not plain `it`): it creates the per-test Devvit global and clears Redis after
each test. Examples: `tests/scenarios/commentSubmit.test.ts` (the confirmation flow) and
`tests/scenarios/surfaces.test.ts` (install, jobs, menu items, forms, `PostSubmit`).

## Limits

- The Devvit runtime is not run: no real RPC, permissions (`forUserType: 'moderator'`), scopes or
  rate limits. Handlers are called directly.
- `app.runJob` and `app.fireTrigger` do not apply the scheduler's timing or the platform's
  at-least-once delivery; deliver an event twice yourself to test idempotency.
- Playtests against a live subreddit remain manual.
