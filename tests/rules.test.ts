import { describe, it, expect } from 'vitest'
import {
  parseTradeCount,
  formatFlairFromTemplate,
  findFlairTemplate,
  isUsernameMentioned,
  evaluateConfirmation,
  type ConfirmationContext,
  type CommentInput,
} from '../src/rules'

describe('parseTradeCount', () => {
  it('returns 0 for null', () => {
    expect(parseTradeCount(null)).toBe(0)
  })

  it('returns 0 for empty string', () => {
    expect(parseTradeCount('')).toBe(0)
  })

  it('returns null for unparseable text', () => {
    expect(parseTradeCount('Cool Person')).toBeNull()
  })

  it('parses Trades: N', () => {
    expect(parseTradeCount('Trades: 47')).toBe(47)
  })

  it('parses with prefix', () => {
    expect(parseTradeCount('The Pen Person | Trades: 650')).toBe(650)
  })
})

describe('formatFlairFromTemplate', () => {
  it('replaces the range with the count', () => {
    expect(formatFlairFromTemplate('Trades: 0-1', 1)).toBe('Trades: 1')
  })

  it('preserves prefix and suffix', () => {
    expect(formatFlairFromTemplate('Pen Fanatic | Trades: 650-9999', 700)).toBe('Pen Fanatic | Trades: 700')
  })

  it('returns the template unchanged if no range', () => {
    expect(formatFlairFromTemplate('No Range Here', 5)).toBe('No Range Here')
  })
})

describe('findFlairTemplate', () => {
  const templates = new Map<[number, number], { id: string; template: string; modOnly: boolean }>([
    [[0, 1], { id: 'a', template: 'Trades: 0-1', modOnly: false }],
    [[2, 10], { id: 'b', template: 'Trades: 2-10', modOnly: false }],
    [[11, 50], { id: 'c', template: 'Trades: 11-50', modOnly: false }],
    [[0, 9999], { id: 'mod', template: 'Mod | Trades: 0-9999', modOnly: true }],
  ])

  it('returns the template matching the count for non-mods', () => {
    expect(findFlairTemplate(templates, 5, false)?.id).toBe('b')
  })

  it('returns the mod template for mods', () => {
    expect(findFlairTemplate(templates, 5, true)?.id).toBe('mod')
  })

  it('returns null when no template matches', () => {
    expect(findFlairTemplate(templates, 100000, false)).toBeNull()
  })
})

describe('isUsernameMentioned', () => {
  it('matches u/name', () => {
    expect(isUsernameMentioned('sold to u/bob', 'bob')).toBe(true)
  })

  it('matches /u/name', () => {
    expect(isUsernameMentioned('sold to /u/bob', 'bob')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isUsernameMentioned('sold to U/Bob', 'bob')).toBe(true)
  })

  it('rejects substring matches like bobcats', () => {
    expect(isUsernameMentioned('i love bobcats', 'bob')).toBe(false)
  })

  it('rejects subreddit prefix r/bobross', () => {
    expect(isUsernameMentioned('check r/bobross', 'bob')).toBe(false)
  })

  it('rejects bare-name mentions without u/', () => {
    expect(isUsernameMentioned('sold to bob', 'bob')).toBe(false)
  })

  it('handles backslash-escaped underscores', () => {
    expect(isUsernameMentioned('sold to u/alliance\\_bob', 'alliance_bob')).toBe(true)
  })

  it('matches at end of string', () => {
    expect(isUsernameMentioned('hi u/bob', 'bob')).toBe(true)
  })

  it('matches at start of string', () => {
    expect(isUsernameMentioned('u/bob hi', 'bob')).toBe(true)
  })
})

const baseComment: CommentInput = {
  id: 'c1',
  body: 'confirmed',
  authorName: 'alice',
  isRoot: false,
}

const baseContext: ConfirmationContext = {
  parentExists: true,
  parentIsBanned: false,
  parentIsProcessable: true,
  parentAuthorName: 'bob',
  parentId: 'p1',
  parentIsRoot: true,
  parentIsSaved: false,
  parentBody: 'sold to u/alice',
  isModerator: false,
  grandparentExists: false,
  grandparentIsRoot: false,
  grandparentAuthorName: '',
  grandparentId: '',
  isCurrentSubmission: true,
}

describe('evaluateConfirmation', () => {
  it('rejects root comments on current thread without reason', () => {
    const r = evaluateConfirmation({ ...baseComment, isRoot: true }, baseContext)
    expect(r.valid).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  it('rejects root comments on old thread without reason', () => {
    const r = evaluateConfirmation(
      { ...baseComment, isRoot: true },
      { ...baseContext, isCurrentSubmission: false },
    )
    expect(r.valid).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  it('rejects replies on old thread with old_confirmation_thread reason', () => {
    const r = evaluateConfirmation(
      baseComment,
      { ...baseContext, isCurrentSubmission: false },
    )
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('old_confirmation_thread')
  })

  it('rejects when parent does not exist', () => {
    const r = evaluateConfirmation(baseComment, { ...baseContext, parentExists: false })
    expect(r.valid).toBe(false)
  })

  it('rejects self-confirmation', () => {
    const r = evaluateConfirmation(baseComment, { ...baseContext, parentAuthorName: 'alice' })
    expect(r.valid).toBe(false)
  })

  it('mod approval: valid when mod replies "approved" to a confirmation', () => {
    const r = evaluateConfirmation(
      { ...baseComment, body: 'approved' },
      {
        ...baseContext,
        parentIsRoot: false,
        grandparentExists: true,
        grandparentIsRoot: true,
        grandparentAuthorName: 'carol',
        grandparentId: 'gp1',
        isModerator: true,
      },
    )
    expect(r.valid).toBe(true)
    expect(r.isModApproval).toBe(true)
    expect(r.parentAuthor).toBe('carol')
    expect(r.confirmer).toBe('bob')
    expect(r.parentCommentId).toBe('gp1')
    expect(r.replyToCommentId).toBe('p1')
  })

  it('rejects "approved" from non-mod', () => {
    const r = evaluateConfirmation(
      { ...baseComment, body: 'approved' },
      { ...baseContext, parentIsRoot: false, isModerator: false },
    )
    expect(r.valid).toBe(false)
  })

  it('rejects when comment body lacks "confirmed"', () => {
    const r = evaluateConfirmation({ ...baseComment, body: 'thanks!' }, baseContext)
    expect(r.valid).toBe(false)
  })

  it('rejects already-confirmed (parent saved) with reason', () => {
    const r = evaluateConfirmation(baseComment, { ...baseContext, parentIsSaved: true })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('already_confirmed')
    expect(r.parentAuthor).toBe('bob')
    expect(r.parentCommentId).toBe('p1')
  })

  it('rejects when confirmer not mentioned with cant_confirm_username reason', () => {
    const r = evaluateConfirmation(baseComment, { ...baseContext, parentBody: 'sold to someone' })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('cant_confirm_username')
    expect(r.parentAuthor).toBe('bob')
  })

  it('returns valid for a well-formed confirmation', () => {
    const r = evaluateConfirmation(baseComment, baseContext)
    expect(r.valid).toBe(true)
    expect(r.parentAuthor).toBe('bob')
    expect(r.confirmer).toBe('alice')
    expect(r.parentCommentId).toBe('p1')
    expect(r.replyToCommentId).toBe('c1')
  })
})
