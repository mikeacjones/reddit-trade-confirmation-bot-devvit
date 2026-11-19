/**
 * Scenario tests for the moderator tools registered by src/main.ts: the "Approve trade
 * confirmation", "Set user trade count" (menu item and form), "Adjust comment author's flair",
 * "Set up default user flairs", "Refresh flair template cache" and "Refresh moderator cache" menu
 * items, and the mod-only flair template rule (src/adjustments.ts, src/flairCache.ts,
 * src/moderators.ts, src/rules.ts, src/confirmations.ts). They guard current behavior.
 *
 * Every test presses the real menu item (or submits the real form it opened) through the harness and
 * asserts on the toasts, Redis and FakeReddit state. Each test builds its own world (fresh Devvit
 * mocks, Redis and FakeReddit), so tests share no state and can run in any order. Nothing here sleeps:
 * no scenario hits a rate limit or the flair lock.
 */
import { describe, expect } from 'vitest'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const MONTHLY = 't3_monthly'

type Mocks = Parameters<typeof newApp>[0]

/** The standard world with the current monthly thread pointer set. */
async function setup(mocks: Mocks): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return app
}

/** alice's top-level trade comment t1_offer; mod-approval does not need the tag or the keyword. */
function addOffer(app: AppHarness, body = 'Sold a kit', author = 'alice') {
  app.reddit.addComment({ id: 't1_offer', parentId: MONTHLY, postId: MONTHLY, authorName: author, body })
}

function addReply(app: AppHarness, id: string, parentId: string, author: string, body: string, postId = MONTHLY) {
  app.reddit.addComment({ id, parentId, postId, authorName: author, body })
}

/** The bot spaces its replies with a Redis slot that lasts real seconds; free it instead of sleeping. */
async function freeCommentSlot(app: AppHarness): Promise<void> {
  await app.ctx.redis.del('reddit:comment-submit-slot')
}

async function count(app: AppHarness, user: string): Promise<string | undefined> {
  return app.ctx.redis.get(`confirmations:${user}`)
}

function flairWrites(app: AppHarness) {
  return app.reddit.calls.filter(c => c.method === 'setUserFlair' || c.method === 'setUserFlairBatch')
}

/** Open "Set user trade count" and submit it. */
async function setCount(app: AppHarness, username: string, value: unknown): Promise<string[]> {
  const { forms } = await app.pressMenuItem('Set user trade count')
  return (await app.submitForm(forms[0].id, { username, count: value })).toasts
}

async function cachedTemplates(app: AppHarness): Promise<Array<{ min: number; max: number; id: string; template: string; modOnly: boolean }>> {
  return JSON.parse((await app.ctx.redis.get('flairTemplates:swaps:Trades%3A'))!)
}

describe('every moderator tool is moderator-only', () => {
  const MOD_TOOLS: Array<[label: string, location: string]> = [
    ['Trigger monthly post now', 'subreddit'],
    ['Re-scan monthly post comments', 'subreddit'],
    ['Set user trade count', 'subreddit'],
    ["Adjust comment author's flair", 'comment'],
    ['Approve trade confirmation', 'comment'],
    ['Set up default user flairs', 'subreddit'],
    ['Refresh flair template cache', 'subreddit'],
    ['Refresh moderator cache', 'subreddit'],
  ]

  test.for(MOD_TOOLS)('%s is registered for moderators only on the %s surface', async ([label, location], { mocks }) => {
    const app = newApp(mocks)
    expect(app.registered().menuItems).toContain(label)
    expect(app.menuItemInfo(label)).toEqual({ location, forUserType: 'moderator' })
  })

  test('the app registers no menu item beyond the moderator tools', async ({ mocks }) => {
    const app = newApp(mocks)
    expect(app.registered().menuItems.sort()).toEqual(MOD_TOOLS.map(([label]) => label).sort())
  })
})

