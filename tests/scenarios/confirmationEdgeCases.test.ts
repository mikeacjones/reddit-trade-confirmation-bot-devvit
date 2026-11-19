/**
 * Adversarial scenario probes of trade-confirmation validation, driven through the real
 * CommentSubmit trigger, the hourly rescan job and the "Approve trade confirmation" menu item
 * registered by src/main.ts (src/confirmations.ts, src/rules.ts, src/language.ts). The pure-function
 * counterpart is tests/confirmationEdgeCases.test.ts.
 *
 * A probe that shows the code is correct is a normal test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG: <description>, severity <level>` comment: it keeps CI green and
 * turns red once the bug is fixed, which is the signal to turn it into an ordinary test.
 *
 * Note on the trigger names in the audit brief: src/main.ts registers only `CommentSubmit` for
 * comments. There is no `CommentUpdate` or `CommentDelete` trigger, so an edit or a deletion reaches
 * the app only through what the next CommentSubmit event or the hourly rescan reads from Reddit. The
 * edit and deletion probes below fire what the runtime would fire (nothing, for an edit) and then run
 * the rescan.
 *
 * Each test builds its own world (fresh Devvit mocks, Redis and FakeReddit), so tests share no state
 * and can run in any order. Nothing here sleeps or reads the wall clock.
 */
import { describe, expect } from 'vitest'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const MONTHLY = 't3_monthly'
const APPROVE = 'Approve trade confirmation'

type Mocks = Parameters<typeof newApp>[0]

function eventFor(comment: { id: string; body: string; parentId: string }, author: string | undefined, postId = MONTHLY) {
  return {
    comment: { ...comment, postId, permalink: `/r/swaps/comments/${postId.slice(3)}/_/${comment.id.slice(3)}/` },
    ...(author === undefined ? {} : { author: { name: author } }),
    subreddit: { name: 'swaps' },
  }
}

/** The standard world with the current monthly thread and alice's top-level trade comment t1_offer. */
async function setup(mocks: Mocks, offerBody = 'Sold a kit to u/bob', offerAuthor = 'alice'): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  app.reddit.addComment({ id: 't1_offer', parentId: MONTHLY, postId: MONTHLY, authorName: offerAuthor, body: offerBody })
  return app
}

/** Seed a reply and deliver its CommentSubmit event. */
async function reply(app: AppHarness, id: string, parentId: string, author: string, body: string, postId = MONTHLY) {
  app.reddit.addComment({ id, parentId, postId, authorName: author, body })
  await app.fireTrigger('CommentSubmit', eventFor({ id, body, parentId }, author, postId))
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

function botComments(app: AppHarness) {
  return app.reddit.commentsBy('swapbot')
}

/** Nothing was counted, claimed or flaired for anyone. */
async function expectNoTradeRecorded(app: AppHarness): Promise<void> {
  for (const user of ['alice', 'bob', 'carol', 'dave', 'mod1', 'swapbot', '[deleted]', '']) {
    expect(await count(app, user)).toBeUndefined()
  }
  expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
  expect(flairWrites(app)).toEqual([])
}

async function expectTradeCounted(app: AppHarness): Promise<void> {
  expect(await count(app, 'alice')).toBe('1')
  expect(await count(app, 'bob')).toBe('1')
  expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!)).toMatchObject({ parentAuthor: 'alice', confirmer: 'bob' })
}

