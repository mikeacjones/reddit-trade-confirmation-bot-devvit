import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adjustUserTradeCount,
  approveConfirmationFromComment,
  importExistingFlairCounts,
  onCommentSubmit,
  onMonthlyPost,
} from '../src/handlers'

function mockRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const transactions: Array<{ keys: string[]; commands: Array<{ command: string; key: string }> }> = []
  return {
    store,
    transactions,
    api: {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
        if (options?.nx && store.has(key)) return false
        store.set(key, value)
        return true
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key)
      }),
      watch: vi.fn(async (...keys: string[]) => {
        const commands: Array<{ command: string; key: string; value?: string; options?: { nx?: boolean } }> = []
        let tx: any
        tx = {
          multi: vi.fn(async () => undefined),
          set: vi.fn(async (key: string, value: string, options?: { nx?: boolean }) => {
            commands.push({ command: 'set', key, value, options })
            return tx
          }),
          exec: vi.fn(async () => {
            transactions.push({ keys, commands: commands.map(({ command, key }) => ({ command, key })) })
            return commands.map(command => {
              if (command.command === 'set') {
                if (command.options?.nx && store.has(command.key)) return false
                store.set(command.key, command.value ?? '')
                return true
              }
              return true
            })
          }),
          unwatch: vi.fn(async () => tx),
        }
        return tx
      }),
    },
  }
}

function mockMonthlyContext(
  initial: Record<string, string> = {},
  options: {
    previousPost?: any
    recentPosts?: any[]
  } = {},
) {
  const redis = mockRedis(initial)
  const previousPost = options.previousPost ?? {
    id: 't3_old',
    title: 'April Confirmed Trade Thread',
    permalink: 'https://reddit.test/r/PlasticModelExchange/comments/old',
    stickied: true,
    locked: false,
    removed: false,
    spam: false,
    archived: false,
    unsticky: vi.fn(async () => undefined),
    lock: vi.fn(async () => undefined),
  }
  const newPost = {
    id: 't3_new',
    permalink: 'https://reddit.test/r/PlasticModelExchange/comments/new',
    setSuggestedCommentSort: vi.fn(async () => undefined),
    sticky: vi.fn(async () => undefined),
  }
  const submitPost = vi.fn(async () => newPost)
  const ctx = {
    redis: redis.api,
    settings: {
      get: vi.fn(async () => undefined),
    },
    reddit: {
      getCurrentSubreddit: vi.fn(async () => ({ name: 'PlasticModelExchange' })),
      getPostById: vi.fn(async () => previousPost),
      getAppUser: vi.fn(async () => ({ id: 't2_bot', username: 'swap-conf-bot' })),
      getPostsByUser: vi.fn(() => ({
        all: vi.fn(async () => options.recentPosts ?? []),
      })),
      submitPost,
      modMail: {
        createConversation: vi.fn(async () => undefined),
      },
    },
  }
  return { ctx: ctx as any, redis, previousPost, newPost, submitPost }
}

function mockConfirmationContext(initial: Record<string, string> = {}) {
  const redis = mockRedis({
    currentMonthlyPost: 't3_post',
    'flairTemplates:plasticmodelexchange': JSON.stringify([
      { min: 0, max: 99, id: 'tpl-user', template: 'Trades: 0-99', modOnly: false },
    ]),
    moderators: JSON.stringify({
      usernames: [],
      syncedAt: '2026-05-08T00:00:00.000Z',
    }),
    'confirmations:seller': '4',
    'confirmations:buyer': '2',
    ...initial,
  })
  const setUserFlair = vi.fn(async () => undefined)
  const setUserFlairBatch = vi.fn(async () => [{ ok: true }])
  const submitComment = vi.fn(async () => undefined)
  const ctx = {
    redis: redis.api,
    settings: {
      get: vi.fn(async () => undefined),
    },
    reddit: {
      getCurrentSubreddit: vi.fn(async () => ({ name: 'PlasticModelExchange' })),
      getPostById: vi.fn(async () => ({
        id: 't3_post',
        authorId: 't2_bot',
        locked: false,
      })),
      getAppUser: vi.fn(async () => ({ id: 't2_bot', username: 'swap-conf-bot' })),
      getCommentById: vi.fn(async (id: string) => {
        if (id === 't1_confirm') {
          return {
            id: 't1_confirm',
            parentId: 't1_parent',
            postId: 't3_post',
            subredditName: 'PlasticModelExchange',
            authorName: 'buyer',
            authorFlair: { text: 'Trades: 2' },
            body: 'confirmed',
            permalink: 'https://reddit.test/r/PlasticModelExchange/comments/post/_/confirm',
            removed: false,
          }
        }
        return {
          id: 't1_parent',
          parentId: 't3_post',
          postId: 't3_post',
          subredditName: 'PlasticModelExchange',
          authorName: 'seller',
          authorFlair: { text: 'Trades: 4' },
          body: 'sold to u/buyer',
          permalink: 'https://reddit.test/r/PlasticModelExchange/comments/post/_/parent',
          removed: false,
        }
      }),
      getSubredditByName: vi.fn(async () => ({})),
      setUserFlair,
      setUserFlairBatch,
      submitComment,
    },
  }
  const event = {
    comment: {
      id: 't1_confirm',
      body: 'confirmed',
      parentId: 't1_parent',
      postId: 't3_post',
      permalink: 'https://reddit.test/r/PlasticModelExchange/comments/post/_/confirm',
    },
    author: { name: 'buyer', flair: { text: 'Trades: 2' } },
    subreddit: { name: 'PlasticModelExchange' },
  }
  return { ctx: ctx as any, event: event as any, redis, setUserFlair, submitComment }
}