describe('Approve trade confirmation', () => {
  test('counts the trade for both users, flairs them and replies, without keyword or tag', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app, 'Sold a kit')
    addReply(app, 't1_reply', 't1_offer', 'bob', 'thanks, all good')

    const { toasts } = await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })

    expect(toasts).toEqual(['Approved confirmation for u/alice and u/bob'])
    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeDefined()
  })

  test('adds to existing counts and moves the flair across a template range', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app)
    addReply(app, 't1_reply', 't1_offer', 'bob', 'ok')
    await app.ctx.redis.set('confirmations:alice', '99')
    await app.ctx.redis.set('confirmations:bob', '5')

    await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })

    expect(await count(app, 'alice')).toBe('100')
    expect(await count(app, 'bob')).toBe('6')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 100', flairTemplateId: 'tpl-100' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 6', flairTemplateId: 'tpl-0' })
  })

  test('approving the same reply again is a replay: it counts the trade and replies once', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app)
    addReply(app, 't1_reply', 't1_offer', 'bob', 'ok')
    const press = () => app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })

    await press()
    await freeCommentSlot(app)
    const second = await press()

    expect(second.toasts).toEqual(['Approved confirmation for u/alice and u/bob'])
    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('approving a second reply to an already-approved trade comment refuses it', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app, 'Sold a kit to u/bob and u/carol')
    addReply(app, 't1_reply_bob', 't1_offer', 'bob', 'ok')
    addReply(app, 't1_reply_carol', 't1_offer', 'carol', 'ok')

    await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply_bob' })
    await freeCommentSlot(app)
    const second = await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply_carol' })

    expect(second.toasts).toEqual(['That trade comment has already been confirmed'])
    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    // carol is seeded from her (empty) flair but the refused approval adds no trade to her.
    expect(await count(app, 'carol')).not.toBe('1')
    expect(app.reddit.repliesTo('t1_reply_carol')).toEqual([])
  })

  test('approving a reply the CommentSubmit trigger already confirmed counts the trade once and does not reply again', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app, 'Sold a kit to u/bob')
    addReply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    await app.fireTrigger('CommentSubmit', {
      comment: { id: 't1_reply', body: 'confirmed', parentId: 't1_offer', postId: MONTHLY, permalink: '/r/swaps/comments/monthly/_/reply/' },
      author: { name: 'bob' },
      subreddit: { name: 'swaps' },
    })
    expect(await count(app, 'alice')).toBe('1')
    await freeCommentSlot(app)

    const { toasts } = await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })

    expect(toasts).toEqual(['Approved confirmation for u/alice and u/bob'])
    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('the hourly rescan does not recount a trade a moderator approved', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app, 'Sold a kit to u/bob')
    addReply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })
    await freeCommentSlot(app)

    await app.runJob('rescan-monthly-post')

    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
  })

  test('gives a moderator who is a party to the trade the mod-only flair', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app)
    addReply(app, 't1_reply', 't1_offer', 'mod1', 'ok')

    await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })

    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 1', flairTemplateId: 'tpl-mod' })
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  })

  describe('rejects what is not an approvable reply and records nothing', () => {
    const cases: Array<{ name: string; toast: string; arrange: (app: AppHarness) => string | Promise<string> }> = [
      {
        name: 'a target that is not a comment',
        toast: 'Select a confirmation comment to approve',
        arrange: app => { addOffer(app); return MONTHLY },
      },
      {
        name: 'a top-level comment',
        toast: 'Select a reply to a trade comment, not a top-level comment',
        arrange: app => { addOffer(app); return 't1_offer' },
      },
      {
        name: 'the trade comment author replying to their own comment',
        toast: 'A user cannot confirm their own trade',
        arrange: app => { addOffer(app); addReply(app, 't1_reply', 't1_offer', 'alice', 'confirmed'); return 't1_reply' },
      },
      {
        name: 'a reply to a reply',
        toast: 'Select a direct reply to a trade comment',
        arrange: app => {
          addOffer(app)
          addReply(app, 't1_first', 't1_offer', 'bob', 'hi')
          addReply(app, 't1_reply', 't1_first', 'carol', 'confirmed')
          return 't1_reply'
        },
      },
      {
        name: 'a trade comment that was removed',
        toast: 'Parent trade comment cannot be confirmed',
        arrange: app => {
          addOffer(app)
          app.reddit.comments.get('t1_offer')!.removed = true
          addReply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
          return 't1_reply'
        },
      },
      {
        name: 'a reply in a previous monthly thread',
        toast: 'Selected comment is not on the current monthly confirmation thread',
        arrange: app => {
          app.reddit.addPost({ id: 't3_old', title: 'Confirmed Trade Thread' })
          app.reddit.addComment({ id: 't1_offer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit' })
          addReply(app, 't1_reply', 't1_offer', 'bob', 'confirmed', 't3_old')
          return 't1_reply'
        },
      },
      {
        name: 'a reply in a locked thread',
        toast: 'Selected confirmation thread is locked',
        arrange: app => {
          addOffer(app)
          app.reddit.posts.get(MONTHLY)!.locked = true
          addReply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
          return 't1_reply'
        },
      },
      {
        name: 'a reply on a post the bot did not create',
        toast: 'Selected comment is not on a bot confirmation thread',
        arrange: app => {
          app.reddit.addPost({ id: 't3_user', title: 'WTS', authorName: 'carol' })
          app.reddit.addComment({ id: 't1_offer', parentId: 't3_user', postId: 't3_user', authorName: 'alice', body: 'Sold a kit' })
          addReply(app, 't1_reply', 't1_offer', 'bob', 'confirmed', 't3_user')
          return 't1_reply'
        },
      },
    ]

    test.for(cases)('$name', async ({ toast, arrange }, { mocks }) => {
      const app = await setup(mocks)
      const targetId = await arrange(app)

      const { toasts } = await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId })

      expect(toasts).toEqual([toast])
      for (const user of ['alice', 'bob', 'carol']) expect(await count(app, user)).toBeUndefined()
      expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
      expect(flairWrites(app)).toEqual([])
      expect(app.reddit.commentsBy('swapbot')).toEqual([])
    })
  })

  test('a comment that does not exist is reported as a toast', async ({ mocks }) => {
    const app = await setup(mocks)

    const { toasts } = await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_missing' })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/t1_missing/)
    expect(flairWrites(app)).toEqual([])
  })
})

