import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageSettings } from '../src/language'

function mockSettings(values: Record<string, unknown> | ((name: string) => unknown) | { throws: true }) {
  const get = typeof values === 'function'
    ? vi.fn(async (name: string) => values(name))
    : 'throws' in values
      ? vi.fn(async () => { throw new Error('boom') })
      : vi.fn(async (name: string) => values[name])
  return { settings: { get } } as any
}

describe('getLanguageSettings', () => {
  it('returns defaults when ctx has no settings', async () => {
    expect(await getLanguageSettings({})).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })

  it('returns defaults when every setting is unset', async () => {
    expect(await getLanguageSettings(mockSettings({}))).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })

  it('returns defaults when settings are blank strings', async () => {
    expect(await getLanguageSettings(mockSettings(() => '   '))).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })

  it('returns overrides when settings are populated', async () => {
    const ctx = mockSettings({
      confirmation_keyword: 'confirmado',
      approval_keyword: 'aprobado',
      flair_count_label: 'Negocios:',
      moderator_flair_prefix: 'Moderador',
      date_locale: 'es-ES',
    })
    expect(await getLanguageSettings(ctx)).toEqual({
      confirmationKeyword: 'confirmado',
      approvalKeyword: 'aprobado',
      flairCountLabel: 'Negocios:',
      moderatorFlairPrefix: 'Moderador',
      dateLocale: 'es-ES',
    })
  })

  it('trims whitespace from setting values', async () => {
    const result = await getLanguageSettings(mockSettings(() => '  bestätigt  '))
    expect(result.confirmationKeyword).toBe('bestätigt')
  })

  it('falls back to defaults if settings.get throws', async () => {
    expect(await getLanguageSettings(mockSettings({ throws: true }))).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })
})
