export interface AppSettings {
  monthlyPostTitle: string
  monthlyPost: string
  monthlyPostFlairId: string
  confirmationKeyword: string
  flairCountLabel: string
  dateLocale: string
  tradeConfirmation: string
  alreadyConfirmed: string
  oldConfirmationThread: string
  cantConfirmUsername: string
  sameUserConfirmation: string
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  monthlyPostTitle: '%B %Y Confirmed Trade Thread',
  monthlyPost: [
    'Submit your trade confirmations below.',
    '',
    '* [Previous monthly thread]({previous_month_submission.permalink})',
    '* [Full List of Subreddit Rules](https://www.reddit.com/r/{subreddit_name}/wiki/rules/)',
    '* [Message the Moderators](https://www.reddit.com/message/compose?to=/r/{subreddit_name})',
    '',
    'Reply `{confirmation_keyword}` to a trade comment when the trade is complete.',
  ].join('\n'),
  monthlyPostFlairId: '',
  confirmationKeyword: 'confirmed',
  flairCountLabel: 'Trades:',
  dateLocale: 'en-US',
  tradeConfirmation: [
    '[`u/{confirmer}`](https://reddit.com/u/{confirmer}) updated from `{old_comment_flair}` to `{new_comment_flair}`',
    '',
    '[`u/{parent_author}`](https://reddit.com/u/{parent_author}) updated from `{old_parent_flair}` to `{new_parent_flair}`',
  ].join('\n'),
  alreadyConfirmed: 'This trade has already been confirmed, so this comment was not counted.',
  oldConfirmationThread: 'This confirmation was not counted because it is not in the current trade thread.',
  cantConfirmUsername: [
    'You can not confirm this trade; your username was not specified.',
    '',
    'The comment by `u/{parent_author}` must tag you using the format `u/{author_name}` for you to confirm.',
  ].join('\n'),
  sameUserConfirmation: 'This confirmation was not counted because users cannot confirm their own trade.',
}

type AppSettingName =
  | 'monthly_post_title'
  | 'monthly_post'
  | 'monthly_post_flair_id'
  | 'confirmation_keyword'
  | 'flair_count_label'
  | 'date_locale'
  | 'trade_confirmation'
  | 'already_confirmed'
  | 'old_confirmation_thread'
  | 'cant_confirm_username'
  | 'same_user_confirmation'

interface SettingDefinition {
  name: AppSettingName
  type: 'string' | 'paragraph'
  label: string
  defaultValue: string
}

export const appSettings: SettingDefinition[] = [
  { name: 'monthly_post_title', type: 'string', label: 'Monthly post title (strftime)', defaultValue: DEFAULT_APP_SETTINGS.monthlyPostTitle },
  { name: 'monthly_post', type: 'paragraph', label: 'Monthly post body', defaultValue: DEFAULT_APP_SETTINGS.monthlyPost },
  { name: 'monthly_post_flair_id', type: 'string', label: 'Optional submission flair ID', defaultValue: DEFAULT_APP_SETTINGS.monthlyPostFlairId },
  { name: 'confirmation_keyword', type: 'string', label: 'Confirmation keyword', defaultValue: DEFAULT_APP_SETTINGS.confirmationKeyword },
  { name: 'flair_count_label', type: 'string', label: 'Flair count label', defaultValue: DEFAULT_APP_SETTINGS.flairCountLabel },
  { name: 'date_locale', type: 'string', label: 'Date locale for month names', defaultValue: DEFAULT_APP_SETTINGS.dateLocale },
  { name: 'trade_confirmation', type: 'paragraph', label: 'Trade confirmation reply', defaultValue: DEFAULT_APP_SETTINGS.tradeConfirmation },
  { name: 'already_confirmed', type: 'paragraph', label: 'Already-confirmed reply', defaultValue: DEFAULT_APP_SETTINGS.alreadyConfirmed },
  { name: 'old_confirmation_thread', type: 'paragraph', label: 'Old-thread reply', defaultValue: DEFAULT_APP_SETTINGS.oldConfirmationThread },
  { name: 'cant_confirm_username', type: 'paragraph', label: 'Missing username reply', defaultValue: DEFAULT_APP_SETTINGS.cantConfirmUsername },
  { name: 'same_user_confirmation', type: 'paragraph', label: 'Self-confirmation reply', defaultValue: DEFAULT_APP_SETTINGS.sameUserConfirmation },
]

interface SettingsContext {
  settings?: {
    get<T>(name: string): Promise<T | undefined>
  }
}

export async function getAppSettings(ctx: SettingsContext): Promise<AppSettings> {
  return {
    monthlyPostTitle: await readSetting(ctx, 'monthly_post_title', DEFAULT_APP_SETTINGS.monthlyPostTitle),
    monthlyPost: await readSetting(ctx, 'monthly_post', DEFAULT_APP_SETTINGS.monthlyPost),
    monthlyPostFlairId: await readSetting(ctx, 'monthly_post_flair_id', DEFAULT_APP_SETTINGS.monthlyPostFlairId),
    confirmationKeyword: await readSetting(ctx, 'confirmation_keyword', DEFAULT_APP_SETTINGS.confirmationKeyword),
    flairCountLabel: await readSetting(ctx, 'flair_count_label', DEFAULT_APP_SETTINGS.flairCountLabel),
    dateLocale: await readSetting(ctx, 'date_locale', DEFAULT_APP_SETTINGS.dateLocale),
    tradeConfirmation: await readSetting(ctx, 'trade_confirmation', DEFAULT_APP_SETTINGS.tradeConfirmation),
    alreadyConfirmed: await readSetting(ctx, 'already_confirmed', DEFAULT_APP_SETTINGS.alreadyConfirmed),
    oldConfirmationThread: await readSetting(ctx, 'old_confirmation_thread', DEFAULT_APP_SETTINGS.oldConfirmationThread),
    cantConfirmUsername: await readSetting(ctx, 'cant_confirm_username', DEFAULT_APP_SETTINGS.cantConfirmUsername),
    sameUserConfirmation: await readSetting(ctx, 'same_user_confirmation', DEFAULT_APP_SETTINGS.sameUserConfirmation),
  }
}

async function readSetting(ctx: SettingsContext, name: AppSettingName, fallback: string): Promise<string> {
  try {
    const value = await ctx.settings?.get<string>(name)
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed || fallback
  } catch {
    return fallback
  }
}

export function tradeFlairText(count: number, label = DEFAULT_APP_SETTINGS.flairCountLabel): string {
  return `${label} ${count}`
}

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (match, key) => {
    let value: unknown = vars
    for (const part of key.split('.')) {
      if (!value || typeof value !== 'object') return match
      value = (value as Record<string, unknown>)[part]
    }
    return value === undefined || value === null ? match : String(value)
  })
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

export function renderTitle(
  template: string,
  date: Date,
  locale = DEFAULT_APP_SETTINGS.dateLocale,
): string {
  return template
    .replace(/%B/g, date.toLocaleString(locale, { month: 'long', timeZone: 'UTC' }))
    .replace(/%b/g, date.toLocaleString(locale, { month: 'short', timeZone: 'UTC' }))
    .replace(/%Y/g, String(date.getUTCFullYear()))
    .replace(/%y/g, String(date.getUTCFullYear()).slice(-2))
    .replace(/%m/g, pad2(date.getUTCMonth() + 1))
    .replace(/%d/g, pad2(date.getUTCDate()))
}
