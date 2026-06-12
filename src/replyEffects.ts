import type { Clock } from './clock.js'
import {
  updateConfirmationEffect,
  type ConfirmationClaimRecord,
  type EffectState,
} from './confirmationState.js'
import type { ConfirmationRejectionReason } from './confirmationRules.js'
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  renderTemplate,
  tradeFlairText,
  type AppSettings,
} from './settings.js'

type ReplyComment = {
  id: string
  authorName?: string
  body?: string
}

type ReplyCommentListing = {
  all(): Promise<ReplyComment[]>
}

type ReplyCommentListResult = ReplyComment[] | Promise<ReplyComment[]> | ReplyCommentListing
export type RejectionReplyReason = ConfirmationRejectionReason | 'already_claimed'

interface ReplyEffectContext {
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string, options?: { nx?: boolean }): Promise<unknown>
  }
  settings?: {
    get<T>(name: string): Promise<T | undefined>
  }
  reddit: {
    getComments?(options: { postId: string; commentId: string }): ReplyCommentListResult
    submitComment(options: { id: string; text: string }): Promise<{ id?: string } | void>
  }
}

export interface RejectionReplyInput {
  commentId: string
  replyToCommentId: string
  postId: string
  subredditName: string
  reason: RejectionReplyReason
  authorName?: string
  parentAuthor?: string
}

export interface RejectionReplyRecord extends RejectionReplyInput {
  effects: {
    reply: EffectState
  }
  createdAt: string
  updatedAt: string
}

export async function applyReplyEffect(
  ctx: ReplyEffectContext,
  record: ConfirmationClaimRecord,
  clock: Clock,
  options: { botUsername?: string } = {},
): Promise<EffectState> {
  if (record.effects.reply.status === 'posted') return record.effects.reply

  const existingReplyId = await findExistingReplyId(
    ctx,
    record.postId,
    record.replyToCommentId,
    confirmationReplyMarker(record),
    options.botUsername,
  )
  if (existingReplyId) {
    const effect: EffectState = {
      status: 'posted',
      at: clock.now().toISOString(),
      replyId: existingReplyId,
    }
    await updateConfirmationEffect(ctx, record.parentCommentId, 'reply', effect, clock)
    return effect
  }

  const reply = await ctx.reddit.submitComment({
    id: record.replyToCommentId,
    text: renderConfirmationReply(record, await getAppSettings(ctx)),
  })
  const effect: EffectState = {
    status: 'posted',
    at: clock.now().toISOString(),
    replyId: reply?.id,
  }
  await updateConfirmationEffect(ctx, record.parentCommentId, 'reply', effect, clock)
  return effect
}

export async function applyRejectionReplyEffect(
  ctx: ReplyEffectContext,
  input: RejectionReplyInput,
  clock: Clock,
  options: { botUsername?: string } = {},
): Promise<EffectState> {
  const record = await getOrCreateRejectionRecord(ctx, input, clock)
  if (record.effects.reply.status === 'posted') return record.effects.reply

  const existingReplyId = await findExistingReplyId(
    ctx,
    record.postId,
    record.replyToCommentId,
    rejectionReplyMarker(record),
    options.botUsername,
  )
  const effect: EffectState = {
    status: 'posted',
    at: clock.now().toISOString(),
    replyId: existingReplyId ?? (await ctx.reddit.submitComment({
      id: record.replyToCommentId,
      text: renderRejectionReply(record, await getAppSettings(ctx)),
    }))?.id,
  }
  await updateRejectionReplyEffect(ctx, record.commentId, effect, clock)
  return effect
}

async function findExistingReplyId(
  ctx: ReplyEffectContext,
  postId: string,
  commentId: string,
  marker: string,
  botUsername: string | undefined,
): Promise<string | null> {
  if (!ctx.reddit.getComments) return null
  const replies = await readReplyComments(ctx.reddit.getComments({
    postId,
    commentId,
  }))
  const existing = replies.find(reply =>
    reply.body?.includes(marker) &&
    (!botUsername || reply.authorName?.toLowerCase() === botUsername.toLowerCase()))
  return existing?.id ?? null
}

async function readReplyComments(result: ReplyCommentListResult): Promise<ReplyComment[]> {
  const comments = await result
  return Array.isArray(comments) ? comments : comments.all()
}

