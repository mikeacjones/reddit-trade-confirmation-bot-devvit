import { expirationFrom, systemClock, type Clock } from './clock.js'

export const CONFIRMATION_WORK_KIND = 'confirmation-comment'
export const MANUAL_CONFIRMATION_WORK_KIND = 'manual-confirmation'
export const PROCESS_CONFIRMATION_WORK_JOB = 'process-confirmation-work'
export const READY_QUEUE_KEY = 'work:ready'
export const FAILED_QUEUE_KEY = 'work:failed'
export const POLLER_LEASE_KEY = 'work:poller:lease'
export const WORKER_NUDGE_KEY = 'work:nudge:process-confirmation-work'

const POLLER_LEASE_TTL_MS = 30_000
const ITEM_LEASE_TTL_MS = 45_000
const RETRY_DELAY_MS = 30_000
const DUE_WORK_SCAN_LIMIT = 10
const WORKER_NUDGE_DEBOUNCE_MS = 2_000
const WORKER_NUDGE_DELAY_MS = 1_000
const MAX_WORK_ATTEMPTS = 10

export interface ConfirmationWorkItem {
  workId: string
  kind: typeof CONFIRMATION_WORK_KIND | typeof MANUAL_CONFIRMATION_WORK_KIND
  commentId: string
  postId: string
  subredditName: string
  enqueuedAt: string
  status: 'queued' | 'failed'
  attempts: number
  nextAttemptAt: number
  failedAt?: string
  lastError?: string
}

export interface EnqueueConfirmationInput {
  commentId: string
  postId: string
  subredditName: string
}

export interface EnqueueConfirmationResult {
  workId: string
  enqueued: boolean
  item: ConfirmationWorkItem
}

interface RedisSetOptions {
  nx?: boolean
  expiration?: Date
}

interface RedisZMember {
  member: string
  score: number
}

interface RedisZRangeOptions {
  by: 'score' | 'lex' | 'rank'
  limit?: {
    offset: number
    count: number
  }
}

export interface QueueRedis {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, options?: RedisSetOptions): Promise<string>
  zAdd(key: string, ...members: RedisZMember[]): Promise<number>
}

export interface QueueWorkerRedis extends QueueRedis {
  del(...keys: string[]): Promise<unknown>
  zRem(key: string, members: string[]): Promise<number>
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: RedisZRangeOptions,
  ): Promise<RedisZMember[]>
}

export interface QueueCompletionRedis extends QueueRedis {
  del(...keys: string[]): Promise<unknown>
  zRem(key: string, members: string[]): Promise<number>
}

export interface QueueScheduler {
  runJob(job: { name: string; runAt: Date }): Promise<string>
}

export interface QueueContext {
  redis: QueueRedis
}

export interface QueueNudgeContext extends QueueContext {
  scheduler: QueueScheduler
}

export interface QueueWorkerContext {
  redis: QueueWorkerRedis
}

export interface QueueListContext {
  redis: Pick<QueueWorkerRedis, 'get' | 'zRange'>
}

export interface QueueCompletionContext {
  redis: QueueCompletionRedis
}

export interface QueueRetryContext {
  redis: QueueRedis & {
    get(key: string): Promise<string | undefined>
    del(...keys: string[]): Promise<unknown>
    zRem(key: string, members: string[]): Promise<number>
  }
}

export function confirmationWorkId(commentId: string): string {
  return `${CONFIRMATION_WORK_KIND}:${commentId}`
}

export function manualConfirmationWorkId(commentId: string): string {
  return `${MANUAL_CONFIRMATION_WORK_KIND}:${commentId}`
}

export function workItemKey(workId: string): string {
  return `work:item:${workId}`
}

export function workItemLeaseKey(workId: string): string {
  return `work:lease:${workId}`
}

export function processedWorkKey(workId: string): string {
  return `work:processed:${workId}`
}

export async function enqueueConfirmationComment(
  ctx: QueueContext,
  input: EnqueueConfirmationInput,
  clock: Clock = systemClock,
): Promise<EnqueueConfirmationResult> {
  return enqueueWork(ctx, CONFIRMATION_WORK_KIND, confirmationWorkId(input.commentId), input, clock)
}

