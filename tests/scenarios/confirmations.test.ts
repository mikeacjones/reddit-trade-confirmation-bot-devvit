/**
 * Scenario tests for the trade confirmation flow, driven through the real CommentSubmit trigger
 * registered by src/main.ts (src/confirmations.ts -> src/handlers.ts, src/flairAssignment.ts,
 * src/userFlairState.ts). They guard current behavior: a valid confirmation counts both traders,
 * flairs them and replies; every rejected case leaves counts and flair alone.
 *
 * Each test builds its own world (fresh Devvit mocks, Redis and FakeReddit), so tests share no state
 * and can run in any order. Nothing here reads the wall clock.
 */
import { describe, expect } from 'vitest'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const MONTHLY = 't3_monthly'

function eventFor(comment: { id: string; body: string; parentId: string }, author: string, postId = MONTHLY) {
  return {
    comment: { ...comment, postId, permalink: `/r/swaps/comments/${postId.slice(3)}/_/${comment.id.slice(3)}/` },
    author: { name: author },
    subreddit: { name: 'swaps' },
  }
}

/** A world with the current monthly thread and alice's top-level trade comment tagging u/bob. */
async function setup(mocks: Parameters<typeof newApp>[0], offerBody = 'Sold a kit to u/bob'): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  app.reddit.addComment({ id: 't1_offer', parentId: MONTHLY, postId: MONTHLY, authorName: 'alice', body: offerBody })
  return app
}

/**
 * The bot spaces its comment submissions with a Redis slot that expires after a few real seconds.
 * A scenario with two bot replies frees the slot by hand instead of sleeping through the expiry.
 */
async function freeCommentSlot(app: AppHarness): Promise<void> {
  await app.ctx.redis.del('reddit:comment-submit-slot')
}

async function reply(app: AppHarness, id: string, parentId: string, author: string, body: string, postId = MONTHLY) {
  app.reddit.addComment({ id, parentId, postId, authorName: author, body })
  await app.fireTrigger('CommentSubmit', eventFor({ id, body, parentId }, author, postId))
}

const USERS = ['alice', 'bob', 'carol', 'dave']

/** Nothing was counted, claimed or flaired for anyone. */
async function expectNoTradeRecorded(app: AppHarness): Promise<void> {
  for (const user of USERS) expect(await app.ctx.redis.get(`confirmations:${user}`)).toBeUndefined()
  expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
  const flairWrites = app.reddit.calls.filter(c => c.method === 'setUserFlair' || c.method === 'setUserFlairBatch')
  expect(flairWrites).toEqual([])
}

describe('a valid confirmation', () => {
  test('increments both counts, sets both flairs and posts one bot reply', async ({ mocks }) => {
    const app = await setup(mocks)
    const { reddit, ctx } = app

    await reply(app, 't1_reply', 't1_offer', 'bob', 'Confirmed! Great trade')

    expect(await ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await ctx.redis.get('confirmations:bob')).toBe('1')
    expect(JSON.parse((await ctx.redis.get('confirmed:t1_offer'))!)).toMatchObject({
      commentId: 't1_reply',
      parentAuthor: 'alice',
      confirmer: 'bob',
      modApproval: false,
      parentPreviousCount: 0,
      parentCount: 1,
      confirmerPreviousCount: 0,
      confirmerCount: 1,
    })
    expect(reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })

    const replies = reddit.repliesTo('t1_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0].authorName).toBe('swapbot')
    expect(replies[0].body).toContain('u/alice')
    expect(replies[0].body).toContain('u/bob')
    // Nothing else was posted under the trade comment or the thread.
    expect(reddit.repliesTo('t1_offer').map(c => c.id)).toEqual(['t1_reply'])
  })

  test('matches the keyword case-insensitively anywhere in the reply and the tag case-insensitively', async ({ mocks }) => {
    const app = await setup(mocks, 'Traded with U/BOB today')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'yep, all CONFIRMED on my end')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
  })

  test('adds to an existing stored count and moves the flair across a template range', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.ctx.redis.set('confirmations:alice', '99')
    await app.ctx.redis.set('confirmations:bob', '4')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('100')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('5')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 100', flairTemplateId: 'tpl-100' })
    expect(app.reddit.flairOf('bob')).toEqual({ text: 'Trades: 5', flairTemplateId: 'tpl-0' })
  })

  test('seeds a first-time trader from their existing flair', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.setFlair('alice', 'Trades: 7')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('8')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 8', flairTemplateId: 'tpl-0' })
  })

  test('gives a moderator the mod-only flair template', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/mod1')

    await reply(app, 't1_reply', 't1_offer', 'mod1', 'confirmed')

    expect(await app.ctx.redis.get('confirmations:mod1')).toBe('1')
    expect(app.reddit.flairOf('mod1')).toEqual({ text: 'Moderator | Trades: 1', flairTemplateId: 'tpl-mod' })
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
  })

  test('two different trades by the same pair count twice', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_offer2', parentId: MONTHLY, postId: MONTHLY, authorName: 'alice', body: 'Another one to u/bob' })

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')
    await freeCommentSlot(app)
    await reply(app, 't1_reply2', 't1_offer2', 'bob', 'confirmed')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('2')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('2')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 2', flairTemplateId: 'tpl-0' })
  })
})

