import type { Clock } from './clock.js'
import {
  enqueueConfirmationComment,
  nudgeConfirmationWorker,
  type QueueNudgeContext,
} from './workQueue.js'

const CURRENT_MONTHLY_POST_KEY = 'currentMonthlyPost'
const RESCAN_LIMIT = 1000
const RESCAN_PAGE_SIZE = 100
export const RESCAN_CONFIRMATION_COMMENTS_JOB = 'rescan-confirmation-comments'
export const RESCAN_CONFIRMATION_COMMENTS_CRON = '30 * * * *'

type RescanComment = {
  id: string
  postId?: string
}

type CommentListing = {
  all(): Promise<RescanComment[]>
}

interface RescanContext extends QueueNudgeContext {
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
    }): CommentListing
  }
}

export interface RescanResult {
  scanned: number
  enqueued: number
}

export async function enqueueCurrentMonthlyPostComments(
  ctx: RescanContext,
  options: { clock?: Clock } = {},
): Promise<RescanResult> {
  const postId = await ctx.redis.get(CURRENT_MONTHLY_POST_KEY)
  if (!postId) return { scanned: 0, enqueued: 0 }

  const subredditName = await ctx.reddit.getCurrentSubredditName()
  const comments = await ctx.reddit.getComments({
    postId,
    sort: 'new',
    limit: RESCAN_LIMIT,
    pageSize: RESCAN_PAGE_SIZE,
  }).all()

  let enqueued = 0
  for (const comment of comments) {
    const result = await enqueueConfirmationComment(ctx, {
      commentId: comment.id,
      postId: comment.postId ?? postId,
      subredditName,
    }, options.clock)
    if (result.enqueued) enqueued++
  }

  if (enqueued > 0) await nudgeConfirmationWorker(ctx, options.clock)
  return { scanned: comments.length, enqueued }
}
