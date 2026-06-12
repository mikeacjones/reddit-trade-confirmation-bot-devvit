import { expirationFrom, systemClock, type Clock } from './clock.js'

const USER_BOOTSTRAP_LOCK_TTL_MS = 30_000

export type EffectState =
  | { status: 'pending' }
  | { status: 'applied'; at: string }
  | { status: 'posted'; at: string; replyId?: string }
  | { status: 'superseded'; at: string; currentCount: number }
  | { status: 'failed'; at: string; error: string; attempts: number }

export type EffectName = keyof ConfirmationClaimRecord['effects']

export interface ConfirmationClaimRecord {
  commentId: string
  replyToCommentId: string
  parentCommentId: string
  subredditName: string
  parentAuthor: string
  confirmer: string
  modApproval: boolean
  postId: string
  parentPreviousCount: number
  parentCount: number
  confirmerPreviousCount: number
  confirmerCount: number
  effects: {
    parentFlair: EffectState
    confirmerFlair: EffectState
    reply: EffectState
  }
  createdAt: string
  updatedAt: string
}

interface ConfirmedTradeMarker {
  commentId: string
  parentCommentId: string
  confirmedAt: string
}

export interface ConfirmationClaimInput {
  commentId: string
  replyToCommentId: string
  parentCommentId: string
  subredditName: string
  parentAuthor: string
  confirmer: string
  postId: string
  modApproval?: boolean
}

export type ConfirmationCommitResult =
  | { committed: true; record: ConfirmationClaimRecord }
  | { committed: false; reason: 'already_claimed' }

interface RedisTransaction {
  multi(): Promise<void>
  set(key: string, value: string, options?: { nx?: boolean }): Promise<unknown>
  exec(): Promise<unknown[] | null>
  unwatch(): Promise<unknown>
}

interface ConfirmationStateContext {
  redis: {
    get(key: string): Promise<string | undefined>
    set?: (key: string, value: string, options?: { nx?: boolean; expiration?: Date }) => Promise<unknown>
    watch(...keys: string[]): Promise<RedisTransaction>
  }
  reddit?: {
    getUserByUsername(username: string): Promise<{
      getUserFlairBySubreddit(subredditName: string): Promise<{ flairText?: string } | undefined>
    } | undefined>
  }
}

interface ConfirmationEffectContext {
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<unknown>
  }
}

export async function commitConfirmationClaim(
  ctx: ConfirmationStateContext,
  input: ConfirmationClaimInput,
  clock: Clock = systemClock,
): Promise<ConfirmationCommitResult> {
  const claimKey = confirmedKey(input.parentCommentId)
  const parentCountKey = countKey(input.parentAuthor)
  const confirmerCountKey = countKey(input.confirmer)
  const existingBeforeBootstrap = parseClaimReference(await ctx.redis.get(claimKey))
  if (existingBeforeBootstrap) {
    if ('record' in existingBeforeBootstrap && existingBeforeBootstrap.record.commentId === input.commentId) {
      return { committed: true, record: existingBeforeBootstrap.record }
    }
    return { committed: false, reason: 'already_claimed' }
  }

  await bootstrapMissingCount(ctx, input.subredditName, input.parentAuthor, clock)
  await bootstrapMissingCount(ctx, input.subredditName, input.confirmer, clock)
  const txn = await ctx.redis.watch(claimKey, parentCountKey, confirmerCountKey)

  const existing = parseClaimReference(await ctx.redis.get(claimKey))
  if (existing) {
    await txn.unwatch()
    if ('record' in existing && existing.record.commentId === input.commentId) {
      return { committed: true, record: existing.record }
    }
    return { committed: false, reason: 'already_claimed' }
  }

  const parentPreviousCount = parseStoredCount(await ctx.redis.get(parentCountKey))
  const confirmerPreviousCount = parseStoredCount(await ctx.redis.get(confirmerCountKey))
  const now = clock.now().toISOString()
  const record: ConfirmationClaimRecord = {
    ...input,
    modApproval: input.modApproval ?? false,
    parentPreviousCount,
    parentCount: parentPreviousCount + 1,
    confirmerPreviousCount,
    confirmerCount: confirmerPreviousCount + 1,
    effects: {
      parentFlair: { status: 'pending' },
      confirmerFlair: { status: 'pending' },
      reply: { status: 'pending' },
    },
    createdAt: now,
    updatedAt: now,
  }

  await txn.multi()
  await txn.set(claimKey, JSON.stringify(record), { nx: true })
  await txn.set(parentCountKey, String(record.parentCount))
  await txn.set(confirmerCountKey, String(record.confirmerCount))
  const results = await txn.exec()
  if (results === null) throw new Error('Redis transaction aborted')
  if (results[0] === null || results[0] === false) {
    const current = parseClaimReference(await ctx.redis.get(claimKey))
    if (current && 'record' in current && current.record.commentId === input.commentId) {
      return { committed: true, record: current.record }
    }
    if (current) return { committed: false, reason: 'already_claimed' }
    throw new Error('Redis confirmation claim was not written')
  }

  return { committed: true, record }
}

