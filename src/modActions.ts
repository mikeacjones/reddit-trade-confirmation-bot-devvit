import { systemClock, type Clock } from './clock.js'
import type { Form } from '@devvit/public-api'
import type { FormKey } from '@devvit/shared-types/useForm.js'
import { enqueueCurrentMonthlyPostComments } from './rescan.js'
import { adjustUserTradeCount } from './tradeAdjustments.js'
import {
  confirmationWorkId,
  enqueueManualConfirmation,
  listFailedWorkItems,
  listReadyWorkItems,
  manualConfirmationWorkId,
  nudgeConfirmationWorker,
  retryFailedWorkItem,
  type QueueNudgeContext,
} from './workQueue.js'

const CURRENT_MONTHLY_POST_KEY = 'currentMonthlyPost'

interface MenuActionEvent {
  location: 'subreddit' | 'post' | 'comment'
  targetId: string
}

interface ManualConfirmationContext extends QueueNudgeContext {
  redis: QueueNudgeContext['redis'] & {
    del(...keys: string[]): Promise<unknown>
  }
  reddit: {
    getCommentById(id: string): Promise<{
      id: string
      postId: string
      authorName?: string
    }>
    getCurrentSubredditName(): Promise<string>
    setUserFlair(options: { subredditName: string; username: string; text: string }): Promise<void>
  }
}

interface AdjustTradesFormContext extends ManualConfirmationContext {
  ui: {
    showForm(formKey: FormKey, data?: { commentId: string }): void
    showToast(text: string): void
  }
}

interface RetryFailedWorkContext extends QueueNudgeContext {
  redis: QueueNudgeContext['redis'] & {
    get(key: string): Promise<string | undefined>
    del(...keys: string[]): Promise<unknown>
    zRem(key: string, members: string[]): Promise<number>
  }
}

interface QueueStatusContext {
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<string>
    zAdd(key: string, ...members: { member: string; score: number }[]): Promise<number>
    zRange(
      key: string,
      start: number | string,
      stop: number | string,
      options?: { by: 'score' | 'lex' | 'rank'; limit?: { offset: number; count: number } },
    ): Promise<Array<{ member: string; score: number }>>
  }
  ui: {
    showToast(text: string): void
  }
}

interface RescanMonthlyPostContext extends QueueNudgeContext {
  redis: QueueNudgeContext['redis'] & {
    get(key: string): Promise<string | undefined>
  }
  reddit: {
    getCurrentSubredditName(): Promise<string>
    getComments(options: {
      postId: string
      sort: 'new'
      limit: number
      pageSize: number
    }): { all(): Promise<Array<{ id: string; postId?: string }>> }
  }
  ui: {
    showToast(text: string): void
  }
}

interface CurrentPostContext {
  redis: {
    set(key: string, value: string): Promise<unknown>
  }
  ui: {
    showToast(text: string): void
  }
}

export async function onManualConfirmationMenuAction(
  event: MenuActionEvent,
  ctx: ManualConfirmationContext,
  options: { clock?: Clock } = {},
): Promise<{ enqueued: boolean; workId?: string }> {
  if (event.location !== 'comment') return { enqueued: false }

  const comment = await ctx.reddit.getCommentById(event.targetId)
  const result = await enqueueManualConfirmation(ctx, {
    commentId: comment.id,
    postId: comment.postId,
    subredditName: await ctx.reddit.getCurrentSubredditName(),
  }, options.clock)

  if (result.enqueued) await nudgeConfirmationWorker(ctx, options.clock)
  return { enqueued: result.enqueued, workId: result.workId }
}

export async function onRetryFailedWorkMenuAction(
  event: MenuActionEvent,
  ctx: RetryFailedWorkContext,
  options: { clock?: Clock } = {},
): Promise<{ retried: boolean; workId?: string }> {
  if (event.location !== 'comment') return { retried: false }

  for (const workId of [confirmationWorkId(event.targetId), manualConfirmationWorkId(event.targetId)]) {
    if (await retryFailedWorkItem(ctx, workId, options.clock)) {
      await nudgeConfirmationWorker(ctx, options.clock)
      return { retried: true, workId }
    }
  }
  return { retried: false }
}

