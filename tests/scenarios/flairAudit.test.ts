/**
 * Adversarial scenario probes for the flair pipeline (src/flairAssignment.ts, src/flairCache.ts,
 * src/userFlairState.ts, src/adjustments.ts, and the flair half of src/confirmations.ts): range
 * boundaries, gaps, overlaps and unordered ranges, mod-only templates, custom flair text, a stale
 * template cache, odd "Set user trade count" values, username case, and `setUserFlair` failing.
 * Pure-function probes of the same modules are in tests/flairAudit.test.ts.
 *
 * A probe that shows the code is correct is a normal test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG: <description>, severity <level>` comment: it keeps CI green and
 * turns red once the bug is fixed (then drop the `.fails`).
 *
 * Races are provoked without timers: a probe wraps one `ctx.redis` or `ctx.reddit` call and runs the
 * competing flow right before or inside it. `sleep` is stubbed out so the flair lock's polling is instant.
 */
import { describe, expect, vi } from 'vitest'
import { adjustUserTradeCount } from '../../src/adjustments.js'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

// The flair lock polls with real sleeps (12 attempts, about 7 seconds); the lock-timeout probes skip them.
vi.mock('../../src/utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils.js')>(),
  sleep: vi.fn(async () => {}),
}))

const MONTHLY = 't3_monthly'
type Mocks = Parameters<typeof newApp>[0]

async function setup(mocks: Mocks): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return app
}

/** A world with only the given user templates (no moderators, no default templates). */
async function setupWith(mocks: Mocks, templates: Array<[text: string, id: string, modOnly?: boolean]>): Promise<AppHarness> {
  const app = newApp(mocks)
  app.reddit.addPost({ id: MONTHLY, title: 'Confirmed Trade Thread', stickied: true })
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  for (const [text, id, modOnly] of templates) app.reddit.addFlairTemplate(text, { id, modOnly })
  return app
}

async function count(app: AppHarness, user: string): Promise<string | undefined> {
  return app.ctx.redis.get(`confirmations:${user}`)
}

function flairWrites(app: AppHarness) {
  return app.reddit.calls.filter(c => c.method === 'setUserFlair' || c.method === 'setUserFlairBatch')
}

async function setCount(app: AppHarness, username: string, value: unknown): Promise<string[]> {
  const { forms } = await app.pressMenuItem('Set user trade count')
  return (await app.submitForm(forms[0].id, { username, count: value })).toasts
}

/** alice's top-level trade comment t1_<n> and bob's direct reply; returns the reply id. */
function addTrade(app: AppHarness, n = 1, owner = 'alice', confirmer = 'bob'): string {
  app.reddit.addComment({ id: `t1_offer${n}`, parentId: MONTHLY, postId: MONTHLY, authorName: owner, body: `Sold a kit to u/${confirmer}` })
  app.reddit.addComment({ id: `t1_reply${n}`, parentId: `t1_offer${n}`, postId: MONTHLY, authorName: confirmer, body: 'confirmed' })
  return `t1_reply${n}`
}

async function deliver(app: AppHarness, replyId: string): Promise<void> {
  const c = app.reddit.comments.get(replyId)!
  await app.fireTrigger('CommentSubmit', {
    comment: { id: c.id, body: c.body, parentId: c.parentId, postId: c.postId, permalink: `/r/swaps/comments/monthly/_/${c.id}/` },
    author: { name: c.authorName },
    subreddit: { name: 'swaps' },
  })
}

async function freeCommentSlot(app: AppHarness): Promise<void> {
  await app.ctx.redis.del('reddit:comment-submit-slot')
}

const NO_TEMPLATE = (n: number | string) => [`No user flair template found for trade count ${n}`]