describe('the u/ tag in the trade comment', () => {
  test.for([
    ['mixed case (u/Bob vs account bob)', 'Sold a kit to u/Bob'],
    ['all upper case', 'Sold a kit to U/BOB'],
    ['leading slash (/u/bob)', 'Sold a kit to /u/bob'],
    ['trailing period', 'Sold a kit to u/bob.'],
    ['trailing comma', 'Sold a kit to u/bob, thanks'],
    ['markdown bold', 'Sold a kit to **u/bob**'],
    ['markdown link text', 'Sold a kit to [u/bob](https://example.com/x)'],
    ['markdown link to the profile path', 'Sold a kit to [bob](/u/bob)'],
    ['tag on its own line', 'Sold a kit\n\nu/bob'],
    ['two tags, the confirmer second', 'Sold a kit to u/carol and u/bob'],
    ['the same tag twice', 'u/bob u/bob'],
    ['a longer name first, then the exact one', 'u/bob-the-builder and u/bob'],
    ['tag in a code span', 'Sold a kit to `u/bob`'],
  ])('%s: the tagged user confirms and both traders are counted', async ([, offer], { mocks }) => {
    const app = await setup(mocks, offer)

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectTradeCounted(app)
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(app.reddit.repliesTo('t1_reply')[0].body).toContain('u/bob')
  })

  test.for([
    ['a bare name', 'Sold a kit to bob'],
    ['a subreddit tag', 'Sold a kit to r/bob'],
    ['a longer hyphenated name (u/bob-trader)', 'Sold a kit to u/bob-trader'],
    ['a longer underscored name (u/bob_trader)', 'Sold a kit to u/bob_trader'],
    ['a name with a trailing hyphen (u/bob-)', 'Sold a kit to u/bob-'],
    ['a name with trailing digits (u/bob2)', 'Sold a kit to u/bob2'],
    ['a profile URL', 'Sold a kit to https://www.reddit.com/u/bob'],
    ['a Cyrillic look-alike letter (u/b\u043Eb)', 'Sold a kit to u/b\u043Eb'],
    ['a zero-width space inside the name', 'Sold a kit to u/b\u200Bob'],
    ['a space after the prefix', 'Sold a kit to u/ bob'],
  ])('%s: the user is not tagged, so the confirmation gets the cant-confirm reply and nothing is counted', async ([, offer], { mocks }) => {
    const app = await setup(mocks, offer)

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    const replies = app.reddit.repliesTo('t1_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toContain('your username was not specified')
  })

  test('hyphenated usernames: the exact account confirms, its prefix and its extension do not', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bob-the-builder')

    await reply(app, 't1_short', 't1_offer', 'bob', 'confirmed')
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_short')[0].body).toContain('your username was not specified')

    await freeCommentSlot(app)
    await reply(app, 't1_exact', 't1_offer', 'bob-the-builder', 'confirmed')
    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'bob-the-builder')).toBe('1')
    expect(await count(app, 'bob')).toBeUndefined()
  })

  test('underscored usernames: the exact account confirms, a prefix does not', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/alliance\\_bob')

    await reply(app, 't1_short', 't1_offer', 'alliance', 'confirmed')
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()

    await freeCommentSlot(app)
    await reply(app, 't1_exact', 't1_offer', 'alliance_bob', 'confirmed')
    expect(await count(app, 'alliance_bob')).toBe('1')
    expect(await count(app, 'alice')).toBe('1')
  })

  test('a confirmer is matched case-insensitively and counted under the lower-cased key', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bob')

    await reply(app, 't1_reply', 't1_offer', 'BoB', 'confirmed')

    expect(await count(app, 'bob')).toBe('1')
    expect(await count(app, 'BoB')).toBeUndefined()
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  })

  // BUG: a u/ tag inside a quoted block (> ...) counts as the trader tagging that user, so a user who was only quoted can confirm the trade, severity low
  test.fails('a tag that only appears inside a quoted block does not let that user confirm', async ({ mocks }) => {
    const app = await setup(mocks, '> u/bob said he would pay\n\nSold a kit to someone else')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    expect(await count(app, 'bob')).toBeUndefined()
    expect(await count(app, 'alice')).toBeUndefined()
  })

  // BUG: backslash escapes are stripped before matching, so a tag whose u is escaped (\u/bob, shown by Reddit as plain text) counts, severity low
  test.fails('a tag with an escaped u does not let that user confirm', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to \\u/bob')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    expect(await count(app, 'bob')).toBeUndefined()
  })
})