export async function enqueueManualConfirmation(
  ctx: QueueContext,
  input: EnqueueConfirmationInput,
  clock: Clock = systemClock,
): Promise<EnqueueConfirmationResult> {
  return enqueueWork(ctx, MANUAL_CONFIRMATION_WORK_KIND, manualConfirmationWorkId(input.commentId), input, clock)
}

async function enqueueWork(
  ctx: QueueContext,
  kind: ConfirmationWorkItem['kind'],
  workId: string,
  input: EnqueueConfirmationInput,
  clock: Clock,
): Promise<EnqueueConfirmationResult> {
  const now = clock.now()
  const item: ConfirmationWorkItem = {
    workId,
    kind,
    commentId: input.commentId,
    postId: input.postId,
    subredditName: input.subredditName,
    enqueuedAt: now.toISOString(),
    status: 'queued',
    attempts: 0,
    nextAttemptAt: now.getTime(),
  }

  if (await ctx.redis.get(processedWorkKey(workId)) !== undefined) {
    return { workId, enqueued: false, item }
  }

  const enqueued = Boolean(await ctx.redis.set(workItemKey(workId), JSON.stringify(item), { nx: true }))
  if (enqueued) {
    await ctx.redis.zAdd(READY_QUEUE_KEY, { member: workId, score: item.nextAttemptAt })
  }

  return { workId, enqueued, item }
}

export async function nudgeConfirmationWorker(
  ctx: QueueNudgeContext,
  clock: Clock = systemClock,
): Promise<boolean> {
  const now = clock.now()
  const claimed = Boolean(await ctx.redis.set(WORKER_NUDGE_KEY, String(now.getTime()), {
    nx: true,
    expiration: expirationFrom(now, WORKER_NUDGE_DEBOUNCE_MS),
  }))
  if (!claimed) return false

  await ctx.scheduler.runJob({
    name: PROCESS_CONFIRMATION_WORK_JOB,
    runAt: expirationFrom(now, WORKER_NUDGE_DELAY_MS),
  })
  return true
}

export async function acquirePollerLease(
  ctx: QueueContext,
  clock: Clock = systemClock,
): Promise<boolean> {
  const now = clock.now()
  return Boolean(await ctx.redis.set(POLLER_LEASE_KEY, String(now.getTime()), {
    nx: true,
    expiration: expirationFrom(now, POLLER_LEASE_TTL_MS),
  }))
}

export async function claimNextDueWork(
  ctx: QueueWorkerContext,
  clock: Clock = systemClock,
): Promise<ConfirmationWorkItem | null> {
  const now = clock.now()
  const due = await ctx.redis.zRange(READY_QUEUE_KEY, '-inf', now.getTime(), {
    by: 'score',
    limit: { offset: 0, count: DUE_WORK_SCAN_LIMIT },
  })

  for (const { member: workId } of due) {
    if (await ctx.redis.get(processedWorkKey(workId)) !== undefined) {
      await cleanupWorkItem(ctx, workId)
      continue
    }

    const claimed = Boolean(await ctx.redis.set(workItemLeaseKey(workId), String(now.getTime()), {
      nx: true,
      expiration: expirationFrom(now, ITEM_LEASE_TTL_MS),
    }))
    if (!claimed) continue

    const item = parseConfirmationWorkItem(await ctx.redis.get(workItemKey(workId)))
    if (item) return item
    await cleanupWorkItem(ctx, workId)
  }

  return null
}

export async function completeWorkItem(
  ctx: QueueCompletionContext,
  item: ConfirmationWorkItem,
  clock: Clock = systemClock,
): Promise<void> {
  await ctx.redis.set(processedWorkKey(item.workId), JSON.stringify({
    workId: item.workId,
    kind: item.kind,
    commentId: item.commentId,
    postId: item.postId,
    subredditName: item.subredditName,
    processedAt: clock.now().toISOString(),
  }))
  await cleanupWorkItem(ctx, item.workId)
}