describe('ranges that are not the neat default set', () => {
  test('templates listed out of order still map each count to its own range, at every boundary', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Trades: 200-99999', 'top'], ['Trades: 0-99', 'low'], ['Trades: 100-199', 'mid']])

    for (const [value, id] of [[0, 'low'], [99, 'low'], [100, 'mid'], [199, 'mid'], [200, 'top'], [99999, 'top']] as const) {
      expect(await setCount(app, 'alice', value)).toEqual([`Set u/alice to ${value} trades`])
      expect(app.reddit.flairOf('alice')).toEqual({ text: `Trades: ${value}`, flairTemplateId: id })
    }
  })

  test('a count in a gap between ranges is refused and leaves count and flair alone', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Trades: 0-49', 'a'], ['Trades: 100-199', 'b']])
    await app.ctx.redis.set('confirmations:alice', '3')
    app.reddit.setFlair('alice', 'Trades: 3')

    expect(await setCount(app, 'alice', 50)).toEqual(NO_TEMPLATE(50))
    expect(await setCount(app, 'alice', 99)).toEqual(NO_TEMPLATE(99))
    expect(await setCount(app, 'alice', 49)).toEqual(['Set u/alice to 49 trades'])
    expect(await setCount(app, 'alice', 100)).toEqual(['Set u/alice to 100 trades'])
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 100', flairTemplateId: 'b' })
  })

  test('overlapping ranges: the template Reddit lists first wins on the shared counts', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Trades: 0-100', 'first'], ['Trades: 100-199', 'second']])

    await setCount(app, 'alice', 100)
    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('first')
    await setCount(app, 'alice', 101)
    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('second')
  })

  test('a template with no upper bound ("Trades: 100+") is not a range, so counts above the bounded ones are refused', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Trades: 0-99', 'low'], ['Trades: 100+', 'open']])

    expect(await setCount(app, 'alice', 99)).toEqual(['Set u/alice to 99 trades'])
    expect(await setCount(app, 'alice', 100)).toEqual(NO_TEMPLATE(100))
    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('low')
  })

  test('a confirmation that crosses the top of the last range commits the count and leaves the flair as it was', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '99999')
    await app.ctx.redis.set('confirmations:bob', '5')
    app.reddit.setFlair('alice', 'Trades: 99999')
    const reply = addTrade(app)

    await deliver(app, reply)

    expect(await count(app, 'alice')).toBe('100000')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 99999' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 6', flairTemplateId: 'tpl-0' })
    const body = app.reddit.repliesTo(reply)[0].body
    expect(body).toContain('`Trades: 99999` to `unknown`')
    expect(body).toContain('`Trades: 5` to `Trades: 6`')
  })

  test('a confirmation that lands in a gap commits the count and leaves the flair as it was', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Trades: 0-49', 'a'], ['Trades: 100-199', 'b']])
    await app.ctx.redis.set('confirmations:alice', '49')
    await app.ctx.redis.set('confirmations:bob', '1')
    app.reddit.setFlair('alice', 'Trades: 49')

    await deliver(app, addTrade(app))

    expect(await count(app, 'alice')).toBe('50')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 49' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 2', flairTemplateId: 'a' })
  })

  test('a confirmation crossing a boundary moves the user to the next template, both ways round', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '899')
    await app.ctx.redis.set('confirmations:bob', '99')

    await deliver(app, addTrade(app))

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 900', flairTemplateId: 'tpl-900' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 100', flairTemplateId: 'tpl-100' })
  })

  test('a template created after the cache was filled is found by the confirmation (cache miss refreshes)', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Trades: 0-99', 'low']])
    await app.ctx.redis.set('confirmations:alice', '99')
    await app.ctx.redis.set('confirmations:bob', '1')
    await app.pressMenuItem('Refresh flair template cache')
    app.reddit.addFlairTemplate('Trades: 100-199', { id: 'late' })

    await deliver(app, addTrade(app))

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 100', flairTemplateId: 'late' })
  })
})