export async function updateConfirmationEffect(
  ctx: ConfirmationEffectContext,
  parentCommentId: string,
  effectName: EffectName,
  effect: EffectState,
  clock: Clock = systemClock,
): Promise<ConfirmationClaimRecord | null> {
  const key = confirmedKey(parentCommentId)
  const record = parseClaimRecord(await ctx.redis.get(key))
  if (!record) return null

  const updated: ConfirmationClaimRecord = {
    ...record,
    effects: {
      ...record.effects,
      [effectName]: effect,
    },
    updatedAt: clock.now().toISOString(),
  }
  await ctx.redis.set(key, JSON.stringify(updated))
  return updated
}

function countKey(username: string): string {
  return `confirmations:${username.toLowerCase()}`
}

function confirmedKey(parentCommentId: string): string {
  return `confirmed:${parentCommentId}`
}

function parseStoredCount(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

async function bootstrapMissingCount(
  ctx: ConfirmationStateContext,
  subredditName: string,
  username: string,
  clock: Clock,
): Promise<void> {
  const key = countKey(username)
  if (await ctx.redis.get(key) !== undefined) return
  if (!ctx.reddit || !ctx.redis.set) return
  const lockClaimed = await ctx.redis.set(userBootstrapKey(subredditName, username), '1', {
    nx: true,
    expiration: expirationFrom(clock.now(), USER_BOOTSTRAP_LOCK_TTL_MS),
  })
  if (!lockClaimed) throw new Error(`Could not acquire bootstrap lock for ${username}`)

  const user = await ctx.reddit.getUserByUsername(username)
  const flair = await user?.getUserFlairBySubreddit(subredditName)
  const count = parseTradeCount(flair?.flairText)
  if (count === null) return
  await ctx.redis.set(key, String(count), { nx: true })
}

function userBootstrapKey(subredditName: string, username: string): string {
  return `userBootstrap:${subredditName.toLowerCase()}:${username.toLowerCase()}`
}

function parseTradeCount(text: string | undefined): number | null {
  const match = text?.match(/\bTrades:\s*(\d+)\b/i)
  return match ? parseInt(match[1], 10) : null
}

function parseClaimRecord(value: string | undefined): ConfirmationClaimRecord | null {
  if (!value) return null
  try {
    const record = JSON.parse(value) as Partial<ConfirmationClaimRecord>
    if (typeof record.commentId !== 'string') return null
    if (typeof record.replyToCommentId !== 'string') return null
    if (typeof record.parentCommentId !== 'string') return null
    if (typeof record.subredditName !== 'string') return null
    if (typeof record.parentAuthor !== 'string') return null
    if (typeof record.confirmer !== 'string') return null
    if (typeof record.postId !== 'string') return null
    if (typeof record.parentPreviousCount !== 'number') return null
    if (typeof record.parentCount !== 'number') return null
    if (typeof record.confirmerPreviousCount !== 'number') return null
    if (typeof record.confirmerCount !== 'number') return null
    if (typeof record.createdAt !== 'string') return null
    if (typeof record.updatedAt !== 'string') return null
    if (!record.effects) return null
    return record as ConfirmationClaimRecord
  } catch {
    return null
  }
}

function parseClaimReference(value: string | undefined): { record: ConfirmationClaimRecord } | ConfirmedTradeMarker | null {
  const record = parseClaimRecord(value)
  if (record) return { record }
  const marker = parseConfirmedTradeMarker(value)
  return marker
}

function parseConfirmedTradeMarker(value: string | undefined): ConfirmedTradeMarker | null {
  if (!value) return null
  try {
    const marker = JSON.parse(value) as Partial<ConfirmedTradeMarker>
    if (typeof marker.commentId !== 'string') return null
    if (typeof marker.parentCommentId !== 'string') return null
    if (typeof marker.confirmedAt !== 'string') return null
    return marker as ConfirmedTradeMarker
  } catch {
    return null
  }
}
