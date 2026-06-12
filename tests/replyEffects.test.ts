import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import type { Clock } from '../src/clock.js'
import type { ConfirmationClaimRecord } from '../src/confirmationState.js'
import {
  applyRejectionReplyEffect,
  applyReplyEffect,
  renderConfirmationReply,
} from '../src/replyEffects.js'

function fixedClock(value = '2026-06-11T12:00:00.000Z'): Clock {
  const now = new Date(value)
  return { now: () => new Date(now) }
}

function mockSettings(values: Record<string, string>) {
  const getSetting = vi.fn(async (name: string) => values[name])
  return {
    settings: {
      get: async <T,>(name: string): Promise<T | undefined> =>
        getSetting(name) as Promise<T | undefined>,
    },
    getSetting,
  }
}

function claim(): ConfirmationClaimRecord {
  return {
    commentId: 't1_confirm',
    replyToCommentId: 't1_confirm',
    parentCommentId: 't1_parent',
    subredditName: 'PlasticModelExchange',
    parentAuthor: 'seller',
    confirmer: 'buyer',
    modApproval: false,
    postId: 't3_post',
    parentPreviousCount: 4,
    parentCount: 5,
    confirmerPreviousCount: 2,
    confirmerCount: 3,
    effects: {
      parentFlair: { status: 'applied', at: '2026-06-11T12:00:00.000Z' },
      confirmerFlair: { status: 'applied', at: '2026-06-11T12:00:00.000Z' },
      reply: { status: 'pending' },
    },
    createdAt: '2026-06-11T11:59:00.000Z',
    updatedAt: '2026-06-11T12:00:00.000Z',
  }
}

describe('renderConfirmationReply', () => {
  it('renders the immutable count transition for this confirmation', () => {
    expect(renderConfirmationReply(claim())).toContain(
      '[`u/buyer`](https://reddit.com/u/buyer) updated from `Trades: 2` to `Trades: 3`',
    )
    expect(renderConfirmationReply(claim())).toContain(
      '[`u/seller`](https://reddit.com/u/seller) updated from `Trades: 4` to `Trades: 5`',
    )
  })

  it('renders missing prior counts as zero instead of unknown', () => {
    const record: ConfirmationClaimRecord = {
      ...claim(),
      confirmerPreviousCount: 0,
      confirmerCount: 1,
    }

    expect(renderConfirmationReply(record)).toContain(
      '[`u/buyer`](https://reddit.com/u/buyer) updated from `Trades: 0` to `Trades: 1`',
    )
    expect(renderConfirmationReply(record)).not.toContain('unknown')
  })
})

