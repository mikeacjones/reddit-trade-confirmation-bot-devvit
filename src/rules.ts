import { DEFAULT_LANGUAGE_SETTINGS } from './language.js'
import { escapeRegex as escape } from './utils.js'

function flairCountPattern(label: string): RegExp {
  return new RegExp(`${escape(label)} (\\d+)`)
}

function flairRangePattern(label: string): RegExp {
  return new RegExp(`${escape(label)} ((\\d+)-(\\d+))`)
}

export function parseTradeCount(
  flairText: string | null | undefined,
  label: string = DEFAULT_LANGUAGE_SETTINGS.flairCountLabel,
): number | null {
  if (!flairText) return 0
  // Range text ("Trades: 5-9") is a flair template's text, not a user count;
  // matching the count pattern against it would misread the range minimum.
  if (flairRangePattern(label).test(flairText)) return null
  const m = flairText.match(flairCountPattern(label))
  return m ? parseInt(m[1], 10) : null
}

export function formatFlairFromTemplate(
  template: string,
  count: number,
  label: string = DEFAULT_LANGUAGE_SETTINGS.flairCountLabel,
): string {
  const m = template.match(flairRangePattern(label))
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

export function isUsernameMentioned(parentBody: string, username: string): boolean {
  const cleaned = parentBody.replace(/\\/g, '')
  // Usernames may contain hyphens, so \b alone would let "alex" match "u/alex-trader".
  const pattern = new RegExp(`(?:^|[^\\w/])/?u/${escape(username)}(?![\\w-])`, 'i')
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
  parentBody: string
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

export function evaluateConfirmation(
  comment: CommentInput,
  ctx: ConfirmationContext,
  confirmationKeyword: string = DEFAULT_LANGUAGE_SETTINGS.confirmationKeyword,
): ValidationResult {
  if (comment.isRoot) return { valid: false }

  if (!ctx.isCurrentSubmission) return { valid: false, reason: 'old_confirmation_thread' }
  if (!ctx.parentExists || ctx.parentIsBanned) return { valid: false }
  if (!ctx.parentIsProcessable) return { valid: false }
  if (ctx.parentAuthorName === comment.authorName) return { valid: false }

  // Only a direct reply to a top-level trade comment can confirm it.
  if (!ctx.parentIsRoot) return { valid: false }
  if (!comment.body.toLowerCase().includes(confirmationKeyword.toLowerCase())) return { valid: false }

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
