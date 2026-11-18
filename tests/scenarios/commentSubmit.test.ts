import { describe, expect } from 'vitest'
import { newApp, scenarioTest as test, seedSwapsWorld } from '../harness/scenario.js'

function confirmationEvent(comment: { id: string; body: string; parentId: string }, author: string) {
  return {
    comment: { ...comment, postId: 't3_monthly', permalink: `/r/swaps/comments/monthly/_/${comment.id}/` },
    author: { name: author },
    subreddit: { name: 'swaps' },
  }
}

describe('CommentSubmit trigger (registered in src/main.ts)', () => {
  test('a valid confirmation updates both traders and replies', async ({ mocks }) => {
    const app = newApp(mocks)
    const { monthlyPostId } = seedSwapsWorld(app)
    const { reddit } = app
    await app.ctx.redis.set('currentMonthlyPost', monthlyPostId)
    reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'Sold a kit to u/bob' })
    reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: monthlyPostId, authorName: 'bob', body: 'confirmed' })

    await app.fireTrigger('CommentSubmit', confirmationEvent({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, 'bob'))

    // Redis: counts, the claim on the parent comment, and the processed marker.
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(JSON.parse((await app.ctx.redis.get('confirmed:t1_offer'))!)).toMatchObject({
      commentId: 't1_reply',
      parentAuthor: 'alice',
      confirmer: 'bob',
      parentCount: 1,
      confirmerCount: 1,
    })
    expect(await app.ctx.redis.get('processed:t1_reply')).toBe('1')
    expect(await app.ctx.redis.get('processing:t1_reply')).toBeUndefined()

    // Reddit fake: both users got the 0-99 flair and the bot replied under the confirming comment.
    expect(reddit.flairOf('alice')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    expect(reddit.flairOf('bob')).toEqual({ text: 'Trades: 1', flairTemplateId: 'tpl-0' })
    const replies = reddit.repliesTo('t1_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0].authorName).toBe('swapbot')
    expect(replies[0].body).toContain('alice')
    expect(replies[0].body).toContain('bob')
  })

  test('delivering the same event twice counts the trade once', async ({ mocks }) => {
    const app = newApp(mocks)
    const { monthlyPostId } = seedSwapsWorld(app)
    const { reddit } = app
    await app.ctx.redis.set('currentMonthlyPost', monthlyPostId)
    reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'Sold a kit to u/bob' })
    reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: monthlyPostId, authorName: 'bob', body: 'confirmed' })
    const event = confirmationEvent({ id: 't1_reply', body: 'confirmed', parentId: 't1_offer' }, 'bob')

    await app.fireTrigger('CommentSubmit', event)
    await app.fireTrigger('CommentSubmit', event)

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('a self-confirmation is rejected and nobody is counted', async ({ mocks }) => {
    const app = newApp(mocks)
    const { monthlyPostId } = seedSwapsWorld(app)
    const { reddit } = app
    await app.ctx.redis.set('currentMonthlyPost', monthlyPostId)
    reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'Sold a kit to u/alice' })
    reddit.addComment({ id: 't1_self', parentId: 't1_offer', postId: monthlyPostId, authorName: 'alice', body: 'confirmed' })

    await app.fireTrigger('CommentSubmit', confirmationEvent({ id: 't1_self', body: 'confirmed', parentId: 't1_offer' }, 'alice'))

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
    expect(reddit.flairOf('alice')).toBeUndefined()
  })

  test('a reply from someone the trade comment did not tag gets the cant-confirm reply', async ({ mocks }) => {
    const app = newApp(mocks)
    const { monthlyPostId } = seedSwapsWorld(app)
    const { reddit } = app
    await app.ctx.redis.set('currentMonthlyPost', monthlyPostId)
    reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'Sold a kit to u/bob' })
    reddit.addComment({ id: 't1_other', parentId: 't1_offer', postId: monthlyPostId, authorName: 'carol', body: 'confirmed' })

    await app.fireTrigger('CommentSubmit', confirmationEvent({ id: 't1_other', body: 'confirmed', parentId: 't1_offer' }, 'carol'))

    expect(await app.ctx.redis.get('confirmed:t1_offer')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    const replies = reddit.repliesTo('t1_other')
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toContain('your username was not specified')
  })
})
