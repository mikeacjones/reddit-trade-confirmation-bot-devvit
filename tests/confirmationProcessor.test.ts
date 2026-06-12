import { describe, expect, it, vi } from 'vitest'
import { evaluateQueuedConfirmation } from '../src/confirmationProcessor.js'
import type { ConfirmationWorkItem } from '../src/workQueue.js'

const workItem: ConfirmationWorkItem = {
  workId: 'confirmation-comment:t1_confirm',
  kind: 'confirmation-comment',
  commentId: 't1_confirm',
  postId: 't3_post',
  subredditName: 'PlasticModelExchange',
  enqueuedAt: '2026-06-11T12:00:00.000Z',
  status: 'queued',
  attempts: 0,
  nextAttemptAt: Date.parse('2026-06-11T12:00:00.000Z'),
}

function mockContext() {
  const getCommentById = vi.fn(async (id: string) => {
    if (id === 't1_confirm') {
      return {
        id: 't1_confirm',
        body: 'Confirmed',
        authorName: 'buyer',
        parentId: 't1_parent',
        postId: 't3_post',
        removed: false,
      }
    }
    return {
      id: 't1_parent',
      body: 'sold to u/buyer',
      authorName: 'seller',
      parentId: 't3_post',
      postId: 't3_post',
      removed: false,
    }
  })
  const getPostById = vi.fn(async () => ({
    id: 't3_post',
    authorId: 't2_bot',
    locked: false,
  }))
  const getAppUser = vi.fn(async () => ({ id: 't2_bot' }))
  const redis = {
    get: vi.fn(async (key: string) => key === 'currentMonthlyPost' ? 't3_post' : undefined),
  }
  const getSetting = vi.fn(async (_name: string) => undefined as string | undefined)
  const settings = {
    get: async <T,>(name: string): Promise<T | undefined> =>
      getSetting(name) as Promise<T | undefined>,
  }
  return {
    ctx: {
      reddit: { getCommentById, getPostById, getAppUser },
      redis,
      settings,
    },
    getCommentById,
    getPostById,
    getAppUser,
    redis,
    settings: { get: getSetting },
  }
}

describe('evaluateQueuedConfirmation', () => {
  it('loads queued comment facts and returns a confirmation candidate', async () => {
    const { ctx, getCommentById, getPostById, getAppUser, redis } = mockContext()

    await expect(evaluateQueuedConfirmation(ctx, workItem)).resolves.toEqual({
      evaluation: {
        valid: true,
        commentId: 't1_confirm',
        replyToCommentId: 't1_confirm',
        parentCommentId: 't1_parent',
        parentAuthor: 'seller',
        confirmer: 'buyer',
        postId: 't3_post',
      },
      botUsername: undefined,
      commentAuthor: 'buyer',
      parentAuthor: 'seller',
    })

    expect(getCommentById).toHaveBeenCalledWith('t1_confirm')
    expect(getCommentById).toHaveBeenCalledWith('t1_parent')
    expect(getPostById).toHaveBeenCalledWith('t3_post')
    expect(getAppUser).toHaveBeenCalledOnce()
    expect(redis.get).toHaveBeenCalledWith('currentMonthlyPost')
  })

  it('fails as retryable work when the current confirmation post is not set', async () => {
    const { ctx, redis } = mockContext()
    redis.get.mockResolvedValueOnce(undefined)

    await expect(evaluateQueuedConfirmation(ctx, workItem))
      .rejects.toThrow('Current confirmation post is not set')
  })

  it('uses the configured confirmation keyword', async () => {
    const { ctx, getCommentById, settings } = mockContext()
    settings.get.mockImplementation(async (name: string) =>
      name === 'confirmation_keyword' ? 'completed' : undefined)
    getCommentById.mockImplementation(async (id: string) => {
      if (id === 't1_confirm') {
        return {
          id: 't1_confirm',
          body: 'Completed, thank you',
          authorName: 'buyer',
          parentId: 't1_parent',
          postId: 't3_post',
          removed: false,
        }
      }
      return {
        id: 't1_parent',
        body: 'sold to u/buyer',
        authorName: 'seller',
        parentId: 't3_post',
        postId: 't3_post',
        removed: false,
      }
    })

    await expect(evaluateQueuedConfirmation(ctx, workItem))
      .resolves.toEqual(expect.objectContaining({
        evaluation: expect.objectContaining({ valid: true }),
      }))
  })
})