function mockMigrationContext(initial: Record<string, string> = {}) {
  const redis = mockRedis(initial)
  const getUserFlair = vi.fn(async (options?: { after?: string }) => {
    if (options?.after === 'page2') {
      return {
        users: [
          { user: 'Carol', flairText: 'Trades: 3' },
        ],
      }
    }
    return {
      next: 'page2',
      users: [
        { user: 'Alice', flairText: 'Trades: 99' },
        { user: 'Bob', flairText: 'Trusted | Trades: 12' },
        { user: 'Charlie', flairText: 'No trades here' },
        { user: 'Zero', flairText: 'Trades: 0' },
        { flairText: 'Trades: 5' },
      ],
    }
  })
  const ctx = {
    redis: redis.api,
    reddit: {
      getCurrentSubreddit: vi.fn(async () => ({ name: 'PlasticModelExchange' })),
      getSubredditByName: vi.fn(async () => ({ getUserFlair })),
    },
  }
  return { ctx: ctx as any, redis, getUserFlair }
}

afterEach(() => {
  vi.useRealTimers()
})

function mockContext(options: {
  setUserFlair?: any
  setUserFlairBatch?: any
  moderators?: string[]
}) {
  const subredditName = 'PlasticModelExchange'
  const redis = mockRedis({
    'flairTemplates:plasticmodelexchange': JSON.stringify([
      { min: 0, max: 99, id: 'tpl-user', template: 'Trades: 0-99', modOnly: false },
      { min: 0, max: 99999, id: 'tpl-mod', template: 'Moderator | Trades: 0-99999', modOnly: true },
    ]),
    moderators: JSON.stringify({
      usernames: options.moderators ?? [],
      syncedAt: '2026-05-08T00:00:00.000Z',
    }),
    'confirmations:alice': '4',
  })
  const setUserFlair = options.setUserFlair ?? vi.fn(async () => undefined)
  const setUserFlairBatch = options.setUserFlairBatch ?? vi.fn(async () => [{ ok: true }])
  const ctx = {
    redis: redis.api,
    reddit: {
      getCurrentSubreddit: vi.fn(async () => ({ name: subredditName })),
      getSubredditByName: vi.fn(async () => ({})),
      setUserFlair,
      setUserFlairBatch,
    },
  }
  return { ctx: ctx as any, redis, setUserFlair, setUserFlairBatch }
}

