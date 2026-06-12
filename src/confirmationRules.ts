export interface CommentSnapshot {
  id: string
  body: string
  authorName: string
  parentId: string
  postId: string
  removed?: boolean
}

export interface PostSnapshot {
  id: string
  authorId: string
  locked?: boolean
}

export type ConfirmationRejectionReason =
  | 'root_comment'
  | 'old_thread'
  | 'not_bot_thread'
  | 'locked_thread'
  | 'missing_keyword'
  | 'missing_parent'
  | 'parent_unavailable'
  | 'parent_not_root'
  | 'same_user'
  | 'cant_confirm_username'

export type ConfirmationEvaluation =
  | {
    valid: true
    commentId: string
    replyToCommentId: string
    parentCommentId: string
    parentAuthor: string
    confirmer: string
    postId: string
  }
  | {
    valid: false
    reason: ConfirmationRejectionReason
  }

export interface ConfirmationEvaluationInput {
  comment: CommentSnapshot
  parent?: CommentSnapshot | null
  post: PostSnapshot
  botUserId: string
  currentMonthlyPostId: string
  confirmationKeyword: string
}

export function evaluateConfirmationComment(input: ConfirmationEvaluationInput): ConfirmationEvaluation {
  const { comment, parent, post } = input
  if (comment.parentId.startsWith('t3_')) return rejected('root_comment')
  if (post.id !== input.currentMonthlyPostId) return rejected('old_thread')
  if (post.authorId !== input.botUserId) return rejected('not_bot_thread')
  if (post.locked) return rejected('locked_thread')
  if (!containsKeyword(comment.body, input.confirmationKeyword)) return rejected('missing_keyword')
  if (!parent) return rejected('missing_parent')
  if (parent.removed || !parent.authorName) return rejected('parent_unavailable')
  if (!parent.parentId.startsWith('t3_')) return rejected('parent_not_root')
  if (parent.authorName.toLowerCase() === comment.authorName.toLowerCase()) return rejected('same_user')
  if (!mentionsUsername(parent.body, comment.authorName)) return rejected('cant_confirm_username')

  return {
    valid: true,
    commentId: comment.id,
    replyToCommentId: comment.id,
    parentCommentId: parent.id,
    parentAuthor: parent.authorName,
    confirmer: comment.authorName,
    postId: comment.postId,
  }
}

function containsKeyword(body: string, keyword: string): boolean {
  return body.toLowerCase().includes(keyword.toLowerCase())
}

function rejected(reason: ConfirmationRejectionReason): ConfirmationEvaluation {
  return { valid: false, reason }
}

function stripBackslashes(value: string): string {
  return value.replace(/\\/g, '')
}

function mentionsUsername(body: string, username: string): boolean {
  const pattern = new RegExp(`(?:^|[^\\w/])/?u/${escapeRegExp(username)}\\b`, 'i')
  return pattern.test(stripBackslashes(body))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