describe('mod-only templates', () => {
  test('a moderator gets the mod-only template and a regular user the plain one, at the same count', async ({ mocks }) => {
    const app = await setup(mocks)

    await setCount(app, 'mod1', 42)
    await setCount(app, 'alice', 42)

    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 42', flairTemplateId: 'tpl-mod' })
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 42', flairTemplateId: 'tpl-0' })
  })

  test('a moderator keeps the mod-only flair through confirmations as a parent and as a confirmer, in any case', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('mod1', 'Moderator | Trades: 4')
    await app.ctx.redis.set('confirmations:mod1', '4')
    app.reddit.addComment({ id: 't1_o1', parentId: MONTHLY, postId: MONTHLY, authorName: 'Mod1', body: 'Sold to u/bob' })
    app.reddit.addComment({ id: 't1_r1', parentId: 't1_o1', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
    await deliver(app, 't1_r1')
    await freeCommentSlot(app)
    app.reddit.addComment({ id: 't1_o2', parentId: MONTHLY, postId: MONTHLY, authorName: 'carol', body: 'Sold to u/MOD1' })
    app.reddit.addComment({ id: 't1_r2', parentId: 't1_o2', postId: MONTHLY, authorName: 'MOD1', body: 'confirmed' })
    await deliver(app, 't1_r2')

    expect(await count(app, 'mod1')).toBe('6')
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 6', flairTemplateId: 'tpl-mod' })
    expect(app.reddit.flairOf('bob')?.flairTemplateId).toBe('tpl-0')
    expect(app.reddit.flairOf('carol')?.flairTemplateId).toBe('tpl-0')
  })

  test('a user is never given a mod-only template, even when it is the only template covering the count', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Moderator | Trades: 0-99999', 'mod', true]])

    expect(await setCount(app, 'alice', 5)).toEqual(NO_TEMPLATE(5))
    await deliver(app, addTrade(app))

    expect(flairWrites(app)).toEqual([])
    expect(app.reddit.flairOf('alice')).toBeUndefined()
    expect(await count(app, 'alice')).toBe('1')
  })

  test('a moderator is refused when only plain templates exist, and a confirmation counts the trade but leaves the flair', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Trades: 0-99999', 'plain']])
    app.reddit.addModerator('mod1')
    app.reddit.setFlair('mod1', 'Moderator | Trades: 7')

    expect(await setCount(app, 'mod1', 5)).toEqual(['No moderator flair template found for trade count 5'])
    await app.ctx.redis.set('confirmations:mod1', '7')
    await deliver(app, addTrade(app, 1, 'mod1', 'bob'))

    expect(await count(app, 'mod1')).toBe('8')
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 7' })
    expect(app.reddit.flairOf('bob')?.flairTemplateId).toBe('plain')
  })

  test('a moderator past the mod-only range is refused instead of falling back to a plain template', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Moderator | Trades: 0-99', 'mod', true], ['Trades: 0-99999', 'plain']])
    app.reddit.addModerator('mod1')

    expect(await setCount(app, 'mod1', 99)).toEqual(['Set u/mod1 to 99 trades'])
    expect(await setCount(app, 'mod1', 100)).toEqual(['No moderator flair template found for trade count 100'])
    expect(app.reddit.flairOf('mod1')?.flairTemplateId).toBe('mod')
  })

  test('a removed moderator gets the plain template again once the moderator cache is refreshed by the ModAction', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'mod1', 3)
    expect(app.reddit.flairOf('mod1')?.flairTemplateId).toBe('tpl-mod')

    app.reddit.removeModerator('mod1')
    // Until the cache is refreshed, the 12 hour moderator cache still says moderator.
    await setCount(app, 'mod1', 4)
    expect(app.reddit.flairOf('mod1')?.flairTemplateId).toBe('tpl-mod')

    await app.fireTrigger('ModAction', { action: 'removemoderator', subreddit: { name: 'swaps' } })
    await setCount(app, 'mod1', 5)
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Trades: 5', flairTemplateId: 'tpl-0' })
  })

  test('a newly added moderator is treated as moderator only after the cache refresh', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'alice', 1)
    app.reddit.addModerator('alice')

    await setCount(app, 'alice', 2)
    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('tpl-0')

    await app.fireTrigger('ModAction', { action: 'addmoderator', subreddit: { name: 'swaps' } })
    await setCount(app, 'alice', 3)
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Moderator | Trades: 3', flairTemplateId: 'tpl-mod' })
  })

  test('the moderator flair prefix is part of the template text, so a template without the label is not cached', async ({ mocks }) => {
    const app = await setupWith(mocks, [['Moderator', 'bare-mod', true], ['Trades: 0-99', 'plain']])
    app.reddit.addModerator('mod1')

    expect(await setCount(app, 'mod1', 5)).toEqual(['No moderator flair template found for trade count 5'])
  })
})