describe('Set user trade count form', () => {
  test('opens a form with a username field and a count field defaulting to zero', async ({ mocks }) => {
    const app = await setup(mocks)

    const { forms, toasts } = await app.pressMenuItem('Set user trade count')

    expect(toasts).toEqual([])
    expect(forms).toHaveLength(1)
    expect(forms[0].title).toBe('Set user trade count')
    expect(forms[0].fields.map(f => [f.name, f.defaultValue])).toEqual([['username', ''], ['count', 0]])
  })

  test('sets the count and the matching flair for a regular user', async ({ mocks }) => {
    const app = await setup(mocks)

    const toasts = await setCount(app, 'alice', 250)

    expect(toasts).toEqual(['Set u/alice to 250 trades'])
    expect(await count(app, 'alice')).toBe('250')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 250', flairTemplateId: 'tpl-200' })
  })

  test('replaces an existing count, up or down, and moves the flair template', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '350')
    app.reddit.setFlair('alice', 'Trades: 350')

    await setCount(app, 'alice', 12)
    expect(await count(app, 'alice')).toBe('12')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 12', flairTemplateId: 'tpl-0' })

    await setCount(app, 'alice', 905)
    expect(await count(app, 'alice')).toBe('905')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 905', flairTemplateId: 'tpl-900' })
  })

  test('accepts zero and picks the template at each range boundary', async ({ mocks }) => {
    const app = await setup(mocks)
    const cases: Array<[number, string]> = [[0, 'tpl-0'], [99, 'tpl-0'], [100, 'tpl-100'], [899, 'tpl-800'], [900, 'tpl-900'], [99999, 'tpl-900']]

    for (const [value, templateId] of cases) {
      await setCount(app, 'alice', value)
      expect(await count(app, 'alice')).toBe(String(value))
      expect(app.reddit.flairOf('alice')).toEqual({ text: `Trades: ${value}`, flairTemplateId: templateId })
    }
  })

  test('takes the username with u/, /u/ or @ and any case, and stores one count per user', async ({ mocks }) => {
    const app = await setup(mocks)

    expect(await setCount(app, ' /u/Alice ', 3)).toEqual(['Set u/Alice to 3 trades'])
    expect(await setCount(app, 'u/ALICE', 4)).toEqual(['Set u/ALICE to 4 trades'])
    expect(await setCount(app, '@alice', 5)).toEqual(['Set u/alice to 5 trades'])

    expect(await count(app, 'alice')).toBe('5')
    expect(await app.ctx.redis.get('confirmations:Alice')).toBeUndefined()
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 5', flairTemplateId: 'tpl-0' })
  })

  test('uses the flair count label from settings', async ({ mocks }) => {
    const app = newApp(mocks)
    mocks.settings.put('flair_count_label', 'Swaps:')
    app.reddit.addFlairTemplate('Swaps: 0-99', { id: 'tpl-a' })

    await setCount(app, 'alice', 7)

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Swaps: 7', flairTemplateId: 'tpl-a' })
  })

  describe('bad input is reported as a toast and changes nothing', () => {
    const cases: Array<[name: string, username: unknown, value: unknown, toast: string]> = [
      ['a negative count', 'alice', -1, 'Trade count must be a non-negative whole number'],
      ['a fractional count', 'alice', 1.5, 'Trade count must be a non-negative whole number'],
      ['a count that is not a number', 'alice', 'many', 'Trade count must be a non-negative whole number'],
      ['an empty username', '  ', 5, 'Username is required'],
      ['a missing username', undefined, 5, 'Username is required'],
      ['a username that is too short', 'al', 5, 'Username must be 3-20 characters and contain only letters, numbers, underscores, or hyphens'],
      ['a username with illegal characters', 'al ice!', 5, 'Username must be 3-20 characters and contain only letters, numbers, underscores, or hyphens'],
      ['a count beyond every template', 'alice', 100000, 'No user flair template found for trade count 100000'],
    ]

    test.for(cases)('%s', async ([, username, value, toast], { mocks }) => {
      const app = await setup(mocks)
      await app.ctx.redis.set('confirmations:alice', '9')
      app.reddit.setFlair('alice', 'Trades: 9')

      const toasts = await setCount(app, username as string, value)

      expect(toasts).toEqual([toast])
      expect(await count(app, 'alice')).toBe('9')
      expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 9' })
      expect(flairWrites(app)).toEqual([])
    })
  })

  test('a failed flair write restores the previous count', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '9')
    app.reddit.failNext('setUserFlair', 'Reddit exploded')

    const toasts = await setCount(app, 'alice', 120)

    expect(toasts).toEqual(['Reddit exploded'])
    expect(await count(app, 'alice')).toBe('9')
  })

  test('a failed flair write for a user with no stored count leaves none behind', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('setUserFlair', 'Reddit exploded')

    await setCount(app, 'alice', 120)

    expect(await count(app, 'alice')).toBeUndefined()
  })

  test('re-reads Reddit when the cached templates have none for the count', async ({ mocks }) => {
    const app = newApp(mocks)
    // The first press caches an empty template list; the templates are created afterwards.
    expect(await setCount(app, 'alice', 5)).toEqual(['No user flair template found for trade count 5'])
    app.reddit.addFlairTemplate('Trades: 0-99', { id: 'tpl-late' })

    expect(await setCount(app, 'alice', 5)).toEqual(['Set u/alice to 5 trades'])

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 5', flairTemplateId: 'tpl-late' })
  })
})