describe('adjustUserTradeCount', () => {
  it('sets Redis count and user flair for a manual adjustment', async () => {
    const { ctx, redis, setUserFlair } = mockContext({})

    const result = await adjustUserTradeCount(ctx, 'u/Alice', 7)

    expect(result).toEqual({
      username: 'Alice',
      count: 7,
      oldFlair: 'Trades: 4',
      newFlair: 'Trades: 7',
    })
    expect(redis.store.get('confirmations:alice')).toBe('7')
    expect(setUserFlair).toHaveBeenCalledWith({
      subredditName: 'PlasticModelExchange',
      username: 'Alice',
      text: 'Trades: 7',
      flairTemplateId: 'tpl-user',
    })
  })

  it('uses the moderator flair template for cached moderators', async () => {
    const { ctx, setUserFlair } = mockContext({ moderators: ['alice'] })

    await adjustUserTradeCount(ctx, '/u/alice', 12)

    expect(setUserFlair).toHaveBeenCalledWith(expect.objectContaining({
      flairTemplateId: 'tpl-mod',
      text: 'Moderator | Trades: 12',
      username: 'alice',
    }))
  })

  it('falls back to flaircsv when template selection cannot find a deleted flair row', async () => {
    const setUserFlair = vi.fn()
      .mockRejectedValueOnce(new Error('http status 404 Not Found'))
      .mockResolvedValueOnce(undefined)
    const { ctx, redis, setUserFlairBatch } = mockContext({
      setUserFlair,
    })

    const result = await adjustUserTradeCount(ctx, 'Alice', 9)

    expect(result).toEqual({
      username: 'Alice',
      count: 9,
      oldFlair: 'Trades: 4',
      newFlair: 'Trades: 9',
    })
    expect(redis.store.get('confirmations:alice')).toBe('9')
    expect(setUserFlair).toHaveBeenCalledTimes(2)
    expect(setUserFlairBatch).toHaveBeenCalledWith('PlasticModelExchange', [expect.objectContaining({
      username: 'Alice',
      text: 'Trades: 9',
    })])
  })

  it('rejects invalid usernames before calling Reddit', async () => {
    const { ctx, setUserFlair, setUserFlairBatch } = mockContext({})

    await expect(adjustUserTradeCount(ctx, 'not a username', 8)).rejects.toThrow('Username must be 3-20 characters')

    expect(ctx.reddit.getCurrentSubreddit).not.toHaveBeenCalled()
    expect(setUserFlair).not.toHaveBeenCalled()
    expect(setUserFlairBatch).not.toHaveBeenCalled()
  })

  it('rolls back the Redis count when Reddit rejects the flair write', async () => {
    const { ctx, redis } = mockContext({
      setUserFlair: vi.fn(async () => {
        throw new Error('reddit write failed')
      }),
    })

    await expect(adjustUserTradeCount(ctx, 'Alice', 8)).rejects.toThrow('reddit write failed')

    expect(redis.store.get('confirmations:alice')).toBe('4')
  })

  it('rolls back the Redis count when the flaircsv fallback rejects the user', async () => {
    const { ctx, redis } = mockContext({
      setUserFlair: vi.fn(async () => {
        throw new Error('http status 404 Not Found')
      }),
      setUserFlairBatch: vi.fn(async () => [{
        ok: false,
        errors: { user: 'not found' },
      }]),
    })

    await expect(adjustUserTradeCount(ctx, 'Alice', 8)).rejects.toThrow('flaircsv failed for u/Alice')

    expect(redis.store.get('confirmations:alice')).toBe('4')
  })
})

describe('onMonthlyPost', () => {
  it('creates a new monthly post and locks the previous monthly post', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)))
    const { ctx, redis, previousPost, newPost, submitPost } = mockMonthlyContext({
      currentMonthlyPost: 't3_old',
    })

    await onMonthlyPost(undefined as any, ctx)

    expect(submitPost).toHaveBeenCalledOnce()
    expect(previousPost.unsticky).toHaveBeenCalledOnce()
    expect(previousPost.lock).toHaveBeenCalledOnce()
    expect(newPost.setSuggestedCommentSort).toHaveBeenCalledWith('NEW')
    expect(newPost.sticky).toHaveBeenCalledOnce()
    expect(redis.store.get('currentMonthlyPost')).toBe('t3_new')
  })

  it('does not submit when another monthly-post invocation owns the claim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)))
    const { ctx, submitPost } = mockMonthlyContext({
      'monthlyPostClaim:plasticmodelexchange:2026-05': '1',
    })

    await onMonthlyPost(undefined as any, ctx)

    expect(submitPost).not.toHaveBeenCalled()
  })

  it('creates a replacement when an existing monthly post cannot be restickied', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)))
    const stalePost = {
      id: 't3_deleted',
      title: 'May 2026 Confirmed Trade Thread',
      subredditName: 'PlasticModelExchange',
      createdAt: new Date(Date.UTC(2026, 4, 1, 0, 0, 0)),
      permalink: 'https://reddit.test/r/PlasticModelExchange/comments/deleted',
      stickied: false,
      locked: false,
      removed: false,
      spam: false,
      archived: false,
      sticky: vi.fn(async () => {
        throw new Error('http status 400 Bad Request')
      }),
      unsticky: vi.fn(async () => undefined),
      lock: vi.fn(async () => {
        throw new Error('http status 400 Bad Request')
      }),
    }
    const { ctx, redis, newPost, submitPost } = mockMonthlyContext(
      { currentMonthlyPost: 't3_deleted' },
      { previousPost: stalePost, recentPosts: [stalePost] },
    )

    await onMonthlyPost(undefined as any, ctx)

    expect(stalePost.sticky).toHaveBeenCalledOnce()
    expect(submitPost).toHaveBeenCalledOnce()
    expect(newPost.sticky).toHaveBeenCalledOnce()
    expect(redis.store.get('currentMonthlyPost')).toBe('t3_new')
  })
})