export async function onQueueStatusMenuAction(
  ctx: QueueStatusContext,
): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    listReadyWorkItems(ctx),
    listFailedWorkItems(ctx),
  ])
  const failedPreview = failed.length > 0
    ? `. Failed: ${failed.slice(0, 3).map(item => item.commentId).join(', ')}`
    : ''
  ctx.ui.showToast(`Work queue: ${pending.length} pending, ${failed.length} failed${failedPreview}`)
  return { pending: pending.length, failed: failed.length }
}

export async function onRescanMonthlyPostMenuAction(
  ctx: RescanMonthlyPostContext,
  options: { clock?: Clock } = {},
): Promise<{ scanned: number; enqueued: number }> {
  const result = await enqueueCurrentMonthlyPostComments(ctx, options)
  ctx.ui.showToast(`Re-scan: ${result.scanned} comments, ${result.enqueued} enqueued`)
  return result
}

export async function onSetCurrentConfirmationPostMenuAction(
  event: MenuActionEvent,
  ctx: CurrentPostContext,
): Promise<{ updated: boolean; postId?: string }> {
  if (event.location !== 'post') return { updated: false }

  await ctx.redis.set(CURRENT_MONTHLY_POST_KEY, event.targetId)
  ctx.ui.showToast(`Current confirmation post set to ${event.targetId}`)
  return { updated: true, postId: event.targetId }
}

export async function adjustCommentAuthorTradeCount(
  ctx: ManualConfirmationContext,
  input: { commentId: string; count: number },
  clock: Clock,
): Promise<{ username: string; count: number; flairText: string }> {
  const comment = await ctx.reddit.getCommentById(input.commentId)
  if (!comment.authorName) throw new Error(`Comment ${input.commentId} has no author`)
  return adjustUserTradeCount(ctx, {
    subredditName: await ctx.reddit.getCurrentSubredditName(),
    username: comment.authorName,
    count: input.count,
  }, clock)
}

export async function adjustNamedUserTradeCount(
  ctx: ManualConfirmationContext,
  input: { username: string; count: number },
  clock: Clock,
): Promise<{ username: string; count: number; flairText: string }> {
  const username = normalizeUsername(input.username)
  if (!username) throw new Error('Missing username')

  return adjustUserTradeCount(ctx, {
    subredditName: await ctx.reddit.getCurrentSubredditName(),
    username,
    count: input.count,
  }, clock)
}

export function adjustUserTradesForm(data: { commentId?: string } = {}): Form {
  const commentFields: Form['fields'] = data.commentId
    ? [
        {
          type: 'string',
          name: 'commentId',
          label: 'Comment ID',
          defaultValue: data.commentId,
          required: true,
        },
      ]
    : [
        {
          type: 'string',
          name: 'username',
          label: 'Username',
          required: true,
        },
      ]

  return {
    title: data.commentId ? "Adjust comment author's trades" : 'Set user trades',
    acceptLabel: 'Update',
    fields: [
      ...commentFields,
      {
        type: 'number',
        name: 'count',
        label: 'Trades',
        required: true,
      },
    ],
  }
}

export async function showAdjustUserTradesForm(
  event: MenuActionEvent,
  ctx: Pick<AdjustTradesFormContext, 'ui'>,
  formKey: FormKey,
): Promise<void> {
  if (event.location !== 'comment') return
  ctx.ui.showForm(formKey, { commentId: event.targetId })
}

export async function showSetUserTradesForm(
  ctx: Pick<AdjustTradesFormContext, 'ui'>,
  formKey: FormKey,
): Promise<void> {
  ctx.ui.showForm(formKey)
}

export async function onAdjustUserTradesFormSubmit(
  event: { values: { commentId?: string; username?: string; count?: number } },
  ctx: AdjustTradesFormContext,
  options: { clock?: Clock } = {},
): Promise<void> {
  const commentId = event.values.commentId
  const username = event.values.username
  const count = event.values.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new Error('Trade count must be a non-negative integer')
  }

  const result = commentId
    ? await adjustCommentAuthorTradeCount(ctx, { commentId, count }, options.clock ?? systemClock)
    : await adjustNamedUserTradeCount(ctx, { username: username ?? '', count }, options.clock ?? systemClock)
  ctx.ui.showToast(`Updated u/${result.username} to ${result.flairText}`)
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^\/?u\//i, '')
}