describe("Adjust comment author's flair", () => {
  test('opens the form prefilled with the author and stored count, and submitting it sets both', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app)
    await app.ctx.redis.set('confirmations:alice', '7')

    const { forms } = await app.pressMenuItem("Adjust comment author's flair", { location: 'comment', targetId: 't1_offer' })
    expect(forms[0].fields.map(f => f.defaultValue)).toEqual(['alice', 7])

    const { toasts } = await app.submitForm(forms[0].id, { username: 'alice', count: 150 })

    expect(toasts).toEqual(['Set u/alice to 150 trades'])
    expect(await count(app, 'alice')).toBe('150')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 150', flairTemplateId: 'tpl-100' })
  })

  test('prefills a count of zero for an author with no stored count', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app)

    const { forms } = await app.pressMenuItem("Adjust comment author's flair", { location: 'comment', targetId: 't1_offer' })

    expect(forms[0].fields.map(f => f.defaultValue)).toEqual(['alice', 0])
  })

  test('refuses a target that is not a comment', async ({ mocks }) => {
    const app = await setup(mocks)

    const { forms, toasts } = await app.pressMenuItem("Adjust comment author's flair", { location: 'comment', targetId: MONTHLY })

    expect(forms).toEqual([])
    expect(toasts).toEqual(['Select a comment to set the author trade count'])
  })

  test('reports a comment that cannot be loaded', async ({ mocks }) => {
    const app = await setup(mocks)

    const { forms, toasts } = await app.pressMenuItem("Adjust comment author's flair", { location: 'comment', targetId: 't1_missing' })

    expect(forms).toEqual([])
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/t1_missing/)
  })
})

