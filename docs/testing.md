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
is act as the Reddit API for this app, so that side is a small in-repo fake. A real Redis is not
needed for the current scenarios.

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

Scenarios that depend on either need a real Redis behind a thin adapter that implements the same
`ctx.redis` surface (Docker service container in CI, a local `redis-server` on a dev machine). That
adapter is **not built yet**: no scenario needs it, and the two characterisation tests will fail
when `@devvit/test` closes the gaps, which is the signal to revisit this section. The first bead
that needs concurrent-commit semantics should build it under `tests/harness/`.

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