describe('several tags and several confirmers', () => {
  test('one comment tagging two users lets only the first confirmation count; the second is refused', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold kits to u/bob and u/carol')

    await reply(app, 't1_carol', 't1_offer', 'carol', 'confirmed')
    await freeCommentSlot(app)
    await reply(app, 't1_bob', 't1_offer', 'bob', 'confirmed')

    expect(await count(app, 'alice')).toBe('1')
    expect(await count(app, 'carol')).toBe('1')
    expect((await count(app, 'bob')) ?? '0').toBe('0')
    expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!).confirmer).toBe('carol')
    expect(app.reddit.repliesTo('t1_bob')[0].body).toContain('already been confirmed')
  })

  test('an untagged third user replying to a two-tag comment is told they were not specified', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold kits to u/bob and u/carol')

    await reply(app, 't1_dave', 't1_offer', 'dave', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_dave')[0].body).toContain('your username was not specified')
  })

  test('the trade comment author tagging themselves and the partner still needs the partner to confirm', async ({ mocks }) => {
    const app = await setup(mocks, 'u/alice sold a kit to u/bob')

    await reply(app, 't1_self', 't1_offer', 'alice', 'confirmed')
    expect(await count(app, 'alice')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_self')).toEqual([])

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    await expectTradeCounted(app)
  })

  test('a tag for the confirmer in a different trade comment does not authorise this one', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit, details to follow')
    app.reddit.addComment({ id: 't1_other', parentId: MONTHLY, postId: MONTHLY, authorName: 'alice', body: 'Sold a mug to u/bob' })

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')[0].body).toContain('your username was not specified')
  })
})

describe('the confirmation keyword', () => {
  test.for([
    ['upper case', 'CONFIRMED'],
    ['mixed case', 'cOnFiRmEd'],
    ['with punctuation', 'Confirmed!!!'],
    ['quoted', '"confirmed"'],
    ['inside a sentence', 'yes, all confirmed on my end'],
    ['after a blank line', '\n\nconfirmed'],
    ['with an emoji', 'confirmed \u{1F44D}'],
  ])('%s is a confirmation', async ([, body], { mocks }) => {
    const app = await setup(mocks)

    await reply(app, 't1_reply', 't1_offer', 'bob', body)

    await expectTradeCounted(app)
  })

  test.for([
    ['a different word', 'thanks, all good'],
    ['a prefix of the keyword', 'confirm'],
    ['the keyword split by a hyphen', 'con-firmed'],
    ['a Cyrillic look-alike letter', 'conf\u0456rmed'],
    ['an empty body', ''],
    ['a deleted body', '[deleted]'],
  ])('%s is ignored without a reply', async ([, body], { mocks }) => {
    const app = await setup(mocks)

    await reply(app, 't1_reply', 't1_offer', 'bob', body)

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
  })

  test('a custom keyword from the settings replaces the default, in any case and any script', async ({ mocks }) => {
    const app = await setup(mocks)
    mocks.settings.put('confirmation_keyword', 'Best\u00E4tigt')

    await reply(app, 't1_no', 't1_offer', 'bob', 'confirmed')
    await expectNoTradeRecorded(app)

    await reply(app, 't1_yes', 't1_offer', 'bob', 'BEST\u00C4TIGT!')
    await expectTradeCounted(app)
  })

  test('a blank keyword setting falls back to "confirmed"', async ({ mocks }) => {
    const app = await setup(mocks)
    mocks.settings.put('confirmation_keyword', '   ')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'Confirmed')

    await expectTradeCounted(app)
  })

  // BUG: the keyword is a plain substring, so "unconfirmed" or "not confirmed" confirms the trade for both traders (the setting is documented as a substring, but negations are not handled), severity medium
  test.fails('"not confirmed" does not count a trade', async ({ mocks }) => {
    const app = await setup(mocks)

    await reply(app, 't1_reply', 't1_offer', 'bob', 'NOT confirmed, he never shipped')

    expect(await count(app, 'alice')).toBeUndefined()
    expect(await count(app, 'bob')).toBeUndefined()
  })
})

