import { describe, expect, it } from 'vitest'
import { FakeReddit } from './redditFake.js'

describe('FakeReddit', () => {
  it('keeps state across calls: comments, replies and flair', async () => {
    const reddit = new FakeReddit({ subredditName: 'swaps' })
    const post = reddit.addPost({ title: 'Thread' })
    const root = reddit.addComment({ parentId: post.id, postId: post.id, authorName: 'alice', body: 'hello' })

    const reply = await reddit.client.submitComment({ id: root.id, text: 'hi back' })
    await reddit.client.setUserFlair({ subredditName: 'swaps', username: 'Alice', text: 'Trades: 1' })

    expect(reply.authorName).toBe('swapbot')
    expect(reddit.repliesTo(root.id).map(c => c.body)).toEqual(['hi back'])
    expect((await (await reddit.client.getCommentById(root.id)).replies.all()).map(c => c.id)).toEqual([reply.id])
    expect(reddit.flairOf('alice')?.text).toBe('Trades: 1')
  })

  it('rejects unknown ids with a 404-style error like Reddit does', async () => {
    const reddit = new FakeReddit({ subredditName: 'swaps' })
    await expect(reddit.client.getCommentById('t1_missing')).rejects.toThrow(/404/)
    await expect(reddit.client.getPostById('t3_missing')).rejects.toThrow(/404/)
  })

  it('failNext makes the next calls fail, then recovers', async () => {
    const reddit = new FakeReddit({ subredditName: 'swaps' })
    const post = reddit.addPost({ title: 'Thread' })
    reddit.failNext('getPostById', 'RATELIMIT', 2)

    await expect(reddit.client.getPostById(post.id)).rejects.toThrow('RATELIMIT')
    await expect(reddit.client.getPostById(post.id)).rejects.toThrow('RATELIMIT')
    await expect(reddit.client.getPostById(post.id)).resolves.toMatchObject({ id: post.id })
    expect(reddit.calls.filter(c => c.method === 'getPostById')).toHaveLength(3)
  })

  it('post objects reflect later state changes', async () => {
    const reddit = new FakeReddit({ subredditName: 'swaps' })
    const post = reddit.addPost({ title: 'Thread' })
    const handle = await reddit.client.getPostById(post.id)
    await handle.lock()
    expect(handle.locked).toBe(true)
    expect(reddit.posts.get(post.id)?.locked).toBe(true)
  })
})