describe('Set up default user flairs', () => {
  test('creates the eleven templates: ten count ranges and one mod-only template', async ({ mocks }) => {
    const app = newApp(mocks)

    const { toasts } = await app.pressMenuItem('Set up default user flairs')

    expect(toasts).toEqual(['Created 11 user flair templates'])
    const { flairTemplates } = app.reddit
    expect(flairTemplates).toHaveLength(11)
    expect(flairTemplates.map(t => t.text)).toEqual([
      'Trades: 0-99', 'Trades: 100-199', 'Trades: 200-299', 'Trades: 300-399', 'Trades: 400-499',
      'Trades: 500-599', 'Trades: 600-699', 'Trades: 700-799', 'Trades: 800-899', 'Trades: 900-99999',
      'Moderator | Trades: 0-99999',
    ])
    expect(flairTemplates.filter(t => t.modOnly).map(t => t.text)).toEqual(['Moderator | Trades: 0-99999'])
    expect(flairTemplates[10]).toMatchObject({ backgroundColor: '#46d160', textColor: 'dark' })
    expect(await app.ctx.redis.get('flairs_seeded')).toBe('1')
  })

  test('gives each count template a hex background and a text color that contrasts with it', async ({ mocks }) => {
    const app = newApp(mocks)

    await app.pressMenuItem('Set up default user flairs')

    for (const t of app.reddit.flairTemplates.slice(0, 10)) {
      expect(t.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
      const [r, g, b] = [1, 3, 5].map(i => parseInt(t.backgroundColor!.slice(i, i + 2), 16))
      const luminance = (r * 299 + g * 587 + b * 114) / 1000
      expect(t.textColor).toBe(luminance > 128 ? 'dark' : 'light')
    }
  })

  test('a second run is a no-op: it makes no Reddit call and adds no templates', async ({ mocks }) => {
    const app = newApp(mocks)
    await app.pressMenuItem('Set up default user flairs')
    const callsAfterFirst = app.reddit.calls.length

    const second = await app.pressMenuItem('Set up default user flairs')

    expect(second.toasts).toEqual(['Flairs already set up'])
    expect(app.reddit.flairTemplates).toHaveLength(11)
    expect(app.reddit.calls).toHaveLength(callsAfterFirst)
  })

  test('the new templates work straight away: they are cached and a trade count takes the right one', async ({ mocks }) => {
    const app = newApp(mocks)
    app.reddit.addModerator('mod1')
    await app.pressMenuItem('Set up default user flairs')

    expect(await cachedTemplates(app)).toHaveLength(11)
    await setCount(app, 'alice', 450)
    await setCount(app, 'mod1', 450)

    const aliceTemplate = app.reddit.flairTemplates.find(t => t.text === 'Trades: 400-499')!
    const modTemplate = app.reddit.flairTemplates.find(t => t.modOnly)!
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 450', flairTemplateId: aliceTemplate.id })
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 450', flairTemplateId: modTemplate.id })
  })

  test('uses the flair count label and moderator prefix from settings', async ({ mocks }) => {
    const app = newApp(mocks)
    mocks.settings.put('flair_count_label', 'Swaps:')
    mocks.settings.put('moderator_flair_prefix', 'Mod')

    await app.pressMenuItem('Set up default user flairs')

    expect(app.reddit.flairTemplates).toHaveLength(11)
    expect(app.reddit.flairTemplates[0].text).toBe('Swaps: 0-99')
    expect(app.reddit.flairTemplates[9].text).toBe('Swaps: 900-99999')
    expect(app.reddit.flairTemplates[10].text).toBe('Mod | Swaps: 0-99999')
  })

  test('a failed run is not recorded as set up, so the moderator can run it again', async ({ mocks }) => {
    const app = newApp(mocks)
    app.reddit.failNext('createUserFlairTemplate', 'Reddit exploded')

    await expect(app.pressMenuItem('Set up default user flairs')).rejects.toThrow('Reddit exploded')
    expect(await app.ctx.redis.get('flairs_seeded')).toBeUndefined()
    expect(app.reddit.flairTemplates).toHaveLength(0)

    const retry = await app.pressMenuItem('Set up default user flairs')
    expect(retry.toasts).toEqual(['Created 11 user flair templates'])
    expect(app.reddit.flairTemplates).toHaveLength(11)
  })

  test('a failure part-way and a retry does not duplicate the templates already created', async ({ mocks }) => {
    const app = newApp(mocks)
    const create = app.reddit.client.createUserFlairTemplate
    let calls = 0
    app.reddit.client.createUserFlairTemplate = async options => {
      if (++calls === 6) throw new Error('Reddit exploded')
      return create(options)
    }

    await expect(app.pressMenuItem('Set up default user flairs')).rejects.toThrow('Reddit exploded')
    await app.pressMenuItem('Set up default user flairs')

    expect(app.reddit.flairTemplates).toHaveLength(11)
  })
})

describe('Set up default user flairs: existing templates', () => {
  test('skips templates already on the subreddit and creates only the missing ones', async ({ mocks }) => {
    const app = newApp(mocks)
    app.reddit.addFlairTemplate('Trades: 0-99', { id: 'tpl-existing' })
    // Same text but not mod-only: it does not stand in for the moderator template.
    app.reddit.addFlairTemplate('Moderator | Trades: 0-99999')

    const { toasts } = await app.pressMenuItem('Set up default user flairs')

    expect(toasts).toEqual(['Created 10 user flair templates (1 already existed)'])
    expect(app.reddit.flairTemplates).toHaveLength(12)
    expect(app.reddit.flairTemplates.filter(t => t.text === 'Trades: 0-99')).toHaveLength(1)
    expect(app.reddit.flairTemplates.filter(t => t.modOnly)).toHaveLength(1)
    expect(await app.ctx.redis.get('flairs_seeded')).toBe('1')
  })
})

describe('Refresh flair template cache', () => {
  test('re-reads the templates from Reddit and stores them in Redis', async ({ mocks }) => {
    const app = await setup(mocks)

    expect(await app.ctx.redis.get('flairTemplates:swaps:Trades%3A')).toBeUndefined()
    const { toasts } = await app.pressMenuItem('Refresh flair template cache')

    expect(toasts).toEqual(['Flair template cache refreshed'])
    const cached = await cachedTemplates(app)
    expect(cached).toHaveLength(11)
    expect(cached[0]).toEqual({ min: 0, max: 99, id: 'tpl-0', template: 'Trades: 0-99', modOnly: false })
    expect(cached[10]).toEqual({ min: 0, max: 99999, id: 'tpl-mod', template: 'Moderator | Trades: 0-99999', modOnly: true })
  })

  test('a template edited on Reddit is used only after the cache is refreshed', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'alice', 120)
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 120', flairTemplateId: 'tpl-100' })

    const edited = app.reddit.flairTemplates.find(t => t.id === 'tpl-100')!
    edited.text = 'Verified :star: Trades: 100-199'

    // Still the cached text.
    await setCount(app, 'alice', 130)
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 130', flairTemplateId: 'tpl-100' })

    await app.pressMenuItem('Refresh flair template cache')
    await setCount(app, 'alice', 140)
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Verified :star: Trades: 140', flairTemplateId: 'tpl-100' })
  })

  test('picks up a newly added template and drops a deleted one', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.pressMenuItem('Refresh flair template cache')
    app.reddit.addFlairTemplate('Legend | Trades: 1000-1999', { id: 'tpl-legend' })
    app.reddit.flairTemplates.splice(app.reddit.flairTemplates.findIndex(t => t.id === 'tpl-0'), 1)

    await app.pressMenuItem('Refresh flair template cache')

    const ids = (await cachedTemplates(app)).map(t => t.id)
    expect(ids).toContain('tpl-legend')
    expect(ids).not.toContain('tpl-0')
  })

  test('caches only templates that carry the Trades: N-M marker', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addFlairTemplate('Just a flair')
    app.reddit.addFlairTemplate('Trades: many')

    await app.pressMenuItem('Refresh flair template cache')

    expect(await cachedTemplates(app)).toHaveLength(11)
  })

  test('reads the templates under the flair count label from settings', async ({ mocks }) => {
    const app = newApp(mocks)
    mocks.settings.put('flair_count_label', 'Swaps:')
    app.reddit.addFlairTemplate('Swaps: 0-99', { id: 'tpl-a' })
    app.reddit.addFlairTemplate('Trades: 0-99', { id: 'tpl-b' })

    await app.pressMenuItem('Refresh flair template cache')

    const cached = JSON.parse((await app.ctx.redis.get('flairTemplates:swaps:Swaps%3A'))!)
    expect(cached.map((t: { id: string }) => t.id)).toEqual(['tpl-a'])
  })
})