describe('edited comments', () => {
  test('no trigger is registered for edits or deletions, only CommentSubmit', async ({ mocks }) => {
    const app = newApp(mocks)
    expect(app.registered().triggers.filter(t => t.startsWith('Comment'))).toEqual(['CommentSubmit'])
  })

  // BUG: a reply edited to add the keyword after the bot has already ignored it is never counted (no CommentUpdate trigger, and the rescan skips comments marked processed), severity medium
  test.fails('a reply edited to add the keyword is counted by the next rescan', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'thanks, great trade')
    expect(await count(app, 'bob')).toBeUndefined()

    app.reddit.comments.get('t1_reply')!.body = 'thanks, great trade. confirmed'
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
  })

  // BUG: a trade comment edited to add the missing tag after the confirmer was refused is never re-evaluated, so the confirmer has to post a new reply, severity low
  test.fails('a trade comment edited to add the tag lets the earlier reply count on the next rescan', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit, details to follow')
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()

    app.reddit.comments.get('t1_offer')!.body = 'Sold a kit to u/bob'
    await freeCommentSlot(app)
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
  })

  test('a fresh reply after the trade comment was edited to add the tag counts', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit, details to follow')
    await reply(app, 't1_first', 't1_offer', 'bob', 'confirmed')
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()

    app.reddit.comments.get('t1_offer')!.body = 'Sold a kit to u/bob'
    await freeCommentSlot(app)
    await reply(app, 't1_second', 't1_offer', 'bob', 'confirmed again')

    await expectTradeCounted(app)
  })

  test('removing the keyword from the confirmation after it counted does not undo or repeat the trade', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    app.reddit.comments.get('t1_reply')!.body = 'never mind'
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('removing the tag from the trade comment after it was confirmed does not undo or repeat the trade', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    app.reddit.comments.get('t1_offer')!.body = 'Sold a kit'
    await app.runJob('rescan-monthly-post')
    await freeCommentSlot(app)
    await reply(app, 't1_again', 't1_offer', 'bob', 'confirmed')

    await expectTradeCounted(app)
    expect(app.reddit.repliesTo('t1_again')).toHaveLength(1)
  })

  test('an edit that keeps the confirmation does not count the trade twice when the event is redelivered', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    app.reddit.comments.get('t1_reply')!.body = 'confirmed (typo fixed)'
    await app.fireTrigger('CommentSubmit', eventFor({ id: 't1_reply', body: 'confirmed (typo fixed)', parentId: 't1_offer' }, 'bob'))
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('editing the trade comment to tag someone else after confirmation leaves the claim on the original trade', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    app.reddit.comments.get('t1_offer')!.body = 'Sold a kit to u/carol'
    await freeCommentSlot(app)
    await reply(app, 't1_carol', 't1_offer', 'carol', 'confirmed')

    await expectTradeCounted(app)
    expect((await count(app, 'carol')) ?? '0').toBe('0')
    expect(app.reddit.repliesTo('t1_carol')[0].body).toContain('already been confirmed')
  })
})

