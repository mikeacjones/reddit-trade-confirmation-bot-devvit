/**
 * Adversarial probes for the pure parts of the flair pipeline: src/rules.ts (template lookup, flair
 * formatting, count parsing), src/utils.ts (stored-count parsing), src/templates.ts and the template
 * parsing in src/flairCache.ts. Scenario probes (the same modules driven through the app) are in
 * tests/scenarios/flairAudit.test.ts.
 *
 * A probe that shows the code is correct is a normal test. A probe that shows a bug is an `it.fails`
 * repro with a `// BUG: <description>, severity <level>` comment: it keeps CI green and turns red
 * once the bug is fixed (then drop the `.fails`).
 */
import { describe, expect, it } from 'vitest'
import { findFlairTemplate, formatFlairFromTemplate, parseTradeCount, type FlairTemplate } from '../src/rules'
import { parseStoredCount } from '../src/utils'
import { render, renderTitle } from '../src/templates'
import { loadFlairTemplates, refreshFlairTemplateCache } from '../src/flairCache'

const tpl = (id: string, modOnly = false): FlairTemplate => ({ id, template: `Trades: ${id}`, modOnly })
const ranges = (entries: Array<[number, number, FlairTemplate]>) =>
  new Map<[number, number], FlairTemplate>(entries.map(([min, max, t]) => [[min, max], t]))

describe('findFlairTemplate: range boundaries', () => {
  const map = ranges([[0, 99, tpl('low')], [100, 199, tpl('mid')], [200, 99999, tpl('top')]])
  const idAt = (count: number, mod = false) => findFlairTemplate(map, count, mod)?.id ?? null

  it('includes both ends of every range', () => {
    expect([0, 99, 100, 199, 200, 99999].map(c => idAt(c))).toEqual(['low', 'low', 'mid', 'mid', 'top', 'top'])
  })

  it('finds nothing below the first range, above the last range, or for a negative or NaN count', () => {
    expect([-1, 100000, NaN, Infinity].map(c => idAt(c))).toEqual([null, null, null, null])
  })

  it('does not match a fractional count that falls between two adjacent ranges', () => {
    expect(idAt(99.5)).toBeNull()
  })

  it('finds nothing in a gap between ranges, and the ends of the gap still match', () => {
    const gappy = ranges([[0, 49, tpl('a')], [100, 199, tpl('b')]])
    expect(findFlairTemplate(gappy, 49, false)?.id).toBe('a')
    expect(findFlairTemplate(gappy, 50, false)).toBeNull()
    expect(findFlairTemplate(gappy, 99, false)).toBeNull()
    expect(findFlairTemplate(gappy, 100, false)?.id).toBe('b')
  })

  it('does not depend on the order the ranges were listed in', () => {
    const shuffled = ranges([[200, 99999, tpl('top')], [0, 99, tpl('low')], [100, 199, tpl('mid')]])
    expect([0, 99, 100, 199, 200, 99999].map(c => findFlairTemplate(shuffled, c, false)?.id)).toEqual(['low', 'low', 'mid', 'mid', 'top', 'top'])
  })

  it('picks the first listed template when ranges overlap (listing order, not the narrowest or the highest)', () => {
    const overlap = ranges([[0, 100, tpl('first')], [100, 199, tpl('second')], [50, 150, tpl('third')]])
    expect(findFlairTemplate(overlap, 100, false)?.id).toBe('first')
    expect(findFlairTemplate(overlap, 101, false)?.id).toBe('second')
    expect(findFlairTemplate(overlap, 50, false)?.id).toBe('first')
  })

  it('never matches an inverted range (min above max)', () => {
    expect(findFlairTemplate(ranges([[10, 5, tpl('bad')]]), 7, false)).toBeNull()
  })

  it('matches a single-value range', () => {
    expect(findFlairTemplate(ranges([[7, 7, tpl('seven')]]), 7, false)?.id).toBe('seven')
  })
})

describe('findFlairTemplate: mod-only templates', () => {
  const map = ranges([[0, 99999, tpl('mod', true)], [0, 99, tpl('user')], [100, 99999, tpl('user-top')]])

  it('gives a moderator only mod-only templates and a non-moderator only the others', () => {
    expect(findFlairTemplate(map, 5, true)?.id).toBe('mod')
    expect(findFlairTemplate(map, 5, false)?.id).toBe('user')
    expect(findFlairTemplate(map, 500, true)?.id).toBe('mod')
    expect(findFlairTemplate(map, 500, false)?.id).toBe('user-top')
  })

  it('never hands a non-moderator a mod-only template, even when it is the only one that covers the count', () => {
    const onlyMod = ranges([[0, 99999, tpl('mod', true)]])
    expect(findFlairTemplate(onlyMod, 5, false)).toBeNull()
  })

  it('gives a moderator nothing when no mod-only template covers the count', () => {
    const onlyUser = ranges([[0, 99999, tpl('user')]])
    expect(findFlairTemplate(onlyUser, 5, true)).toBeNull()
  })
})

