import {
  evaluateConfirmationComment,
  type CommentSnapshot,
  type ConfirmationEvaluation,
  type PostSnapshot,
} from './confirmationRules.js'
import { getAppSettings } from './settings.js'
import type { ConfirmationWorkItem } from './workQueue.js'

const CURRENT_MONTHLY_POST_KEY = 'currentMonthlyPost'
const DEFAULT_CONFIRMATION_KEYWORD = 'confirmed'

interface RedditComment {
  id: string
  body?: string
  authorName?: string
  parentId: string
  postId: string
  removed?: boolean
}

interface RedditPost {
  id: string
  authorId?: string
  locked?: boolean
}

interface ProcessorContext {
  reddit: {
    getCommentById(id: string): Promise<RedditComment>
    getPostById(id: string): Promise<RedditPost>
    getAppUser(): Promise<{ id: string; username?: string }>
  }
  redis: {
    get(key: string): Promise<string | undefined>
  }
  settings?: {
    get<T>(name: string): Promise<T | undefined>
  }
}

export interface QueuedConfirmationEvaluation {
  evaluation: ConfirmationEvaluation
  botUsername?: string
  commentAuthor?: string
  parentAuthor?: string
}

export async function evaluateQueuedConfirmation(
  ctx: ProcessorContext,
  item: ConfirmationWorkItem,
  confirmationKeyword = DEFAULT_CONFIRMATION_KEYWORD,
): Promise<QueuedConfirmationEvaluation> {
  const comment = await ctx.reddit.getCommentById(item.commentId)
  const parent = comment.parentId.startsWith('t1_')
    ? await ctx.reddit.getCommentById(comment.parentId)
    : null
  const post = await ctx.reddit.getPostById(item.postId)
  const botUser = await ctx.reddit.getAppUser()
  const currentMonthlyPostId = await ctx.redis.get(CURRENT_MONTHLY_POST_KEY)
  if (!currentMonthlyPostId) throw new Error('Current confirmation post is not set')
  const settings = confirmationKeyword === DEFAULT_CONFIRMATION_KEYWORD
    ? await getAppSettings(ctx)
    : null

  return {
    evaluation: evaluateConfirmationComment({
      comment: commentSnapshot(comment),
      parent: parent ? commentSnapshot(parent) : null,
      post: postSnapshot(post),
      botUserId: botUser.id ?? '',
      currentMonthlyPostId,
      confirmationKeyword: settings?.confirmationKeyword ?? confirmationKeyword,
    }),
    botUsername: botUser.username,
    commentAuthor: comment.authorName,
    parentAuthor: parent?.authorName,
  }
}

function commentSnapshot(comment: RedditComment): CommentSnapshot {
  return {
    id: comment.id,
    body: comment.body ?? '',
    authorName: comment.authorName ?? '',
    parentId: comment.parentId,
    postId: comment.postId,
    removed: comment.removed ?? false,
  }
}

function postSnapshot(post: RedditPost): PostSnapshot {
  return {
    id: post.id,
    authorId: post.authorId ?? '',
    locked: post.locked ?? false,
  }
}