describe('deleted or removed comments and accounts', () => {
  test('a removed trade comment cannot be confirmed, and the rescan does not revive it', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.comments.get('t1_offer')!.removed = true

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    await app.runJob('rescan-monthly-post')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
  })

  test('a trade comment removed after it was confirmed keeps its counts', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    app.reddit.comments.get('t1_offer')!.removed = true
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
  })

  test('a trade comment that cannot be fetched at all fails the handler loudly and records nothing', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_gone', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })

    await expect(
      app.fireTrigger('CommentSubmit', eventFor({ id: 't1_reply', body: 'confirmed', parentId: 't1_gone' }, 'bob')),
    ).rejects.toThrow('404')

    await expectNoTradeRecorded(app)
    expect(await app.ctx.redis.get('processed:t1_reply')).toBeUndefined()
    expect(await app.ctx.redis.get('processing:t1_reply')).toBeUndefined()
  })

  test('a deleted trade comment ([deleted] author and body) is never confirmed or flaired', async ({ mocks }) => {
    const app = await setup(mocks, '[deleted]', '[deleted]')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
  })

  test('a confirmation from a deleted account ([deleted]) is refused and counts nobody', async ({ mocks }) => {
    const app = await setup(mocks)

    await reply(app, 't1_reply', 't1_offer', '[deleted]', 'confirmed')

    await expectNoTradeRecorded(app)
  })

  test('a trade comment whose author shows as [deleted] but whose text is intact is not confirmable', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bob', '[deleted]')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    expect(await count(app, '[deleted]')).toBeUndefined()
    expect(await count(app, 'bob')).toBeUndefined()
    expect(app.reddit.flairOf('[deleted]')).toBeUndefined()
  })

  test('a confirmation with no author never counts a trade', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/ bob')
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: '', body: 'confirmed' })

    await app.fireTrigger('CommentSubmit', eventFor({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, undefined))

    expect(await count(app, 'alice')).toBeUndefined()
    expect(await count(app, '')).toBeUndefined()
    expect(flairWrites(app)).toEqual([])
  })

  test('a confirmation that was removed before processing does not count', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed', removed: true })

    await app.fireTrigger('CommentSubmit', eventFor({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, 'bob'))

    expect(await count(app, 'alice')).toBeUndefined()
    expect(await count(app, 'bob')).toBeUndefined()
  })

  test('a removed confirmation is not answered, and counts once a moderator re-approves it before a rescan', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed', removed: true })

    await app.fireTrigger('CommentSubmit', eventFor({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, 'bob'))
    await app.runJob('rescan-monthly-post')

    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
    expect(await count(app, 'alice')).toBeUndefined()

    app.reddit.comments.get('t1_reply')!.removed = false
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
  })

  test('a moderator can still approve a removed confirmation', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed', removed: true })

    const toasts = (await app.pressMenuItem(APPROVE, { location: 'comment', targetId: 't1_reply' })).toasts

    expect(toasts).toEqual(['Approved confirmation for u/alice and u/bob'])
    await expectTradeCounted(app)
  })

  test('a confirmation deleted after it counted keeps its counts and is not answered twice by the rescan', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    app.reddit.comments.get('t1_reply')!.removed = true
    app.reddit.comments.get('t1_reply')!.authorName = '[deleted]'
    app.reddit.comments.get('t1_reply')!.body = '[deleted]'
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })
})

describe('the parent author is the bot or a moderator', () => {
  test('a moderator as the trade comment author gets the moderator flair; the confirmer the normal one', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bob', 'mod1')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    expect(await count(app, 'mod1')).toBe('1')
    expect(await count(app, 'bob')).toBe('1')
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 1', flairTemplateId: 'tpl-mod' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  })

  test('a moderator confirming and the moderator check is case-insensitive', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/MOD1')

    await reply(app, 't1_reply', 't1_offer', 'mod1', 'confirmed')

    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 1', flairTemplateId: 'tpl-mod' })
  })

  test('two moderators trading with each other both get moderator flair', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/mod2', 'mod1')
    app.reddit.addModerator('mod2')

    await reply(app, 't1_reply', 't1_offer', 'mod2', 'confirmed')

    expect(app.reddit.flairOf('mod1')?.text).toBe('Moderator | Trades: 1')
    expect(app.reddit.flairOf('mod2')?.text).toBe('Moderator | Trades: 1')
  })

  test("the bot's own reply under a confirmation is not mistaken for a trade or a confirmation", async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    const [botReply] = botComments(app)
    await freeCommentSlot(app)

    await app.fireTrigger('CommentSubmit', eventFor({ id: botReply.id, body: botReply.body, parentId: botReply.parentId }, 'swapbot'))

    await expectTradeCounted(app)
    expect(await count(app, 'swapbot')).toBeUndefined()
    expect(botComments(app)).toHaveLength(1)
  })

  test('a trade comment authored by the bot is not confirmable', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bob', 'swapbot')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    expect(await count(app, 'swapbot')).toBeUndefined()
    expect(app.reddit.flairOf('swapbot')).toBeUndefined()
  })
})

