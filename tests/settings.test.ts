import { describe, expect, it, vi } from 'vitest'
import {
  appSettings,
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  renderTemplate,
  renderTitle,
  tradeFlairText,
} from '../src/settings.js'

function mockContext(values: Record<string, unknown> | ((name: string) => unknown) | { throws: true }) {
  const get = typeof values === 'function'
    ? vi.fn(async (name: string) => values(name))
    : 'throws' in values
      ? vi.fn(async () => { throw new Error('settings unavailable') })
      : vi.fn(async (name: string) => values[name])
  return {
    settings: {
      get: async <T,>(name: string): Promise<T | undefined> => get(name) as Promise<T | undefined>,
    },
  }
}

describe('getAppSettings', () => {
  it('returns defaults when settings are missing', async () => {
    await expect(getAppSettings({})).resolves.toEqual(DEFAULT_APP_SETTINGS)
  })

  it('trims populated string overrides and falls back for blanks', async () => {
    const settings = await getAppSettings(mockContext({
      confirmation_keyword: '  confirmado  ',
      flair_count_label: '  Trades done:  ',
      monthly_post_title: '   ',
      date_locale: 'es-ES',
    }))

    expect(settings.confirmationKeyword).toBe('confirmado')
    expect(settings.flairCountLabel).toBe('Trades done:')
    expect(settings.monthlyPostTitle).toBe(DEFAULT_APP_SETTINGS.monthlyPostTitle)
    expect(settings.dateLocale).toBe('es-ES')
  })

  it('falls back to defaults when settings reads fail', async () => {
    await expect(getAppSettings(mockContext({ throws: true }))).resolves.toEqual(DEFAULT_APP_SETTINGS)
  })
})

describe('appSettings', () => {
  it('exposes settings that are still used by the greenfield app', () => {
    expect(appSettings.map(setting => setting.name)).toEqual([
      'monthly_post_title',
      'monthly_post',
      'monthly_post_flair_id',
      'confirmation_keyword',
      'flair_count_label',
      'date_locale',
      'trade_confirmation',
      'already_confirmed',
      'old_confirmation_thread',
      'cant_confirm_username',
      'same_user_confirmation',
    ])
  })
})

describe('template rendering', () => {
  it('renders title strftime placeholders with locale support', () => {
    const date = new Date(Date.UTC(2026, 4, 1, 0, 0, 0))

    expect(renderTitle('%B %Y', date)).toBe('May 2026')
    expect(renderTitle('%B %Y', date, 'es-ES')).toBe('mayo 2026')
  })

  it('replaces simple and dotted template variables', () => {
    expect(renderTemplate('hello {user.name}', { user: { name: 'alice' } })).toBe('hello alice')
  })

  it('keeps unknown template variables intact', () => {
    expect(renderTemplate('hello {missing}', {})).toBe('hello {missing}')
  })
})

describe('tradeFlairText', () => {
  it('formats trade flair with the configured label', () => {
    expect(tradeFlairText(7)).toBe('Trades: 7')
    expect(tradeFlairText(7, 'Deals:')).toBe('Deals: 7')
  })
})
