import { describe, it, expect, vi } from 'vitest'
import { render, renderTitle } from '../src/templates'

describe('render', () => {
  it('substitutes simple keys', () => {
    expect(render('hello {name}', { name: 'world' })).toBe('hello world')
  })

  it('substitutes dotted keys via flatten', () => {
    expect(render('{a.b}', { a: { b: 'x' } })).toBe('x')
  })

  it('preserves unknown keys verbatim', () => {
    expect(render('{missing}', {})).toBe('{missing}')
  })

  it('coerces non-string values', () => {
    expect(render('count={n}', { n: 42 })).toBe('count=42')
  })

  it('handles multiple substitutions', () => {
    expect(render('{a} and {b}', { a: '1', b: '2' })).toBe('1 and 2')
  })
})

describe('renderTitle', () => {
  const date = new Date(Date.UTC(2025, 0, 7)) // Jan 7, 2025

  it('handles %B (full month)', () => {
    expect(renderTitle('%B', date)).toBe('January')
  })

  it('handles %b (short month)', () => {
    expect(renderTitle('%b', date)).toBe('Jan')
  })

  it('handles %Y (4-digit year)', () => {
    expect(renderTitle('%Y', date)).toBe('2025')
  })

  it('handles %y (2-digit year)', () => {
    expect(renderTitle('%y', date)).toBe('25')
  })

  it('handles %m (zero-padded month)', () => {
    expect(renderTitle('%m', date)).toBe('01')
  })

  it('handles %d (zero-padded day)', () => {
    expect(renderTitle('%d', date)).toBe('07')
  })

  it('combines codes', () => {
    expect(renderTitle('%B %Y', date)).toBe('January 2025')
  })

  it('renders month names in a non-English locale', () => {
    expect(renderTitle('%B', date, 'es-ES')).toBe('enero')
  })

  it('renders short month names in a non-English locale', () => {
    expect(renderTitle('%b', date, 'de-DE')).toBe('Jan')
  })

  it('falls back to en-US when no locale is given', () => {
    expect(renderTitle('%B', date)).toBe('January')
  })

  it('reads a locale written with an underscore as its hyphenated form', () => {
    expect(renderTitle('%B', date, 'es_ES')).toBe('enero')
    expect(renderTitle('%B', date, 'en_US')).toBe('January')
  })

  it('falls back to the default locale and logs when the locale is wholly invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(renderTitle('%B %Y', date, 'not a locale!!')).toBe('January 2025')
      expect(renderTitle('%b', date, '')).toBe('Jan')
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})