describe('locked, older and unknown threads', () => {
  test('a confirmation on the current thread after it was locked is ignored without a reply', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.posts.get(MONTHLY)!.locked = true

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
  })

  test('a confirmation sent before the thread was locked still counted, and locking later changes nothing', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    app.reddit.posts.get(MONTHLY)!.locked = true
    await app.runJob('rescan-monthly-post')

    await expectTradeCounted(app)
  })

  test('a real confirmation on an older unlocked monthly thread gets the old-thread reply and counts nothing', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_old', title: 'Last month' })
    app.reddit.addComment({ id: 't1_oldoffer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit to u/bob' })

    await reply(app, 't1_oldreply', 't1_oldoffer', 'bob', 'confirmed', 't3_old')

    await expectNoTradeRecorded(app)
    expect(await app.ctx.redis.get('confirmed:t1_oldoffer')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_oldreply')).toHaveLength(1)
    expect(app.reddit.repliesTo('t1_oldreply')[0].body).toContain('newest confirmation thread')
  })

  test('the rescan only reads the current thread, so an older thread is never reprocessed', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_old', title: 'Last month' })
    app.reddit.addComment({ id: 't1_oldoffer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit to u/bob' })
    app.reddit.addComment({ id: 't1_oldreply', parentId: 't1_oldoffer', postId: 't3_old', authorName: 'bob', body: 'confirmed' })

    await app.runJob('rescan-monthly-post')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_oldreply')).toEqual([])
  })

  // BUG: on an older unlocked thread the bot answers every non-top-level comment with the old-thread reply, even chatter with no confirmation keyword and no connection to a trade, severity medium
  test.fails('chatter without the keyword on an older thread gets no old-thread reply', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_old', title: 'Last month' })
    app.reddit.addComment({ id: 't1_oldoffer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit to u/bob' })

    await reply(app, 't1_chat', 't1_oldoffer', 'bob', 'thanks, shipped it yesterday', 't3_old')

    expect(app.reddit.repliesTo('t1_chat')).toEqual([])
  })

  test('the bot does not answer its own old-thread reply', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_old', title: 'Last month' })
    app.reddit.addComment({ id: 't1_oldoffer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit to u/bob' })
    await reply(app, 't1_oldreply', 't1_oldoffer', 'bob', 'confirmed', 't3_old')
    const [botReply] = botComments(app)
    await freeCommentSlot(app)

    await app.fireTrigger('CommentSubmit', eventFor({ id: botReply.id, body: botReply.body, parentId: botReply.parentId }, 'swapbot', 't3_old'))

    expect(botComments(app)).toHaveLength(1)
  })

  test('a thread the bot did not create is ignored even when the comment body is a valid confirmation', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_user', title: 'Some user post', authorName: 'carol' })
    app.reddit.addComment({ id: 't1_uoffer', parentId: 't3_user', postId: 't3_user', authorName: 'alice', body: 'Sold a kit to u/bob' })

    await reply(app, 't1_ureply', 't1_uoffer', 'bob', 'confirmed', 't3_user')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_ureply')).toEqual([])
  })
})