describe('users with their own flair text', () => {
  test('custom flair without a count is replaced by the count flair and the count starts at 1', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Plane spotter ✈')

    await deliver(app, addTrade(app))

    expect(await count(app, 'alice')).toBe('1')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  })

  test('an existing "Trades: N" flair with trailing text seeds the count, and the trailing text is dropped', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 12 | Plane spotter')

    await deliver(app, addTrade(app))

    expect(await count(app, 'alice')).toBe('13')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 13', flairTemplateId: 'tpl-0' })
  })

  test('a flair that is a template range, not a count, is not seeded', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 100-199')

    await deliver(app, addTrade(app))

    expect(await count(app, 'alice')).toBe('1')
  })

  test('a flair written under an old label is not seeded after the label setting changes', async ({ mocks }) => {
    const app = await setup(mocks)
    mocks.settings.put('flair_count_label', 'Swaps:')
    for (let i = 0; i < 10; i++) app.reddit.addFlairTemplate(`Swaps: ${i * 100}-${i * 100 + 99}`, { id: `swaps-${i}` })
    app.reddit.setFlair('alice', 'Trades: 40')

    await deliver(app, addTrade(app))

    expect(await count(app, 'alice')).toBe('1')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Swaps: 1', flairTemplateId: 'swaps-0' })
  })

  test('a user with a stored count is not re-seeded from a different flair', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '3')
    app.reddit.setFlair('alice', 'Trades: 400')

    await deliver(app, addTrade(app))

    expect(await count(app, 'alice')).toBe('4')
    expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 4')
  })
})

describe('a stale flair template cache', () => {
  test('keeps handing out the cached template until the cache is refreshed from the menu', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'alice', 5)
    app.reddit.flairTemplates.splice(0, app.reddit.flairTemplates.length)
    app.reddit.addFlairTemplate('Trades: 0-9', { id: 'new-low' })
    app.reddit.addFlairTemplate('Trades: 10-99999', { id: 'new-high' })

    await setCount(app, 'alice', 50)
    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('tpl-0')

    expect((await app.pressMenuItem('Refresh flair template cache')).toasts).toEqual(['Flair template cache refreshed'])
    await setCount(app, 'alice', 50)
    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('new-high')
  })

  test('changing the label setting reads the templates again instead of using the old label\'s cache', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'alice', 5)
    app.reddit.addFlairTemplate('Swaps: 0-99', { id: 'swaps' })
    mocks.settings.put('flair_count_label', 'Swaps:')

    await setCount(app, 'alice', 6)

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Swaps: 6', flairTemplateId: 'swaps' })
  })

  test('a corrupt cache entry is replaced by a fresh read', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('flairTemplates:swaps:Trades%3A', '{"not":"a list"}')

    expect(await setCount(app, 'alice', 5)).toEqual(['Set u/alice to 5 trades'])
    expect(JSON.parse((await app.ctx.redis.get('flairTemplates:swaps:Trades%3A'))!)).toHaveLength(11)
  })

  // BUG: when a cached template id has been deleted on Reddit, the 404 only triggers the text-only flaircsv fallback and the cache is not refreshed, so every flair for up to 12 hours loses its template while the toast reports success, severity medium
  test.fails('recovers from a deleted cached template by refreshing the cache and using the new template', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.rejectUnknownTemplateIds = true
    await setCount(app, 'alice', 5)
    expect(app.reddit.flairOf('alice')?.flairTemplateId).toBe('tpl-0')
    // A moderator deletes and recreates the first template: new id, same text.
    app.reddit.flairTemplates.shift()
    app.reddit.addFlairTemplate('Trades: 0-99', { id: 'recreated' })

    expect(await setCount(app, 'bob', 7)).toEqual(['Set u/bob to 7 trades'])

    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 7', flairTemplateId: 'recreated' })
  })
})