describe('rejected confirmations leave counts and flair unchanged', () => {
  test('self-confirm: the trade comment author replying to their own comment', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/alice')
    app.reddit.setFlair('alice', 'Trades: 3')

    await reply(app, 't1_self', 't1_offer', 'alice', 'confirmed')

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 3' })
    expect(app.reddit.calls.filter(c => c.method === 'setUserFlair')).toEqual([])
    expect(app.reddit.repliesTo('t1_self')).toEqual([])
  })

  test('missing tag: the trade comment does not mention the confirmer', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit, thanks everyone')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    const replies = app.reddit.repliesTo('t1_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toContain('your username was not specified')
  })

  test('missing tag: a tag without the u/ prefix does not count', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to bob')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')[0].body).toContain('your username was not specified')
  })

  test('wrong user tagged: someone other than the tagged user replies', async ({ mocks }) => {
    const app = await setup(mocks)

    await reply(app, 't1_other', 't1_offer', 'carol', 'confirmed')

    await expectNoTradeRecorded(app)
    const replies = app.reddit.repliesTo('t1_other')
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toContain('your username was not specified')
  })

  test('wrong user tagged: a username that only extends the tagged one is not a match', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold a kit to u/bobby-trader')

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')[0].body).toContain('your username was not specified')
  })

  test('a reply without the confirmation keyword is ignored', async ({ mocks }) => {
    const app = await setup(mocks)

    await reply(app, 't1_reply', 't1_offer', 'bob', 'thanks, all good')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
  })

  test('parent not top-level: confirming a reply to a reply is ignored', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_chat', parentId: 't1_offer', postId: MONTHLY, authorName: 'alice', body: 'u/bob did you get it?' })

    await reply(app, 't1_nested', 't1_chat', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(await app.ctx.redis.get('confirmed:t1_chat')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_nested')).toEqual([])
  })

  test('parent not top-level: a top-level comment saying confirmed is ignored', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_top', parentId: MONTHLY, postId: MONTHLY, authorName: 'bob', body: 'confirmed u/alice' })

    await app.fireTrigger('CommentSubmit', eventFor({ id: 't1_top', body: 'confirmed u/alice', parentId: MONTHLY }, 'bob'))

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_top')).toEqual([])
  })

  test('old thread: a reply in a previous, unlocked monthly thread gets the old-thread reply', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_old', title: 'Last month' })
    app.reddit.addComment({ id: 't1_oldoffer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit to u/bob' })

    await reply(app, 't1_oldreply', 't1_oldoffer', 'bob', 'confirmed', 't3_old')

    await expectNoTradeRecorded(app)
    expect(await app.ctx.redis.get('confirmed:t1_oldoffer')).toBeUndefined()
    const replies = app.reddit.repliesTo('t1_oldreply')
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toContain('newest confirmation thread')
  })

  test('old thread: a reply in a locked previous thread is ignored without a reply', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_old', title: 'Last month', locked: true })
    app.reddit.addComment({ id: 't1_oldoffer', parentId: 't3_old', postId: 't3_old', authorName: 'alice', body: 'Sold a kit to u/bob' })

    await reply(app, 't1_oldreply', 't1_oldoffer', 'bob', 'confirmed', 't3_old')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_oldreply')).toEqual([])
  })

  test('wrong thread: a reply on a post the bot did not create is ignored', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addPost({ id: 't3_user', title: 'Some user post', authorName: 'carol' })
    app.reddit.addComment({ id: 't1_uoffer', parentId: 't3_user', postId: 't3_user', authorName: 'alice', body: 'Sold a kit to u/bob' })

    await reply(app, 't1_ureply', 't1_uoffer', 'bob', 'confirmed', 't3_user')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_ureply')).toEqual([])
  })

  test('deleted parent: a removed trade comment cannot be confirmed', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.comments.get('t1_offer')!.removed = true

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
  })

  test('deleted parent: a trade comment whose author is gone cannot be confirmed', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.comments.get('t1_offer')!.authorName = ''

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
  })

  test('deleted parent: a [deleted] author and body never produce a trade', async ({ mocks }) => {
    const app = await setup(mocks)
    const offer = app.reddit.comments.get('t1_offer')!
    offer.authorName = '[deleted]'
    offer.body = '[deleted]'

    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await expectNoTradeRecorded(app)
    expect(await app.ctx.redis.get('confirmations:[deleted]')).toBeUndefined()
  })
})

