/**
 * Adversarial probes of the pure confirmation rules (src/rules.ts, src/language.ts): how a `u/` tag
 * in the trade comment is recognised, how the confirmation keyword is matched, and who may confirm.
 * The scenario counterpart, which drives the same cases through the CommentSubmit trigger and the
 * approve menu item, is tests/scenarios/confirmationEdgeCases.test.ts.
 *
 * A probe that shows the code is correct is a normal test. A probe that shows a bug is an `it.fails`
 * repro with a `// BUG: <description>, severity <level>` comment: it keeps CI green and turns red
 * once the bug is fixed, which is the signal to turn it into an ordinary test.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageSettings } from '../src/language.js'
import { evaluateConfirmation, isUsernameMentioned, type ConfirmationContext } from '../src/rules.js'

describe('isUsernameMentioned: forms of the u/ tag that count', () => {
  it.each([
    ['plain tag', 'Sold a kit to u/bob', 'bob'],
    ['leading slash', 'Sold a kit to /u/bob', 'bob'],
    ['upper-case prefix', 'Sold a kit to U/bob', 'bob'],
    ['mixed-case name in the comment (u/Bob vs bob)', 'Sold a kit to u/Bob', 'bob'],
    ['lower-case name in the comment, mixed-case account (u/bob vs Bob)', 'Sold a kit to u/bob', 'Bob'],
    ['tag at the very start', 'u/bob thanks', 'bob'],
    ['tag at the very end', 'thanks u/bob', 'bob'],
    ['trailing period', 'Sold a kit to u/bob.', 'bob'],
    ['trailing comma', 'Sold a kit to u/bob, thanks', 'bob'],
    ['trailing exclamation and question marks', 'Thanks u/bob!? Great', 'bob'],
    ['trailing colon, semicolon, parenthesis', 'to u/bob: ok; (u/bob)', 'bob'],
    ['possessive apostrophe', "u/bob's kit", 'bob'],
    ['curly apostrophe', 'u/bob\u2019s kit', 'bob'],
    ['bold markdown', 'Sold to **u/bob**', 'bob'],
    ['italic with asterisks', 'Sold to *u/bob*', 'bob'],
    ['markdown link text', 'Sold to [u/bob](https://example.com)', 'bob'],
    ['markdown link to the profile path', 'Sold to [bob](/u/bob)', 'bob'],
    ['tag after a newline', 'Sold a kit\nu/bob', 'bob'],
    ['tag after a tab', 'Sold a kit\tu/bob', 'bob'],
    ['an em dash after the name', 'u/bob\u2014thanks', 'bob'],
    ['a spaced hyphen after the name', 'u/bob - thanks', 'bob'],
    ['two tags, the wanted one second', 'u/alice and u/bob', 'bob'],
    ['the same tag twice', 'u/bob u/bob', 'bob'],
    ['a longer tag first, the exact tag later', 'u/bobby-trader and u/bob', 'bob'],
    ['escaped underscore in the name (markdown escape)', 'sold to u/alliance\\_bob', 'alliance_bob'],
    ['underscore in the name', 'sold to u/alliance_bob', 'alliance_bob'],
    ['hyphen in the name', 'sold to u/bob-the-builder', 'bob-the-builder'],
    ['hyphen in the name, escaped', 'sold to u/bob\\-the\\-builder', 'bob-the-builder'],
    ['name that ends in an underscore', 'sold to u/bob_', 'bob_'],
    ['name that ends in a hyphen', 'sold to u/bob- ok', 'bob-'],
    ['digits in the name', 'sold to u/bob123', 'bob123'],
    ['zero-width space before the tag', '\u200Bu/bob', 'bob'],
    ['zero-width space after the tag', 'u/bob\u200B', 'bob'],
    ['a non-ASCII letter after the name (Reddit names are ASCII, so the tag ends there)', 'u/bob\u00E9', 'bob'],
    ['inline code span (no ping, but the tag is written out)', 'sold to `u/bob`', 'bob'],
    ['fenced code block', '```\nu/bob\n```', 'bob'],
    ['an escaped backslash-slash', 'sold to u\\/bob', 'bob'],
  ])('%s', (_label, body, username) => {
    expect(isUsernameMentioned(body, username)).toBe(true)
  })
})

describe('isUsernameMentioned: forms that must not count', () => {
  it.each([
    ['no tag at all', 'Sold a kit to bob', 'bob'],
    ['a bare name without u/', 'bob confirmed', 'bob'],
    ['a subreddit tag', 'see r/bob', 'bob'],
    ['a subreddit that starts with the name', 'check r/bobross', 'bob'],
    ['a name that is a prefix of another (bobcats)', 'u/bobcats', 'bob'],
    ['a name that is a prefix of a hyphenated name', 'Sold to u/bob-trader', 'bob'],
    ['a name that is a prefix of an underscored name', 'Sold to u/bob_trader', 'bob'],
    ['a name that is a prefix of a name with a trailing underscore', 'Sold to u/bob_', 'bob'],
    ['a name that is a prefix of a name with a trailing hyphen', 'Sold to u/bob-', 'bob'],
    ['a name that is a prefix of a name with digits', 'Sold to u/bob2', 'bob'],
    ['a longer account against a shorter tag (u/bob, account bobby)', 'Sold to u/bob', 'bobby'],
    ['a hyphenated account against its first segment only', 'Sold to u/bob', 'bob-the-builder'],
    ['a prefix glued to the tag (xu/bob)', 'Sold to xu/bob', 'bob'],
    ['a longer word ending in u (menu/bob)', 'menu/bob', 'bob'],
    ['a profile URL (the path is not a tag)', 'https://www.reddit.com/u/bob', 'bob'],
    ['a profile URL with a trailing slash', 'https://old.reddit.com/u/bob/', 'bob'],
    ['a link whose text is only the name', '[bob](https://www.reddit.com/u/bob)', 'bob'],
    ['a double slash before u', 'x//u/bob', 'bob'],
    ['a Cyrillic look-alike letter in the tag (u/b\u043Eb)', 'u/b\u043Eb', 'bob'],
    ['a full-width look-alike in the tag', 'u/\uFF22ob', 'bob'],
    ['a zero-width space inside the tag', 'u/b\u200Bob', 'bob'],
    ['a Cyrillic look-alike in the account name', 'u/bob', 'b\u043Eb'],
    ['the Kelvin sign standing in for K', 'u/\u212Aim', 'kim'],
    ['the long s standing in for s', 'u/\u017Fam', 'sam'],
    ['a space between the prefix and the name', 'u/ bob', 'bob'],
    ['the prefix with nothing after it', 'u/', 'bob'],
    ['a different user entirely', 'u/carol', 'bob'],
  ])('%s', (_label, body, username) => {
    expect(isUsernameMentioned(body, username)).toBe(false)
  })

  it('does not throw on regex metacharacters in a username', () => {
    expect(isUsernameMentioned('u/a.b', 'a.b')).toBe(true)
    expect(isUsernameMentioned('u/axb', 'a.b')).toBe(false)
    expect(isUsernameMentioned('u/bob', '(')).toBe(false)
    expect(isUsernameMentioned('u/bob', '*')).toBe(false)
    expect(isUsernameMentioned('u/bob', '')).toBe(false)
  })

  it('treats a lone `u/` followed by text as no tag for a real username', () => {
    expect(isUsernameMentioned('go to u/ and ask', 'and')).toBe(false)
  })
})

function ctxFor(overrides: Partial<ConfirmationContext> = {}): ConfirmationContext {
  return {
    parentExists: true,
    parentIsBanned: false,
    parentIsProcessable: true,
    parentAuthorName: 'alice',
    parentId: 't1_offer',
    parentIsRoot: true,
    parentBody: 'Sold a kit to u/bob',
    isCurrentSubmission: true,
    ...overrides,
  }
}

function confirm(body: string, overrides: Partial<ConfirmationContext> = {}, author = 'bob', keyword?: string) {
  return evaluateConfirmation({ id: 't1_reply', body, authorName: author, isRoot: false }, ctxFor(overrides), keyword)
}

describe('evaluateConfirmation: the confirmation keyword', () => {
  it.each([
    'confirmed',
    'Confirmed',
    'CONFIRMED',
    'cOnFiRmEd',
    'confirmed!',
    'Confirmed. Thanks!',
    '"confirmed"',
    '**confirmed**',
    '(confirmed)',
    'yes, confirmed, all good',
    'confirmed\nthanks',
    '\n\nconfirmed',
    'confirmed\u200B',
    'trade CONFIRMED \u{1F44D}',
  ])('accepts %j', body => {
    expect(confirm(body).valid).toBe(true)
  })

  it.each([
    '',
    '   ',
    'thanks, all good',
    'confirm',
    'confirming',
    'con firmed',
    'con-firmed',
    'c0nfirmed',
    'conf\u0456rmed', // Cyrillic i
    'CONFIRMED'.split('').join('\u200B'), // zero-width spaces between every letter
  ])('ignores %j without a reply', body => {
    expect(confirm(body)).toEqual({ valid: false })
  })

  it('checks the keyword before the tag, so a non-confirming reply from an untagged user is silent', () => {
    expect(confirm('hello', { parentBody: 'no tag here' })).toEqual({ valid: false })
  })

  it('honours a custom keyword in any case', () => {
    expect(confirm('BEST\u00C4TIGT', {}, 'bob', 'best\u00E4tigt').valid).toBe(true)
    expect(confirm('Best\u00E4tigt!', {}, 'bob', 'BEST\u00C4TIGT').valid).toBe(true)
    expect(confirm('confirmed', {}, 'bob', 'best\u00E4tigt')).toEqual({ valid: false })
  })

  it('matches a keyword with regex metacharacters literally', () => {
    expect(confirm('ok (yes)+', {}, 'bob', '(yes)+').valid).toBe(true)
    expect(confirm('yesss', {}, 'bob', '(yes)+')).toEqual({ valid: false })
  })

  // BUG: keyword matching does not normalise Unicode, so a decomposed (NFD) keyword typed on some keyboards never matches the composed (NFC) setting, severity low
  it.fails('matches a custom keyword typed in decomposed Unicode form', () => {
    const composed = 'confirm\u00E9'
    const decomposed = 'confirme\u0301'
    expect(confirm(decomposed, {}, 'bob', composed).valid).toBe(true)
  })
})

describe('evaluateConfirmation: who may confirm', () => {
  it('rejects the trade comment author replying to their own comment', () => {
    expect(confirm('confirmed', { parentBody: 'Sold to u/alice' }, 'alice')).toEqual({ valid: false })
  })

  it('rejects a top-level comment, even with keyword and tag', () => {
    const result = evaluateConfirmation(
      { id: 't1_top', body: 'confirmed u/alice', authorName: 'bob', isRoot: true },
      ctxFor(),
    )
    expect(result).toEqual({ valid: false })
  })

  it('rejects a reply to a reply, a missing parent, a removed parent and a parent with no author', () => {
    expect(confirm('confirmed', { parentIsRoot: false })).toEqual({ valid: false })
    expect(confirm('confirmed', { parentExists: false })).toEqual({ valid: false })
    expect(confirm('confirmed', { parentIsBanned: true })).toEqual({ valid: false })
    expect(confirm('confirmed', { parentIsProcessable: false })).toEqual({ valid: false })
  })

  it('asks an untagged replier to be tagged, naming the trade comment author', () => {
    expect(confirm('confirmed', {}, 'carol')).toEqual({
      valid: false,
      reason: 'cant_confirm_username',
      parentAuthor: 'alice',
    })
  })

  it('on an old thread answers with the old-thread reason before looking at the tag or keyword', () => {
    expect(confirm('confirmed', { isCurrentSubmission: false }).reason).toBe('old_confirmation_thread')
    expect(confirm('confirmed', { isCurrentSubmission: false }, 'carol').reason).toBe('old_confirmation_thread')
  })

  it('does not confirm for a moderator differently from anyone else', () => {
    expect(confirm('confirmed', { parentAuthorName: 'mod1', parentBody: 'Sold to u/bob' })).toMatchObject({
      valid: true,
      parentAuthor: 'mod1',
      confirmer: 'bob',
    })
  })

  // BUG: the self-confirm check compares account names case-sensitively, so "Alice" replying to "alice" is not recognised as the same user, severity low
  it.fails('rejects a self-confirmation that differs only in the case of the account name', () => {
    const result = confirm('confirmed', { parentAuthorName: 'Alice', parentBody: 'Sold to u/alice' }, 'alice')
    expect(result.valid).toBe(false)
  })

})

describe('getLanguageSettings', () => {
  const settingsWith = (values: Record<string, unknown>) => ({
    settings: { get: async <T>(name: string) => values[name] as T | undefined },
  })

  it('falls back to the defaults when the keyword is blank, whitespace or not a string', async () => {
    for (const value of ['', '   ', '\n\t', undefined, null, 42, true]) {
      const settings = await getLanguageSettings(settingsWith({ confirmation_keyword: value }))
      expect(settings.confirmationKeyword).toBe(DEFAULT_LANGUAGE_SETTINGS.confirmationKeyword)
    }
  })

  it('trims a configured keyword', async () => {
    const settings = await getLanguageSettings(settingsWith({ confirmation_keyword: '  Best\u00E4tigt \n' }))
    expect(settings.confirmationKeyword).toBe('Best\u00E4tigt')
  })

  it('falls back to the defaults when reading a setting throws', async () => {
    const settings = await getLanguageSettings({ settings: { get: async () => { throw new Error('boom') } } })
    expect(settings).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })

  it('falls back to the defaults when the context has no settings', async () => {
    expect(await getLanguageSettings({})).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })
})