describe('"Set user trade count" with awkward counts', () => {
  test('zero replaces a higher count, shows "Trades: 0", and the next trade counts from zero', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '50')
    app.reddit.setFlair('alice', 'Trades: 50')

    expect(await setCount(app, 'alice', 0)).toEqual(['Set u/alice to 0 trades'])
    expect(await count(app, 'alice')).toBe('0')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 0', flairTemplateId: 'tpl-0' })

    await deliver(app, addTrade(app))
    expect(await count(app, 'alice')).toBe('1')
  })

  test('zero for a moderator uses the mod-only template', async ({ mocks }) => {
    const app = await setup(mocks)

    await setCount(app, 'mod1', 0)

    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 0', flairTemplateId: 'tpl-mod' })
  })

  test('the same value again rewrites the same flair and keeps the count', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'alice', 120)
    const before = flairWrites(app).length

    expect(await setCount(app, 'alice', 120)).toEqual(['Set u/alice to 120 trades'])

    expect(await count(app, 'alice')).toBe('120')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 120', flairTemplateId: 'tpl-100' })
    expect(flairWrites(app).length).toBe(before + 1)
  })

  test('negative zero is stored as "0"', async ({ mocks }) => {
    const app = await setup(mocks)

    expect(await setCount(app, 'alice', -0)).toEqual(['Set u/alice to 0 trades'])
    expect(await count(app, 'alice')).toBe('0')
  })

  test('a numeric string from the form is accepted as that number', async ({ mocks }) => {
    const app = await setup(mocks)

    expect(await setCount(app, 'alice', '250')).toEqual(['Set u/alice to 250 trades'])
    expect(await count(app, 'alice')).toBe('250')
  })

  const refused: Array<[name: string, value: unknown, toast: string]> = [
    ['NaN', NaN, 'Trade count must be a non-negative whole number'],
    ['Infinity', Infinity, 'Trade count must be a non-negative whole number'],
    ['-Infinity', -Infinity, 'Trade count must be a non-negative whole number'],
    ['a missing value', undefined, 'Trade count must be a non-negative whole number'],
    ['a boolean-looking string', 'true', 'Trade count must be a non-negative whole number'],
    ['a negative number', -100, 'Trade count must be a non-negative whole number'],
    ['a negative string', '-1', 'Trade count must be a non-negative whole number'],
    ['a count just above the last range', 100000, 'No user flair template found for trade count 100000'],
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER, `No user flair template found for trade count ${Number.MAX_SAFE_INTEGER}`],
    ['a count beyond safe integers', 2 ** 60, `No user flair template found for trade count ${2 ** 60}`],
    ['1e21', 1e21, 'No user flair template found for trade count 1e+21'],
  ]

  test.for(refused)('%s is refused with no change to the count or the flair', async ([, value, toast], { mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '9')
    app.reddit.setFlair('alice', 'Trades: 9')

    expect(await setCount(app, 'alice', value)).toEqual([toast])

    expect(await count(app, 'alice')).toBe('9')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 9' })
    expect(flairWrites(app)).toEqual([])
  })

  // BUG: the form handler converts the count with Number(), so a blank count ('' or null) becomes 0 and silently resets the user's trades instead of being refused, severity low
  test.fails('a blank count (empty string or null) is refused rather than reset to 0', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '9')

    for (const blank of ['', null]) {
      expect(await setCount(app, 'alice', blank)).not.toEqual(['Set u/alice to 0 trades'])
      expect(await count(app, 'alice')).toBe('9')
    }
  })
})

describe('adjustments for a user with no prior record', () => {
  test('creates the count and the flair, and reports a zero starting flair', async ({ mocks }) => {
    const app = await setup(mocks)

    const result = await adjustUserTradeCount(app.ctx, 'alice', 5)

    expect(result).toEqual({ username: 'alice', count: 5, oldFlair: 'Trades: 0', newFlair: 'Trades: 5' })
    expect(await count(app, 'alice')).toBe('5')
  })

  test('a failure for a user with no record leaves no record behind', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('setUserFlair', 'boom')

    await expect(adjustUserTradeCount(app.ctx, 'alice', 5)).rejects.toThrow('boom')

    expect(await count(app, 'alice')).toBeUndefined()
  })

  // BUG: adjustUserTradeCount does not seed from the user's existing flair, so for a user with a legacy "Trades: 50" flair and no stored count it reports the old flair as "Trades: 0", severity low
  test.fails('reports the flair the user actually had as the old flair', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 50')

    const result = await adjustUserTradeCount(app.ctx, 'alice', 60)

    expect(result.oldFlair).toBe('Trades: 50')
  })
})