describe('importExistingFlairCounts', () => {
  it('imports parseable flair counts without overwriting existing Redis counts', async () => {
    const { ctx, redis, getUserFlair } = mockMigrationContext({
      'confirmations:alice': '4',
    })

    const result = await importExistingFlairCounts(ctx)

    expect(result).toEqual(expect.objectContaining({
      pages: 2,
      scanned: 6,
      imported: 3,
      skippedExisting: 1,
      skippedUnparseable: 2,
    }))
    expect(redis.store.get('confirmations:alice')).toBe('4')
    expect(redis.store.get('confirmations:bob')).toBe('12')
    expect(redis.store.get('confirmations:carol')).toBe('3')
    expect(redis.store.get('confirmations:zero')).toBe('0')
    expect(redis.store.get('flairImport:plasticmodelexchange:lastRun')).toContain('"imported":3')
    expect(getUserFlair).toHaveBeenCalledTimes(2)
  })

  it('does not scan when another import owns the claim', async () => {
    const { ctx, getUserFlair } = mockMigrationContext({
      'flairImport:plasticmodelexchange:claim': '1',
    })

    const result = await importExistingFlairCounts(ctx)

    expect(result.alreadyRunning).toBe(true)
    expect(getUserFlair).not.toHaveBeenCalled()
  })
})

describe('onCommentSubmit', () => {
  it('commits the parent claim and both counts in one Redis transaction', async () => {
    const { ctx, event, redis, setUserFlair, submitComment } = mockConfirmationContext()

    await onCommentSubmit(event, ctx)

    const record = JSON.parse(redis.store.get('confirmed:t1_parent') ?? '{}')
    expect(record).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      parentCount: 5,
      confirmerCount: 3,
    }))
    expect(redis.store.get('confirmations:seller')).toBe('5')
    expect(redis.store.get('confirmations:buyer')).toBe('3')
    expect(redis.transactions).toContainEqual({
      keys: ['confirmed:t1_parent', 'confirmations:seller', 'confirmations:buyer'],
      commands: [
        { command: 'set', key: 'confirmed:t1_parent' },
        { command: 'set', key: 'confirmations:seller' },
        { command: 'set', key: 'confirmations:buyer' },
      ],
    })
    expect(setUserFlair).toHaveBeenCalledTimes(2)
    expect(submitComment).toHaveBeenCalledOnce()
  })

  it('does not change counts when the parent claim already exists', async () => {
    const { ctx, event, redis, setUserFlair } = mockConfirmationContext({
      'confirmed:t1_parent': JSON.stringify({
        commentId: 't1_other',
        parentAuthor: 'seller',
        confirmer: 'buyer',
        parentCount: 5,
        confirmerCount: 3,
        createdAt: '2026-05-08T00:00:00.000Z',
      }),
      'confirmations:seller': '5',
      'confirmations:buyer': '3',
    })

    await onCommentSubmit(event, ctx)

    expect(redis.store.get('confirmations:seller')).toBe('5')
    expect(redis.store.get('confirmations:buyer')).toBe('3')
    expect(setUserFlair).not.toHaveBeenCalled()
  })
})

describe('approveConfirmationFromComment', () => {
  it('manually approves a selected confirmation comment', async () => {
    const { ctx, redis, setUserFlair, submitComment } = mockConfirmationContext()

    const result = await approveConfirmationFromComment(ctx, 't1_confirm')

    expect(result).toEqual(expect.objectContaining({
      approved: true,
      parentAuthor: 'seller',
      confirmer: 'buyer',
      parentCommentId: 't1_parent',
    }))
    const record = JSON.parse(redis.store.get('confirmed:t1_parent') ?? '{}')
    expect(record).toEqual(expect.objectContaining({
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      modApproval: true,
      parentCount: 5,
      confirmerCount: 3,
    }))
    expect(redis.store.get('confirmations:seller')).toBe('5')
    expect(redis.store.get('confirmations:buyer')).toBe('3')
    expect(setUserFlair).toHaveBeenCalledTimes(2)
    expect(submitComment).toHaveBeenCalledWith(expect.objectContaining({
      id: 't1_confirm',
    }))
  })

  it('does not approve a top-level comment', async () => {
    const { ctx, redis, setUserFlair, submitComment } = mockConfirmationContext()

    const result = await approveConfirmationFromComment(ctx, 't1_parent')

    expect(result.approved).toBe(false)
    expect(result.message).toContain('top-level comment')
    expect(redis.store.get('confirmed:t1_parent')).toBeUndefined()
    expect(redis.store.get('confirmations:seller')).toBe('4')
    expect(redis.store.get('confirmations:buyer')).toBe('2')
    expect(setUserFlair).not.toHaveBeenCalled()
    expect(submitComment).not.toHaveBeenCalled()
  })
})
