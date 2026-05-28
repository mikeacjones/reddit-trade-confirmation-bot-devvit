export interface LanguageSettings {
  confirmationKeyword: string
  approvalKeyword: string
  flairCountLabel: string
  moderatorFlairPrefix: string
  dateLocale: string
}

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  confirmationKeyword: 'confirmed',
  approvalKeyword: 'approved',
  flairCountLabel: 'Trades:',
  moderatorFlairPrefix: 'Moderator',
  dateLocale: 'en-US',
}

interface SettingsCarrier {
  settings?: {
    get<T>(name: string): Promise<T | undefined>
  }
}

export async function getLanguageSettings(ctx: SettingsCarrier): Promise<LanguageSettings> {
  const read = async (name: string): Promise<string | undefined> => {
    try {
      const value = await ctx.settings?.get<string>(name)
      return typeof value === 'string' ? value.trim() : undefined
    } catch {
      return undefined
    }
  }
  return {
    confirmationKeyword: (await read('confirmation_keyword')) || DEFAULT_LANGUAGE_SETTINGS.confirmationKeyword,
    approvalKeyword: (await read('approval_keyword')) || DEFAULT_LANGUAGE_SETTINGS.approvalKeyword,
    flairCountLabel: (await read('flair_count_label')) || DEFAULT_LANGUAGE_SETTINGS.flairCountLabel,
    moderatorFlairPrefix: (await read('moderator_flair_prefix')) || DEFAULT_LANGUAGE_SETTINGS.moderatorFlairPrefix,
    dateLocale: (await read('date_locale')) || DEFAULT_LANGUAGE_SETTINGS.dateLocale,
  }
}