describe('username case in count keys and flair calls', () => {
  test('one count per user whatever the case of the name, in the form, in comments and in the flair write', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'ALICE', 10)

    await deliver(app, addTrade(app, 1, 'Alice', 'bob'))

    expect(await count(app, 'alice')).toBe('11')
    expect(await app.ctx.redis.get('confirmations:Alice')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmations:ALICE')).toBeUndefined()
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 11', flairTemplateId: 'tpl-0' })
    const writes = flairWrites(app).map(c => (c.args[0] as { username: string }).username)
    expect(writes).toEqual(['ALICE', 'Alice', 'bob'])
  })

  test('a moderator is recognised whatever the case of the name the moderator list or the form uses', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.moderators.clear()
    app.reddit.moderators.add('Mod1')

    await setCount(app, 'MOD1', 8)

    expect(app.reddit.flairOf('mod1')?.flairTemplateId).toBe('tpl-mod')
    expect(await count(app, 'mod1')).toBe('8')
  })

  test('the per-user flair lock is shared by every case of the name', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('userFlairLock:swaps:alice', 'someone-else', { expiration: new Date(Date.now() + 3600_000) })

    expect(await setCount(app, 'ALICE', 5)).toEqual(['Timed out waiting for flair lock for u/ALICE'])
    expect(flairWrites(app)).toEqual([])
  })
})