describe('moderator approval (Approve trade confirmation)', () => {
  const approve = async (app: AppHarness, targetId: string) =>
    (await app.pressMenuItem(APPROVE, { location: 'comment', targetId })).toasts

  test('approving an untagged, keyword-less reply counts the trade for both traders (the moderator decides)', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit')
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'ok' })

    expect(await approve(app, 't1_reply')).toEqual(['Approved confirmation for u/alice and u/bob'])

    await expectTradeCounted(app)
    expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!).modApproval).toBe(true)
  })

  test('approving the reply that already confirmed the trade changes no count and posts no second reply', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await approve(app, 't1_reply')

    await expectTradeCounted(app)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(app.reddit.flairOf('alice')?.text).toBe('Trades: 1')
  })

  test('approving a second reply to an already-confirmed trade is refused and counts nothing more', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    app.reddit.addComment({ id: 't1_second', parentId: 't1_offer', postId: MONTHLY, authorName: 'carol', body: 'also me' })

    expect(await approve(app, 't1_second')).toEqual(['That trade comment has already been confirmed'])

    await expectTradeCounted(app)
    expect((await count(app, 'carol')) ?? '0').toBe('0')
    expect(app.reddit.flairOf('carol')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_second')).toEqual([])
  })

  test('approving the same reply twice counts the trade once', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit')
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'ok' })

    await approve(app, 't1_reply')
    await approve(app, 't1_reply')

    await expectTradeCounted(app)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('the trigger event for a reply a moderator already approved does not count it again', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bob')
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
    await approve(app, 't1_reply')

    await app.fireTrigger('CommentSubmit', eventFor({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, 'bob'))

    await expectTradeCounted(app)
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('a self-confirmation is refused, also when the account names differ only in case', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/alice', 'Alice')
    app.reddit.addComment({ id: 't1_self', parentId: 't1_offer', postId: MONTHLY, authorName: 'alice', body: 'confirmed' })

    expect(await approve(app, 't1_self')).toEqual(['A user cannot confirm their own trade'])

    await expectNoTradeRecorded(app)
    expect(await count(app, 'Alice')).toBeUndefined()
    expect(flairWrites(app)).toEqual([])
  })

  test('a moderator approving their own trade comment partner works and flairs the moderator', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit', 'mod1')
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'ok' })

    await approve(app, 't1_reply')

    expect(app.reddit.flairOf('mod1')?.text).toBe('Moderator | Trades: 1')
    expect(app.reddit.flairOf('bob')?.text).toBe('Trades: 1')
  })

  test('a moderator cannot approve a reply to a removed trade comment', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.comments.get('t1_offer')!.removed = true
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })

    expect(await approve(app, 't1_reply')).toEqual(['Parent trade comment cannot be confirmed'])

    await expectNoTradeRecorded(app)
  })

  test.for([
    ['a reply to a reply', async (app: AppHarness) => {
      app.reddit.addComment({ id: 't1_chat', parentId: 't1_offer', postId: MONTHLY, authorName: 'alice', body: 'u/bob did you get it?' })
      app.reddit.addComment({ id: 't1_nested', parentId: 't1_chat', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
      return 't1_nested'
    }, 'Select a direct reply to a trade comment'],
    ['a top-level comment', async () => 't1_offer', 'Select a reply to a trade comment, not a top-level comment'],
    ["the bot's own confirmation reply", async (app: AppHarness) => {
      app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
      app.reddit.addComment({ id: 't1_bot', parentId: 't1_reply', postId: MONTHLY, authorName: 'swapbot', body: 'Trade counted' })
      return 't1_bot'
    }, 'Select a direct reply to a trade comment'],
    ['a post', async () => MONTHLY, 'Select a confirmation comment to approve'],
    ['an empty target', async () => '', 'Select a confirmation comment to approve'],
  ] as Array<[string, (app: AppHarness) => Promise<string>, string]>)('%s is refused with a clear message', async ([, target, message], { mocks }) => {
    const app = await setup(mocks)
    const targetId = await target(app)

    expect(await approve(app, targetId)).toEqual([message])

    await expectNoTradeRecorded(app)
  })

  test('a reply on an older thread or on a locked thread cannot be approved', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_old', title: 'Last month' })
    app.reddit.addComment({ id: 't1_oldoffer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit to u/bob' })
    app.reddit.addComment({ id: 't1_oldreply', parentId: 't1_oldoffer', postId: 't3_old', authorName: 'bob', body: 'confirmed' })
    expect(await approve(app, 't1_oldreply')).toEqual(['Selected comment is not on the current monthly confirmation thread'])

    app.reddit.posts.get(MONTHLY)!.locked = true
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
    expect(await approve(app, 't1_reply')).toEqual(['Selected confirmation thread is locked'])

    await expectNoTradeRecorded(app)
  })

  test('a reply that cannot be fetched surfaces the error as a toast and records nothing', async ({ mocks }) => {
    const app = await setup(mocks)

    const [toast] = await approve(app, 't1_missing')

    expect(toast).toContain('404')
    await expectNoTradeRecorded(app)
  })

  test('a reply from a deleted account ([deleted]) cannot be approved', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit')
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: '[deleted]', body: '[deleted]' })

    await approve(app, 't1_reply')

    expect(await count(app, '[deleted]')).toBeUndefined()
    expect(await count(app, 'alice')).toBeUndefined()
    expect(app.reddit.flairOf('[deleted]')).toBeUndefined()
  })

  test('a reply to a trade comment from a deleted account ([deleted]) cannot be approved', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bob', '[deleted]')
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })

    await approve(app, 't1_reply')

    expect(await count(app, '[deleted]')).toBeUndefined()
    expect(await count(app, 'bob')).toBeUndefined()
  })
})