describe('formatFlairFromTemplate', () => {
  it('replaces the range with the count and keeps the surrounding text', () => {
    expect(formatFlairFromTemplate('Trades: 100-199', 150)).toBe('Trades: 150')
    expect(formatFlairFromTemplate('Moderator | Trades: 0-99999 ⭐', 7)).toBe('Moderator | Trades: 7 ⭐')
  })

  it('returns a template without a range unchanged', () => {
    expect(formatFlairFromTemplate('Just a flair', 5)).toBe('Just a flair')
  })

  it('only rewrites the first range when the text repeats the label', () => {
    expect(formatFlairFromTemplate('Trades: 0-99 / Trades: 100-199', 5)).toBe('Trades: 5 / Trades: 100-199')
  })

  it('treats a custom label literally, including regex metacharacters', () => {
    expect(formatFlairFromTemplate('Swaps (all): 0-99', 5, 'Swaps (all):')).toBe('Swaps (all): 5')
    expect(formatFlairFromTemplate('Swaps xall: 0-99', 5, 'Swaps (all):')).toBe('Swaps xall: 0-99')
  })

  it('writes the count as a plain decimal for zero and large safe integers', () => {
    expect(formatFlairFromTemplate('Trades: 0-99', 0)).toBe('Trades: 0')
    expect(formatFlairFromTemplate('Trades: 0-99', Number.MAX_SAFE_INTEGER)).toBe(`Trades: ${Number.MAX_SAFE_INTEGER}`)
  })
})

describe('parseTradeCount: reading a count back from existing flair text', () => {
  it('reads no flair and an empty flair as zero trades', () => {
    expect([undefined, null, ''].map(t => parseTradeCount(t))).toEqual([0, 0, 0])
  })

  it('reads whitespace-only flair as an unparseable count rather than zero', () => {
    expect(parseTradeCount('   ')).toBeNull()
  })

  it('reads the count with the label anywhere in the text, including after a moderator prefix', () => {
    expect(parseTradeCount('Trades: 12')).toBe(12)
    expect(parseTradeCount('Moderator | Trades: 7')).toBe(7)
    expect(parseTradeCount('Trades: 12 | Plane spotter')).toBe(12)
  })

  it('does not read custom flair text without the label as a count', () => {
    expect(parseTradeCount('Plane spotter ✈')).toBeNull()
    expect(parseTradeCount('12 trades')).toBeNull()
  })

  it('does not read a template range as a count', () => {
    expect(parseTradeCount('Trades: 100-199')).toBeNull()
    expect(parseTradeCount('Moderator | Trades: 0-99999')).toBeNull()
  })

  it('needs the label to match exactly, including case and the space after it', () => {
    expect(parseTradeCount('trades: 12')).toBeNull()
    expect(parseTradeCount('Trades:12')).toBeNull()
  })

  it('reads a flair written with a different label as unparseable', () => {
    expect(parseTradeCount('Trades: 12', 'Swaps:')).toBeNull()
  })
})

describe('parseStoredCount', () => {
  it('parses plain integers, zero and surrounding whitespace', () => {
    expect([parseStoredCount('0'), parseStoredCount('42'), parseStoredCount(' 7')]).toEqual([0, 42, 7])
  })

  it('returns null for a missing or non-numeric value', () => {
    expect([undefined, '', 'abc', 'NaN', 'Infinity'].map(v => parseStoredCount(v))).toEqual([null, null, null, null, null])
  })

  it('reads a negative stored count as negative (callers then find no template for it)', () => {
    expect(parseStoredCount('-5')).toBe(-5)
  })

  it('truncates a fractional value and ignores trailing text', () => {
    expect(parseStoredCount('7.9')).toBe(7)
    expect(parseStoredCount('12abc')).toBe(12)
  })

  // BUG: parseStoredCount reads exponent notation as its leading digits, so a count of 1e21 or more (formatFlairFromTemplate writes it as "1e+21") is read back as 1, severity low
  it.fails('does not read "1e+21" as a count of 1', () => {
    expect(parseStoredCount('1e+21')).not.toBe(1)
  })
})

describe('render (src/templates.ts)', () => {
  it('leaves unknown, partial and malformed placeholders alone', () => {
    expect(render('{a} {b.c} {d e} {}', { a: 1, b: {} })).toBe('1 {b.c} {d e} {}')
  })

  it('does not expand placeholders that appear inside a substituted value', () => {
    expect(render('{a}', { a: '{b}', b: 'boom' })).toBe('{b}')
  })

  it('inserts values containing replacement patterns literally', () => {
    expect(render('x {a} y', { a: '$& $1 $$' })).toBe('x $& $1 $$ y')
  })

  it('leaves a placeholder alone when the value is null or undefined, and prints zero and false', () => {
    expect(render('{a}|{b}|{c}|{d}', { a: null, b: undefined, c: 0, d: false })).toBe('{a}|{b}|0|false')
  })

  // BUG: render walks the prototype chain, so a placeholder such as {constructor} or {toString} prints native function source into the comment, severity low
  it.fails('leaves {constructor} unrendered because it is not a template variable', () => {
    expect(render('{constructor}', {})).toBe('{constructor}')
  })
})