describe('applyReplyEffect', () => {
  it('uses configured reply template and flair label', async () => {
    const record = claim()
    const store = new Map<string, string>([
      ['confirmed:t1_parent', JSON.stringify(record)],
    ])
    const settings = mockSettings({
      trade_confirmation: '{confirmer}: {old_comment_flair} -> {new_comment_flair}',
      flair_count_label: 'Deals:',
    })
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      settings: settings.settings,
      reddit: {
        getComments: vi.fn(async () => []),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    await applyReplyEffect(ctx, record, fixedClock())

    expect(ctx.reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: [
        'buyer: Deals: 2 -> Deals: 3',
        '',
        'Confirmation ID: t1_parent',
      ].join('\n'),
    })
  })

  it('posts the reply and marks the effect posted', async () => {
    const record = claim()
    const store = new Map<string, string>([
      ['confirmed:t1_parent', JSON.stringify(record)],
    ])
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      reddit: {
        getComments: vi.fn(async () => []),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    const result = await applyReplyEffect(ctx, record, fixedClock())

    expect(result).toEqual({
      status: 'posted',
      at: '2026-06-11T12:00:00.000Z',
      replyId: 't1_bot_reply',
    })
    expect(ctx.reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: renderConfirmationReply(record),
    })
    expect(JSON.parse(store.get('confirmed:t1_parent') ?? '{}')).toEqual(expect.objectContaining({
      effects: expect.objectContaining({
        reply: {
          status: 'posted',
          at: '2026-06-11T12:00:00.000Z',
          replyId: 't1_bot_reply',
        },
      }),
    }))
  })

  it('marks posted without submitting when a bot reply already has the marker', async () => {
    const record = claim()
    const store = new Map<string, string>([
      ['confirmed:t1_parent', JSON.stringify(record)],
    ])
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      reddit: {
        getComments: vi.fn(async () => [
          {
            id: 't1_existing_reply',
            authorName: 'swap-conf-bot',
            body: 'Done\n\nConfirmation ID: t1_parent',
          },
        ]),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    const result = await applyReplyEffect(ctx, record, fixedClock(), {
      botUsername: 'swap-conf-bot',
    })

    expect(result).toEqual({
      status: 'posted',
      at: '2026-06-11T12:00:00.000Z',
      replyId: 't1_existing_reply',
    })
    expect(ctx.reddit.getComments).toHaveBeenCalledWith({
      postId: 't3_post',
      commentId: 't1_confirm',
    })
    expect(ctx.reddit.submitComment).not.toHaveBeenCalled()
  })

  it('uses the marker for dedupe even when the bot username is unavailable', async () => {
    const record = claim()
    const store = new Map<string, string>([
      ['confirmed:t1_parent', JSON.stringify(record)],
    ])
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      reddit: {
        getComments: vi.fn(async () => [
          {
            id: 't1_existing_reply',
            body: 'Done\n\nConfirmation ID: t1_parent',
          },
        ]),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    const result = await applyReplyEffect(ctx, record, fixedClock())

    expect(result).toEqual({
      status: 'posted',
      at: '2026-06-11T12:00:00.000Z',
      replyId: 't1_existing_reply',
    })
    expect(ctx.reddit.submitComment).not.toHaveBeenCalled()
  })

  it('returns without reading or submitting when the reply effect is already posted', async () => {
    const record: ConfirmationClaimRecord = {
      ...claim(),
      effects: {
        ...claim().effects,
        reply: { status: 'posted', at: '2026-06-11T11:59:00.000Z', replyId: 't1_existing_reply' },
      },
    }
    const store = new Map<string, string>([
      ['confirmed:t1_parent', JSON.stringify(record)],
    ])
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      reddit: {
        getComments: vi.fn(async () => []),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    const result = await applyReplyEffect(ctx, record, fixedClock(), {
      botUsername: 'swap-conf-bot',
    })

    expect(result).toEqual({ status: 'posted', at: '2026-06-11T11:59:00.000Z', replyId: 't1_existing_reply' })
    expect(ctx.reddit.getComments).not.toHaveBeenCalled()
    expect(ctx.reddit.submitComment).not.toHaveBeenCalled()
    expect(ctx.redis.set).not.toHaveBeenCalled()
  })

  it('returns without reading or submitting when the rejection reply is already posted', async () => {
    const record = {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      reason: 'same_user',
      effects: {
        reply: { status: 'posted', at: '2026-06-11T11:59:00.000Z', replyId: 't1_existing_reply' },
      },
      createdAt: '2026-06-11T11:58:00.000Z',
      updatedAt: '2026-06-11T11:59:00.000Z',
    }
    const store = new Map<string, string>([
      ['rejected:t1_confirm', JSON.stringify(record)],
    ])
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      reddit: {
        getComments: vi.fn(async () => []),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    const result = await applyRejectionReplyEffect(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      reason: 'same_user',
    }, fixedClock(), { botUsername: 'swap-conf-bot' })

    expect(result).toEqual({ status: 'posted', at: '2026-06-11T11:59:00.000Z', replyId: 't1_existing_reply' })
    expect(ctx.reddit.getComments).not.toHaveBeenCalled()
    expect(ctx.reddit.submitComment).not.toHaveBeenCalled()
    expect(ctx.redis.set).not.toHaveBeenCalled()
  })

  it('uses configured rejection messages', async () => {
    const store = new Map<string, string>()
    const settings = mockSettings({
      old_confirmation_thread: 'Use the new monthly thread.',
    })
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      settings: settings.settings,
      reddit: {
        getComments: vi.fn(async () => []),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    await applyRejectionReplyEffect(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      reason: 'old_thread',
    }, fixedClock())

    expect(ctx.reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: [
        'Use the new monthly thread.',
        '',
        'Rejection ID: t1_confirm',
      ].join('\n'),
    })
  })

  it('uses the configured missing-username rejection message', async () => {
    const store = new Map<string, string>()
    const settings = mockSettings({
      cant_confirm_username: 'u/{parent_author} must mention u/{author_name}.',
    })
    const ctx = {
      redis: {
        get: vi.fn(async (key: string) => store.get(key)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value)
          return 'OK'
        }),
      },
      settings: settings.settings,
      reddit: {
        getComments: vi.fn(async () => []),
        submitComment: vi.fn(async () => ({ id: 't1_bot_reply' })),
      },
    }

    await applyRejectionReplyEffect(ctx, {
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      postId: 't3_post',
      subredditName: 'PlasticModelExchange',
      reason: 'cant_confirm_username',
      authorName: 'buyer',
      parentAuthor: 'seller',
    }, fixedClock())

    expect(ctx.reddit.submitComment).toHaveBeenCalledWith({
      id: 't1_confirm',
      text: [
        'u/seller must mention u/buyer.',
        '',
        'Rejection ID: t1_confirm',
      ].join('\n'),
    })
  })
})