export function renderConfirmationReply(
  record: ConfirmationClaimRecord,
  settings: AppSettings = DEFAULT_APP_SETTINGS,
): string {
  return withMarker(renderTemplate(settings.tradeConfirmation, {
    confirmer: record.confirmer,
    parent_author: record.parentAuthor,
    old_comment_flair: tradeFlairText(record.confirmerPreviousCount, settings.flairCountLabel),
    new_comment_flair: tradeFlairText(record.confirmerCount, settings.flairCountLabel),
    old_parent_flair: tradeFlairText(record.parentPreviousCount, settings.flairCountLabel),
    new_parent_flair: tradeFlairText(record.parentCount, settings.flairCountLabel),
    confirmation_id: record.parentCommentId,
  }), confirmationReplyMarker(record))
}

export function confirmationReplyMarker(record: ConfirmationClaimRecord): string {
  return `Confirmation ID: ${record.parentCommentId}`
}

export function shouldReplyToRejection(reason: ConfirmationRejectionReason): boolean {
  return reason === 'same_user' || reason === 'old_thread' || reason === 'cant_confirm_username'
}

function renderRejectionReply(
  record: RejectionReplyRecord,
  settings: AppSettings = DEFAULT_APP_SETTINGS,
): string {
  return withMarker(renderTemplate(rejectionTemplate(record.reason, settings), {
    author_name: record.authorName,
    parent_author: record.parentAuthor,
  }), rejectionReplyMarker(record))
}

function rejectionReplyMarker(record: RejectionReplyRecord): string {
  return `Rejection ID: ${record.commentId}`
}

async function getOrCreateRejectionRecord(
  ctx: ReplyEffectContext,
  input: RejectionReplyInput,
  clock: Clock,
): Promise<RejectionReplyRecord> {
  const key = rejectionKey(input.commentId)
  const existing = parseRejectionRecord(await ctx.redis.get(key))
  if (existing) return existing

  const now = clock.now().toISOString()
  const record: RejectionReplyRecord = {
    ...input,
    effects: { reply: { status: 'pending' } },
    createdAt: now,
    updatedAt: now,
  }
  await ctx.redis.set(key, JSON.stringify(record), { nx: true })
  return parseRejectionRecord(await ctx.redis.get(key)) ?? record
}

async function updateRejectionReplyEffect(
  ctx: ReplyEffectContext,
  commentId: string,
  effect: EffectState,
  clock: Clock,
): Promise<RejectionReplyRecord | null> {
  const key = rejectionKey(commentId)
  const record = parseRejectionRecord(await ctx.redis.get(key))
  if (!record) return null

  const updated: RejectionReplyRecord = {
    ...record,
    effects: { ...record.effects, reply: effect },
    updatedAt: clock.now().toISOString(),
  }
  await ctx.redis.set(key, JSON.stringify(updated))
  return updated
}

function rejectionKey(commentId: string): string {
  return `rejected:${commentId}`
}

function rejectionTemplate(reason: RejectionReplyReason, settings: AppSettings): string {
  if (reason === 'already_claimed') {
    return settings.alreadyConfirmed
  }
  if (reason === 'same_user') {
    return settings.sameUserConfirmation
  }
  if (reason === 'cant_confirm_username') {
    return settings.cantConfirmUsername
  }
  if (reason === 'old_thread') return settings.oldConfirmationThread
  return DEFAULT_APP_SETTINGS.oldConfirmationThread
}

function parseRejectionRecord(value: string | undefined): RejectionReplyRecord | null {
  if (!value) return null
  try {
    const record = JSON.parse(value) as Partial<RejectionReplyRecord>
    if (typeof record.commentId !== 'string') return null
    if (typeof record.replyToCommentId !== 'string') return null
    if (typeof record.postId !== 'string') return null
    if (typeof record.subredditName !== 'string') return null
    if (typeof record.reason !== 'string') return null
    if (record.authorName !== undefined && typeof record.authorName !== 'string') return null
    if (record.parentAuthor !== undefined && typeof record.parentAuthor !== 'string') return null
    if (!record.effects) return null
    if (typeof record.createdAt !== 'string') return null
    if (typeof record.updatedAt !== 'string') return null
    return record as RejectionReplyRecord
  } catch {
    return null
  }
}

function withMarker(body: string, marker: string): string {
  return body.includes(marker) ? body : [body.trimEnd(), '', marker].join('\n')
}
