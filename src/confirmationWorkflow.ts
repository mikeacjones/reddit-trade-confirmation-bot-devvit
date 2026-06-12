import { systemClock, type Clock } from './clock.js'
import { commitConfirmationClaim, type ConfirmationClaimRecord } from './confirmationState.js'
import { evaluateQueuedConfirmation } from './confirmationProcessor.js'
import type { ConfirmationEvaluation } from './confirmationRules.js'
import { applyFlairEffect } from './flairEffects.js'
import { applyRejectionReplyEffect, applyReplyEffect, shouldReplyToRejection } from './replyEffects.js'
import { MANUAL_CONFIRMATION_WORK_KIND, type ConfirmationWorkItem } from './workQueue.js'

type WorkflowReplyComment = {
  id: string
  authorName?: string
  body?: string
}

type WorkflowReplyCommentListResult =
  | WorkflowReplyComment[]
  | Promise<WorkflowReplyComment[]>
  | { all(): Promise<WorkflowReplyComment[]> }

export interface ConfirmationWorkflowContext {
  reddit: {
    getCommentById(id: string): Promise<{
      id: string
      body?: string
      authorName?: string
      parentId: string
      postId: string
      removed?: boolean
    }>
    getPostById(id: string): Promise<{
      id: string
      authorId?: string
      locked?: boolean
    }>
    getAppUser(): Promise<{ id: string; username?: string }>
    getUserByUsername(username: string): Promise<{
      getUserFlairBySubreddit(subredditName: string): Promise<{ flairText?: string } | undefined>
    } | undefined>
    setUserFlair(options: { subredditName: string; username: string; text: string }): Promise<void>
    getComments?(options: { postId: string; commentId: string }): WorkflowReplyCommentListResult
    submitComment(options: { id: string; text: string }): Promise<{ id?: string } | void>
  }
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<unknown>
    del(...keys: string[]): Promise<unknown>
    watch(...keys: string[]): Promise<{
      multi(): Promise<void>
      set(key: string, value: string, options?: { nx?: boolean }): Promise<unknown>
      exec(): Promise<unknown[] | null>
      unwatch(): Promise<unknown>
    }>
  }
}

export type ProcessConfirmationItemResult =
  | { status: 'committed'; record: ConfirmationClaimRecord }
  | { status: 'already_claimed' }
  | { status: 'rejected'; evaluation: ConfirmationEvaluation }

export async function processConfirmationItem(
  ctx: ConfirmationWorkflowContext,
  item: ConfirmationWorkItem,
  options: { clock?: Clock } = {},
): Promise<ProcessConfirmationItemResult> {
  const queued = await evaluateQueuedConfirmation(ctx, item)
  const { evaluation } = queued
  const clock = options.clock ?? systemClock
  if (!evaluation.valid) {
    if (shouldReplyToRejection(evaluation.reason)) {
      await applyRejectionReplyEffect(ctx, {
        commentId: item.commentId,
        replyToCommentId: item.commentId,
        postId: item.postId,
        subredditName: item.subredditName,
        reason: evaluation.reason,
        authorName: queued.commentAuthor,
        parentAuthor: queued.parentAuthor,
      }, clock, { botUsername: queued.botUsername })
    }
    return { status: 'rejected', evaluation }
  }

  const commit = await commitConfirmationClaim(ctx, {
    commentId: evaluation.commentId,
    replyToCommentId: evaluation.replyToCommentId,
    parentCommentId: evaluation.parentCommentId,
    subredditName: item.subredditName,
    parentAuthor: evaluation.parentAuthor,
    confirmer: evaluation.confirmer,
    postId: evaluation.postId,
    modApproval: item.kind === MANUAL_CONFIRMATION_WORK_KIND,
  }, options.clock)

  if (!commit.committed) {
    await applyRejectionReplyEffect(ctx, {
      commentId: item.commentId,
      replyToCommentId: item.commentId,
      postId: item.postId,
      subredditName: item.subredditName,
      reason: 'already_claimed',
      authorName: queued.commentAuthor,
      parentAuthor: queued.parentAuthor,
    }, clock, { botUsername: queued.botUsername })
    return { status: 'already_claimed' }
  }

  await applyFlairEffect(ctx, commit.record, 'parentFlair', clock)
  await applyFlairEffect(ctx, commit.record, 'confirmerFlair', clock)
  await applyReplyEffect(ctx, await reloadClaimRecord(ctx, commit.record), clock, {
    botUsername: queued.botUsername,
  })

  return { status: 'committed', record: await reloadClaimRecord(ctx, commit.record) }
}

export async function cleanupTerminalConfirmationState(
  ctx: Pick<ConfirmationWorkflowContext, 'redis'>,
  item: ConfirmationWorkItem,
  result: ProcessConfirmationItemResult,
  clock: Clock,
): Promise<void> {
  if (result.status === 'committed') {
    await ctx.redis.set(`confirmed:${result.record.parentCommentId}`, JSON.stringify({
      commentId: result.record.commentId,
      parentCommentId: result.record.parentCommentId,
      postId: result.record.postId,
      subredditName: result.record.subredditName,
      confirmedAt: clock.now().toISOString(),
    }))
    return
  }

  await ctx.redis.del(`rejected:${item.commentId}`)
}

async function reloadClaimRecord(
  ctx: ConfirmationWorkflowContext,
  fallback: ConfirmationClaimRecord,
): Promise<ConfirmationClaimRecord> {
  const value = await ctx.redis.get(`confirmed:${fallback.parentCommentId}`)
  return value ? JSON.parse(value) as ConfirmationClaimRecord : fallback
}
