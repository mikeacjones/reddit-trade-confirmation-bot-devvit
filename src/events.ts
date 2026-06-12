import type { Clock } from './clock.js'
import {
  enqueueConfirmationComment,
  nudgeConfirmationWorker,
  type QueueNudgeContext,
} from './workQueue.js'

interface CommentSubmitEvent {
  comment?: {
    id: string
    postId: string
  }
  subreddit?: {
    name?: string
  }
}

export async function onCommentSubmit(
  event: CommentSubmitEvent,
  ctx: QueueNudgeContext,
  options: { clock?: Clock } = {},
): Promise<void> {
  const comment = event.comment
  const subredditName = event.subreddit?.name
  if (!comment || !subredditName) return

  const result = await enqueueConfirmationComment(
    ctx,
    {
      commentId: comment.id,
      postId: comment.postId,
      subredditName,
    },
    options.clock,
  )
  if (result.enqueued) {
    await nudgeConfirmationWorker(ctx, options.clock)
  }
}