describe('setUserFlair failing', () => {
  test('a manual adjustment that cannot get the flair lock restores the previous count', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '9')
    await app.ctx.redis.set('userFlairLock:swaps:alice', 'someone-else', { expiration: new Date(Date.now() + 3600_000) })

    expect(await setCount(app, 'alice', 120)).toEqual(['Timed out waiting for flair lock for u/alice'])
    expect(await count(app, 'alice')).toBe('9')
  })

  test('a confirmation keeps both counts committed when the first flair write fails, and the hourly rescan finishes the job', async ({ mocks }) => {
    const app = await setup(mocks)
    const reply = addTrade(app)
    app.reddit.failNext('setUserFlair', 'Reddit exploded')

    await expect(deliver(app, reply)).rejects.toThrow('Reddit exploded')

    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.flairOf('alice')).toBeUndefined()
    expect(app.reddit.flairOf('bob')).toBeUndefined()
    expect(await app.ctx.redis.get(`processed:${reply}`)).toBeUndefined()
    expect(await app.ctx.redis.get(`processing:${reply}`)).toBeUndefined()
    expect(await app.ctx.redis.get('userFlairLock:swaps:alice')).toBeUndefined()
    expect(app.reddit.repliesTo(reply)).toEqual([])

    await app.runJob('rescan-monthly-post')

    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.repliesTo(reply)).toHaveLength(1)
    expect(await app.ctx.redis.get(`processed:${reply}`)).toBe('1')
  })

  test('when only the second flair write fails, the first flair stays and the rescan sets the second', async ({ mocks }) => {
    const app = await setup(mocks)
    const reply = addTrade(app)
    // The parent (alice) is written first; fail the confirmer's write.
    const original = app.reddit.client.setUserFlair
    app.reddit.client.setUserFlair = async options => {
      if (options.username === 'bob') {
        app.reddit.client.setUserFlair = original
        throw new Error('bob flair failed')
      }
      return original(options)
    }

    await expect(deliver(app, reply)).rejects.toThrow('bob flair failed')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.flairOf('bob')).toBeUndefined()

    await app.runJob('rescan-monthly-post')

    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.repliesTo(reply)).toHaveLength(1)
  })

  test('a mod approval whose flair write fails reports the error, and pressing it again finishes without recounting', async ({ mocks }) => {
    const app = await setup(mocks)
    const reply = addTrade(app)
    app.reddit.failNext('setUserFlair', 'Reddit exploded')
    const press = () => app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: reply })

    expect((await press()).toasts).toEqual(['Reddit exploded'])
    expect(await count(app, 'alice')).toBe('1')
    await freeCommentSlot(app)
    expect((await press()).toasts).toEqual(['Approved confirmation for u/alice and u/bob'])

    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.repliesTo(reply)).toHaveLength(1)
  })

  test('a 404 makes the app set the text through flaircsv and then retry the template flair', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('setUserFlair', '404 user not found')

    expect(await setCount(app, 'alice', 5)).toEqual(['Set u/alice to 5 trades'])

    expect(app.reddit.calls.filter(c => c.method === 'setUserFlair' || c.method === 'setUserFlairBatch').map(c => c.method))
      .toEqual(['setUserFlair', 'setUserFlairBatch', 'setUserFlair'])
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 5', flairTemplateId: 'tpl-0' })
    expect(await count(app, 'alice')).toBe('5')
  })

  test('two 404s leave a text-only flair and the adjustment still succeeds', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('setUserFlair', '404 not found', 2)

    expect(await setCount(app, 'alice', 5)).toEqual(['Set u/alice to 5 trades'])

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 5' })
    expect(await count(app, 'alice')).toBe('5')
  })

  test('a flaircsv failure fails the adjustment and restores the previous count', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '9')
    app.reddit.failNext('setUserFlair', '404 not found')
    app.reddit.client.setUserFlairBatch = async () => [{ ok: false, status: 'error' }]

    expect(await setCount(app, 'alice', 120)).toEqual(['flaircsv failed for u/alice: error'])

    expect(await count(app, 'alice')).toBe('9')
  })

  test('a failed adjustment for a user whose count was never stored does not touch other users', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:bob', '4')
    app.reddit.failNext('setUserFlair', 'boom')

    await setCount(app, 'alice', 120)

    expect(await count(app, 'bob')).toBe('4')
    expect(await count(app, 'alice')).toBeUndefined()
  })

  // BUG: when the flair write fails, adjustUserTradeCount restores the count it read earlier, so a trade a confirmation committed in between is overwritten and lost, severity high
  test.fails('does not roll back over a trade that was committed while the flair write was in flight', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '9')
    const original = app.reddit.client.setUserFlair
    app.reddit.client.setUserFlair = async options => {
      app.reddit.client.setUserFlair = original
      // A confirmation commits alice's next trade while this write is in flight (the flair lock is
      // only taken for the flair write, not for the count).
      await app.ctx.redis.set('confirmations:alice', '121')
      throw new Error('Reddit exploded')
    }

    expect(await setCount(app, 'alice', 120)).toEqual(['Reddit exploded'])

    // The count must be what the last successful writer left, not what was read before.
    expect(await count(app, 'alice')).toBe('121')
  })

  // BUG: adjustUserTradeCount writes the count outside the flair lock and outside the confirmation's watched transaction, so a manual set that lands between a confirmation's commit and its flair write leaves the flair showing the confirmation's count while the stored count is the manual one, severity high
  test.fails('keeps flair and stored count in step when a manual set lands between a confirmation commit and its flair write', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '10')
    await app.ctx.redis.set('confirmations:bob', '1')
    const reply = addTrade(app)
    const redis = app.ctx.redis
    const originalSet = redis.set.bind(redis)
    let injected = false
    // The first lock claim for alice happens after the confirmation committed 11 and before its flair write.
    redis.set = (async (key: string, value: string, options?: Parameters<typeof originalSet>[2]) => {
      if (!injected && key === 'userFlairLock:swaps:alice') {
        injected = true
        await adjustUserTradeCount(app.ctx, 'alice', 5)
      }
      return originalSet(key, value, options)
    }) as typeof redis.set

    await deliver(app, reply)

    const stored = await count(app, 'alice')
    expect([stored, app.reddit.flairOf('alice')?.text]).toEqual([stored, `Trades: ${stored}`])
  })
})
