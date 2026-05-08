const FLAIR_PATTERN = /Trades: (\d+)/
const FLAIR_TEMPLATE_PATTERN = /Trades: ((\d+)-(\d+))/

export function parseTradeCount(flairText: string | null | undefined): number | null {
  if (!flairText) return 0
  const m = flairText.match(FLAIR_PATTERN)
  return m ? parseInt(m[1], 10) : null
}

export function formatFlairFromTemplate(template: string, count: number): string {
  const m = template.match(FLAIR_TEMPLATE_PATTERN)
  if (!m) return template
  const [start, end] = [m.index! + m[0].indexOf(m[1]), m.index! + m[0].indexOf(m[1]) + m[1].length]
  return template.slice(0, start) + String(count) + template.slice(end)
}

export interface FlairTemplate {
  id: string
  template: string
  modOnly: boolean
}

export function findFlairTemplate(
  templates: Map<[number, number], FlairTemplate>,
  count: number,
  isModerator: boolean,
): FlairTemplate | null {
  for (const [[min, max], tpl] of templates) {
    if (min <= count && count <= max && tpl.modOnly === isModerator) {
      return tpl
    }
  }
  return null
}

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g
const escape = (s: string) => s.replace(REGEX_ESCAPE, '\\$&')

export function isUsernameMentioned(parentBody: string, username: string): boolean {
  const cleaned = parentBody.replace(/\\/g, '')
  const pattern = new RegExp(`(?:^|[^\\w/])/?u/${escape(username)}\\b`, 'i')
  return pattern.test(cleaned)
}

export interface CommentInput {
  id: string
  body: string
  authorName: string
  isRoot: boolean
}

export interface ConfirmationContext {
  parentExists: boolean
  parentIsBanned: boolean
  parentIsProcessable: boolean
  parentAuthorName: string
  parentId: string
  parentIsRoot: boolean
  parentIsSaved: boolean
  parentBody: string
  isModerator: boolean
  grandparentExists: boolean
  grandparentIsRoot: boolean
  grandparentAuthorName: string
  grandparentId: string
  isCurrentSubmission: boolean
}

export interface ValidationResult {
  valid: boolean
  reason?: 'already_confirmed' | 'cant_confirm_username' | 'old_confirmation_thread'
  parentAuthor?: string
  confirmer?: string
  parentCommentId?: string
  isModApproval?: boolean
  replyToCommentId?: string
}

export function evaluateConfirmation(comment: CommentInput, ctx: ConfirmationContext): ValidationResult {
  if (comment.isRoot) {
    return ctx.isCurrentSubmission
      ? { valid: false }
      : { valid: false, reason: 'old_confirmation_thread' }
  }

  if (!ctx.parentExists || ctx.parentIsBanned) return { valid: false }
  if (!ctx.parentIsProcessable) return { valid: false }
  if (ctx.parentAuthorName === comment.authorName) return { valid: false }

  const body = comment.body.toLowerCase()

  // Mod approval path: comment replies to a confirmation (parent is non-root).
  if (!ctx.parentIsRoot) {
    if (body.includes('approved') && ctx.isModerator) {
      if (ctx.grandparentExists && ctx.grandparentIsRoot) {
        return {
          valid: true,
          isModApproval: true,
          parentAuthor: ctx.grandparentAuthorName,
          confirmer: ctx.parentAuthorName,
          parentCommentId: ctx.grandparentId,
          replyToCommentId: ctx.parentId,
        }
      }
    }
    return { valid: false }
  }

  if (!body.includes('confirmed')) return { valid: false }

  if (ctx.parentIsSaved) {
    return {
      valid: false,
      reason: 'already_confirmed',
      parentAuthor: ctx.parentAuthorName,
      parentCommentId: ctx.parentId,
    }
  }

  if (!isUsernameMentioned(ctx.parentBody, comment.authorName)) {
    return {
      valid: false,
      reason: 'cant_confirm_username',
      parentAuthor: ctx.parentAuthorName,
    }
  }

  return {
    valid: true,
    parentAuthor: ctx.parentAuthorName,
    confirmer: comment.authorName,
    parentCommentId: ctx.parentId,
    replyToCommentId: comment.id,
  }
}
