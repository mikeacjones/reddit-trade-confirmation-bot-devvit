import { describe, it, expect } from 'vitest'
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
})