describe('renderTitle (src/templates.ts)', () => {
  const date = new Date(Date.UTC(2025, 2, 5, 23, 59, 59))

  it('formats in UTC at the very end of the day and pads month and day', () => {
    expect(renderTitle('%Y-%m-%d', date)).toBe('2025-03-05')
    expect(renderTitle('%y', date)).toBe('25')
  })

  it('uses the configured locale for month names', () => {
    expect(renderTitle('%B', date, 'de-DE')).toBe('März')
  })

  it('leaves unknown directives alone', () => {
    expect(renderTitle('%Q %%', date)).toBe('%Q %%')
  })

  // BUG: a locale written with an underscore (en_US) makes renderTitle throw a RangeError, so the monthly post cannot be created, severity medium
  it.fails('copes with a date_locale written as en_US instead of en-US', () => {
    expect(() => renderTitle('%B', date, 'en_US')).not.toThrow()
  })
})

describe('template parsing in flairCache', () => {
  function ctxWith(templates: Array<{ id: string; text: string; modOnly?: boolean }>, cached?: string) {
    const store = new Map<string, string>()
    if (cached !== undefined) store.set('flairTemplates:swaps:Trades%3A', cached)
    const ctx = {
      redis: { get: async (k: string) => store.get(k), set: async (k: string, v: string) => { store.set(k, v) } },
      settings: { get: async () => undefined },
      reddit: { getSubredditByName: async () => ({ getUserFlairTemplates: async () => templates }) },
    }
    return { ctx: ctx as any, store }
  }
  const keys = (m: Map<[number, number], FlairTemplate>) => [...m.keys()].map(k => k.join('-'))

  it('caches only templates of the form "<label> <min>-<max>", including mod-only and decorated ones', async () => {
    const { ctx } = ctxWith([
      { id: 'a', text: 'Trades: 0-99' },
      { id: 'b', text: 'Moderator | Trades: 0-99999', modOnly: true },
      { id: 'c', text: 'Trades: 100-199 ⭐' },
      { id: 'd', text: 'Trades: 900+' },
      { id: 'e', text: 'Trades: 900-' },
      { id: 'f', text: 'Trades:0-99' },
      { id: 'g', text: 'Verified trader' },
    ])
    const map = await refreshFlairTemplateCache(ctx, 'swaps')
    expect(keys(map)).toEqual(['0-99', '0-99999', '100-199'])
  })

  it('does not treat a template with no upper bound ("900+") as the top range', async () => {
    const { ctx } = ctxWith([{ id: 'a', text: 'Trades: 0-99' }, { id: 'top', text: 'Trades: 100+' }])
    const map = await refreshFlairTemplateCache(ctx, 'swaps')
    expect(findFlairTemplate(map, 5000, false)).toBeNull()
  })

  it('keeps two templates with the same range apart (one for moderators, one for everyone)', async () => {
    const { ctx } = ctxWith([
      { id: 'user', text: 'Trades: 0-99' },
      { id: 'mod', text: 'Moderator | Trades: 0-99', modOnly: true },
    ])
    const map = await refreshFlairTemplateCache(ctx, 'swaps')
    expect(findFlairTemplate(map, 5, false)?.id).toBe('user')
    expect(findFlairTemplate(map, 5, true)?.id).toBe('mod')
  })

  it('refreshes when the cache holds something that is not a template list', async () => {
    for (const bad of ['{}', 'null', '"x"', '[1]', '[{"min":"0","max":99,"id":"a","template":"T","modOnly":false}]', '[{"min":null,"max":99,"id":"a","template":"T","modOnly":false}]']) {
      const { ctx } = ctxWith([{ id: 'fresh', text: 'Trades: 0-99' }], bad)
      expect([bad, [...(await loadFlairTemplates(ctx, 'swaps')).values()].map(t => t.id)]).toEqual([bad, ['fresh']])
    }
  })

  it('treats a cached empty list as a valid hit and does not ask Reddit again', async () => {
    const { ctx } = ctxWith([{ id: 'fresh', text: 'Trades: 0-99' }], '[]')
    expect((await loadFlairTemplates(ctx, 'swaps')).size).toBe(0)
  })

  it('serves stale templates from the cache until it is refreshed, even when Reddit has changed', async () => {
    const { ctx } = ctxWith([{ id: 'new', text: 'Trades: 0-49' }], JSON.stringify([{ min: 0, max: 99, id: 'old', template: 'Trades: 0-99', modOnly: false }]))
    expect([...(await loadFlairTemplates(ctx, 'swaps')).values()].map(t => t.id)).toEqual(['old'])
    expect([...(await refreshFlairTemplateCache(ctx, 'swaps')).values()].map(t => t.id)).toEqual(['new'])
    expect([...(await loadFlairTemplates(ctx, 'swaps')).values()].map(t => t.id)).toEqual(['new'])
  })
})
