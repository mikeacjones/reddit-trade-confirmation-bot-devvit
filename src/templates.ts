export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (m, k) => {
    let v: unknown = vars
    for (const part of k.split('.')) {
      if (v && typeof v === 'object') v = (v as Record<string, unknown>)[part]
      else return m
    }
    return v == null ? m : String(v)
  })
}

import { DEFAULT_LANGUAGE_SETTINGS } from './language.js'

const pad2 = (n: number) => String(n).padStart(2, '0')

// The date_locale setting is free text a moderator types. Accept the common "en_US" spelling by
// turning underscores into hyphens, and fall back to the default locale (with a log line) when the
// value is still not a valid BCP 47 tag, so a bad setting cannot stop the monthly thread being created.
export function resolveLocale(locale: string): string {
  const fallback = DEFAULT_LANGUAGE_SETTINGS.dateLocale
  const normalised = String(locale ?? '').trim().replace(/_/g, '-')
  try {
    const [canonical] = Intl.getCanonicalLocales(normalised)
    if (canonical) return canonical
  } catch {
    // fall through to the default
  }
  console.warn(`Invalid date_locale setting ${JSON.stringify(locale)}, using ${fallback}`)
  return fallback
}

export function renderTitle(
  template: string,
  d: Date,
  locale: string = DEFAULT_LANGUAGE_SETTINGS.dateLocale,
): string {
  const loc = resolveLocale(locale)
  return template
    .replace(/%B/g, d.toLocaleString(loc, { month: 'long', timeZone: 'UTC' }))
    .replace(/%b/g, d.toLocaleString(loc, { month: 'short', timeZone: 'UTC' }))
    .replace(/%Y/g, String(d.getUTCFullYear()))
    .replace(/%y/g, String(d.getUTCFullYear()).slice(-2))
    .replace(/%m/g, pad2(d.getUTCMonth() + 1))
    .replace(/%d/g, pad2(d.getUTCDate()))
}