describe('duplicate or repeated confirmation of the same trade', () => {
  test('the same event delivered twice counts the trade once and replies once', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
    const event = eventFor({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, 'bob')

    await app.fireTrigger('CommentSubmit', event)
    await app.fireTrigger('CommentSubmit', event)

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
    expect(app.reddit.calls.filter(c => c.method === 'submitComment')).toHaveLength(1)
  })

  test('a second reply from the same user confirming the same trade is refused', async ({ mocks }) => {
    const app = await setup(mocks)

    await reply(app, 't1_first', 't1_offer', 'bob', 'confirmed')
    await freeCommentSlot(app)
    await reply(app, 't1_second', 't1_offer', 'bob', 'confirmed again')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!).commentId).toBe('t1_first')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    const refusal = app.reddit.repliesTo('t1_second')
    expect(refusal).toHaveLength(1)
    expect(refusal[0].body).toContain('already been confirmed')
  })

  test('a second tagged user confirming an already-confirmed trade is refused', async ({ mocks }) => {
    const app = await setup(mocks, 'Sold kits to u/bob and u/carol')

    await reply(app, 't1_bob', 't1_offer', 'bob', 'confirmed')
    await freeCommentSlot(app)
    await reply(app, 't1_carol', 't1_offer', 'carol', 'confirmed')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    // The refused confirmer may be seeded with a stored 0 before the claim is checked; never above 0.
    expect((await app.ctx.redis.get('confirmations:carol')) ?? '0').toBe('0')
    expect(app.reddit.flairOf('carol')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_carol')[0].body).toContain('already been confirmed')
  })

  test('the hourly rescan does not count a trade the trigger already confirmed', async ({ mocks }) => {
    const app = await setup(mocks)
    await reply(app, 't1_reply', 't1_offer', 'bob', 'confirmed')

    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('an event for a comment already marked processed is skipped', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: MONTHLY, authorName: 'bob', body: 'confirmed' })
    await app.ctx.redis.set('processed:t1_reply', '1')

    await app.fireTrigger('CommentSubmit', eventFor({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, 'bob'))

    await expectNoTradeRecorded(app)
    expect(app.reddit.repliesTo('t1_reply')).toEqual([])
  })
})