export async function failWorkItem(
  ctx: QueueCompletionContext,
  item: ConfirmationWorkItem,
  error: unknown,
  clock: Clock = systemClock,
): Promise<void> {
  const now = clock.now()
  const attempts = item.attempts + 1
  if (attempts >= MAX_WORK_ATTEMPTS) {
    const failed: ConfirmationWorkItem = {
      ...item,
      status: 'failed',
      attempts,
      failedAt: now.toISOString(),
      lastError: errorMessage(error),
    }
    await ctx.redis.set(workItemKey(item.workId), JSON.stringify(failed))
    await ctx.redis.zRem(READY_QUEUE_KEY, [item.workId])
    await ctx.redis.zAdd(FAILED_QUEUE_KEY, { member: item.workId, score: now.getTime() })
    return
  }

  const failed: ConfirmationWorkItem = {
    ...item,
    attempts,
    nextAttemptAt: now.getTime() + RETRY_DELAY_MS,
    lastError: errorMessage(error),
  }
  await ctx.redis.set(workItemKey(item.workId), JSON.stringify(failed))
  await ctx.redis.zAdd(READY_QUEUE_KEY, { member: item.workId, score: failed.nextAttemptAt })
}

export async function retryFailedWorkItem(
  ctx: QueueRetryContext,
  workId: string,
  clock: Clock = systemClock,
): Promise<boolean> {
  if (await ctx.redis.get(processedWorkKey(workId)) !== undefined) {
    await ctx.redis.zRem(FAILED_QUEUE_KEY, [workId])
    await ctx.redis.del(workItemKey(workId), workItemLeaseKey(workId))
    return false
  }

  const item = parseFailedConfirmationWorkItem(await ctx.redis.get(workItemKey(workId)))
  if (!item) return false

  const retried: ConfirmationWorkItem = {
    ...item,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: clock.now().getTime(),
  }
  delete retried.failedAt
  delete retried.lastError

  await ctx.redis.set(workItemKey(workId), JSON.stringify(retried))
  await ctx.redis.zAdd(READY_QUEUE_KEY, { member: workId, score: retried.nextAttemptAt })
  await ctx.redis.zRem(FAILED_QUEUE_KEY, [workId])
  return true
}

export async function listReadyWorkItems(
  ctx: QueueListContext,
  limit = 25,
): Promise<ConfirmationWorkItem[]> {
  const ready = await ctx.redis.zRange(READY_QUEUE_KEY, '-inf', '+inf', {
    by: 'score',
    limit: { offset: 0, count: limit },
  })
  const items = await Promise.all(
    ready.map(({ member }) => ctx.redis.get(workItemKey(member)).then(parseConfirmationWorkItem)),
  )
  return items.filter(item => item !== null)
}

export async function listFailedWorkItems(
  ctx: QueueListContext,
  limit = 25,
): Promise<ConfirmationWorkItem[]> {
  const failed = await ctx.redis.zRange(FAILED_QUEUE_KEY, '-inf', '+inf', {
    by: 'score',
    limit: { offset: 0, count: limit },
  })
  const items = await Promise.all(
    failed.map(({ member }) => ctx.redis.get(workItemKey(member)).then(parseFailedConfirmationWorkItem)),
  )
  return items.filter(item => item !== null)
}

function parseConfirmationWorkItem(value: string | undefined): ConfirmationWorkItem | null {
  if (!value) return null
  try {
    const item = parseAnyConfirmationWorkItem(value)
    if (!item) return null
    if (item.status !== 'queued') return null
    return item
  } catch {
    return null
  }
}

async function cleanupWorkItem(
  ctx: { redis: Pick<QueueWorkerRedis, 'del' | 'zRem'> },
  workId: string,
): Promise<void> {
  await ctx.redis.zRem(READY_QUEUE_KEY, [workId])
  await ctx.redis.del(workItemKey(workId), workItemLeaseKey(workId))
}

function parseFailedConfirmationWorkItem(value: string | undefined): ConfirmationWorkItem | null {
  const item = parseAnyConfirmationWorkItem(value)
  return item?.status === 'failed' ? item : null
}

function parseAnyConfirmationWorkItem(value: string | undefined): ConfirmationWorkItem | null {
  if (!value) return null
  try {
    const item = JSON.parse(value) as Partial<ConfirmationWorkItem>
    if (item.kind !== CONFIRMATION_WORK_KIND && item.kind !== MANUAL_CONFIRMATION_WORK_KIND) return null
    if (typeof item.workId !== 'string') return null
    if (typeof item.commentId !== 'string') return null
    if (typeof item.postId !== 'string') return null
    if (typeof item.subredditName !== 'string') return null
    if (typeof item.enqueuedAt !== 'string') return null
    if (item.status !== 'queued' && item.status !== 'failed') return null
    if (typeof item.attempts !== 'number') return null
    if (typeof item.nextAttemptAt !== 'number') return null
    return item as ConfirmationWorkItem
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
