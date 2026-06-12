import { describe, expect, it } from 'vitest'
import { evaluateConfirmationComment } from '../src/confirmationRules.js'

const validInput = {
  comment: {
    id: 't1_confirm',
    body: 'confirmed',
    authorName: 'buyer',
    parentId: 't1_parent',
    postId: 't3_post',
    removed: false,
  },
  parent: {
    id: 't1_parent',
    body: 'sold to u/buyer',
    authorName: 'seller',
    parentId: 't3_post',
    postId: 't3_post',
    removed: false,
  },
  post: {
    id: 't3_post',
    authorId: 't2_bot',
    locked: false,
  },
  botUserId: 't2_bot',
  currentMonthlyPostId: 't3_post',
  confirmationKeyword: 'confirmed',
}

describe('evaluateConfirmationComment', () => {
  it('accepts a confirmation reply to a top-level trade comment', () => {
    expect(evaluateConfirmationComment(validInput)).toEqual({
      valid: true,
      commentId: 't1_confirm',
      replyToCommentId: 't1_confirm',
      parentCommentId: 't1_parent',
      parentAuthor: 'seller',
      confirmer: 'buyer',
      postId: 't3_post',
    })
  })

  it('rejects comments without the confirmation keyword', () => {
    expect(evaluateConfirmationComment({
      ...validInput,
      comment: { ...validInput.comment, body: 'thanks' },
    })).toEqual({
      valid: false,
      reason: 'missing_keyword',
    })
  })

  it('rejects when the parent comment does not mention the confirmer', () => {
    expect(evaluateConfirmationComment({
      ...validInput,
      parent: { ...validInput.parent, body: 'sold to someone' },
    })).toEqual({
      valid: false,
      reason: 'cant_confirm_username',
    })
  })

  it('ignores Reddit markdown backslash escaping when matching the confirmer username', () => {
    expect(evaluateConfirmationComment({
      ...validInput,
      comment: { ...validInput.comment, authorName: 'name_with_underscores' },
      parent: { ...validInput.parent, body: 'sold to u/name\\_with\\_underscores' },
    })).toEqual(expect.objectContaining({
      valid: true,
    }))
  })

  it('rejects self-confirmations', () => {
    expect(evaluateConfirmationComment({
      ...validInput,
      parent: { ...validInput.parent, authorName: 'Buyer' },
    })).toEqual({
      valid: false,
      reason: 'same_user',
    })
  })
})
