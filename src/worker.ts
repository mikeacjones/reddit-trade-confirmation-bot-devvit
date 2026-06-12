import { systemClock, type Clock } from './clock.js'
import {
  cleanupTerminalConfirmationState,
  processConfirmationItem,
  type ConfirmationWorkflowContext,
  type ProcessConfirmationItemResult,
} from './confirmationWorkflow.js'
import {
  acquirePollerLease,
  claimNextDueWork,
  completeWorkItem,
  failWorkItem,
  type ConfirmationWorkItem,
  type QueueCompletionContext,
  type QueueWorkerContext,
} from './workQueue.js'

type ConfirmationWorkerContext = QueueWorkerContext & QueueCompletionContext & ConfirmationWorkflowContext
const MAX_ITEMS_PER_RUN = 5
const WORKER_BUDGET_MS = 20_000

export interface ProcessConfirmationWorkResult {
  pollerAcquired: boolean
  processed: number
}

export interface ProcessConfirmationWorkOptions {
  clock?: Clock
  maxItems?: number
  maxRuntimeMs?: number
  processItem?: (
    item: ConfirmationWorkItem,
    ctx: ConfirmationWorkerContext,
  ) => Promise<ProcessConfirmationItemResult | void>
}

export async function processConfirmationWork(
  ctx: ConfirmationWorkerContext,
  options: ProcessConfirmationWorkOptions = {},
): Promise<ProcessConfirmationWorkResult> {
  const clock = options.clock ?? systemClock
  const startedAt = clock.now().getTime()
  if (!await acquirePollerLease(ctx, clock)) {
    return { pollerAcquired: false, processed: 0 }
  }

  const maxItems = options.maxItems ?? MAX_ITEMS_PER_RUN
  const maxRuntimeMs = options.maxRuntimeMs ?? WORKER_BUDGET_MS
  let processed = 0
  for (let i = 0; i < maxItems; i++) {
    if (clock.now().getTime() - startedAt >= maxRuntimeMs) break
    const item = await claimNextDueWork(ctx, clock)
    if (!item) break
    try {
      const result = options.processItem
        ? await options.processItem(item, ctx)
        : await processConfirmationItem(ctx, item, { clock })
      await completeWorkItem(ctx, item, clock)
      processed++
      if (result) {
        await cleanupTerminalConfirmationState(ctx, item, result, clock).catch(error => {
          console.warn(`Failed to clean up terminal state for ${item.workId}: ${errorMessage(error)}`)
        })
      }
    } catch (error) {
      await failWorkItem(ctx, item, error, clock)
    }
  }

  return { pollerAcquired: true, processed }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