describe('Refresh moderator cache', () => {
  test('reads the moderators from Reddit, lowercased and sorted, and reports how many', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addModerator('Zed')
    app.reddit.addModerator('Beth')

    const { toasts } = await app.pressMenuItem('Refresh moderator cache')

    expect(toasts).toEqual(['Moderator cache refreshed (3 mods)'])
    const cached = JSON.parse((await app.ctx.redis.get('moderators'))!)
    expect(cached.usernames).toEqual(['beth', 'mod1', 'zed'])
    expect(Number.isNaN(Date.parse(cached.syncedAt))).toBe(false)
  })

  test('follows a moderator being added and removed', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.pressMenuItem('Refresh moderator cache')

    app.reddit.addModerator('mod2')
    expect((await app.pressMenuItem('Refresh moderator cache')).toasts).toEqual(['Moderator cache refreshed (2 mods)'])
    expect(JSON.parse((await app.ctx.redis.get('moderators'))!).usernames).toEqual(['mod1', 'mod2'])

    app.reddit.removeModerator('mod1')
    expect((await app.pressMenuItem('Refresh moderator cache')).toasts).toEqual(['Moderator cache refreshed (1 mods)'])
    expect(JSON.parse((await app.ctx.redis.get('moderators'))!).usernames).toEqual(['mod2'])
  })

  test('without a refresh the cached moderator list is used, not Reddit', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.pressMenuItem('Refresh moderator cache')

    app.reddit.addModerator('mod2')
    await setCount(app, 'mod2', 5)

    expect(app.reddit.flairOf('mod2')).toEqual({ text: 'Trades: 5', flairTemplateId: 'tpl-0' })
  })
})

describe('the mod-only template rule', () => {
  test('a moderator gets the mod template and a non-moderator the regular one, at every count', async ({ mocks }) => {
    const app = await setup(mocks)

    for (const value of [0, 99, 100, 450, 900, 99999]) {
      await setCount(app, 'mod1', value)
      await setCount(app, 'alice', value)
      expect(app.reddit.flairOf('mod1')).toEqual({ text: `Moderator | Trades: ${value}`, flairTemplateId: 'tpl-mod' })
      const alice = app.reddit.flairOf('alice')!
      expect(alice.flairTemplateId).not.toBe('tpl-mod')
      expect(alice.text).toBe(`Trades: ${value}`)
    }
  })

  test('the moderator match ignores case', async ({ mocks }) => {
    const app = await setup(mocks)

    await setCount(app, 'MOD1', 10)

    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 10', flairTemplateId: 'tpl-mod' })
  })

  test('a non-moderator is never given the mod template, even when it is the only one', async ({ mocks }) => {
    const app = newApp(mocks)
    app.reddit.addFlairTemplate('Moderator | Trades: 0-99999', { id: 'tpl-mod', modOnly: true })

    const toasts = await setCount(app, 'alice', 5)

    expect(toasts).toEqual(['No user flair template found for trade count 5'])
    expect(await count(app, 'alice')).toBeUndefined()
    expect(flairWrites(app)).toEqual([])
  })

  test('a moderator is never given a regular template, even when it is the only one', async ({ mocks }) => {
    const app = newApp(mocks)
    app.reddit.addModerator('mod1')
    app.reddit.addFlairTemplate('Trades: 0-99', { id: 'tpl-0' })

    const toasts = await setCount(app, 'mod1', 5)

    expect(toasts).toEqual(['No moderator flair template found for trade count 5'])
    expect(await count(app, 'mod1')).toBeUndefined()
    expect(flairWrites(app)).toEqual([])
  })

  test('a moderator template that covers fewer counts leaves other counts without a template', async ({ mocks }) => {
    const app = newApp(mocks)
    app.reddit.addModerator('mod1')
    app.reddit.addFlairTemplate('Trades: 0-99999', { id: 'tpl-user' })
    app.reddit.addFlairTemplate('Moderator | Trades: 0-99', { id: 'tpl-mod', modOnly: true })

    expect(await setCount(app, 'mod1', 50)).toEqual(['Set u/mod1 to 50 trades'])
    expect(await setCount(app, 'mod1', 500)).toEqual(['No moderator flair template found for trade count 500'])
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 50', flairTemplateId: 'tpl-mod' })
    expect(await count(app, 'mod1')).toBe('50')
  })

  test('a user who becomes a moderator moves to the mod template after the moderator cache refresh', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'alice', 20)
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 20', flairTemplateId: 'tpl-0' })

    app.reddit.addModerator('alice')
    await app.pressMenuItem('Refresh moderator cache')
    await setCount(app, 'alice', 20)

    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Moderator | Trades: 20', flairTemplateId: 'tpl-mod' })
  })

  test('a moderator who steps down moves back to a regular template after the moderator cache refresh', async ({ mocks }) => {
    const app = await setup(mocks)
    await setCount(app, 'mod1', 20)

    app.reddit.removeModerator('mod1')
    await app.pressMenuItem('Refresh moderator cache')
    await setCount(app, 'mod1', 20)

    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Trades: 20', flairTemplateId: 'tpl-0' })
  })

  test('a mod-approved trade follows the same rule for both parties', async ({ mocks }) => {
    const app = await setup(mocks)
    addOffer(app, 'Sold a kit', 'mod1')
    addReply(app, 't1_reply', 't1_offer', 'bob', 'ok')

    await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })

    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 1', flairTemplateId: 'tpl-mod' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  })
})
