export type Locale = 'zh' | 'en'

const LEGACY_LOCALE_KEY = 'canvas-prompt-locale'
const LOCALE_PREFERENCE_KEY = 'canvas-prompt-locale-preference'

type LocaleStorage = Pick<Storage, 'getItem' | 'setItem'>

function isLocale(value: string | null): value is Locale {
  return value === 'zh' || value === 'en'
}

export function detectLocale(languages?: readonly string[], language?: string): Locale {
  const primaryLanguage = languages?.find((value) => value.trim().length > 0) ?? language ?? ''
  return /^zh(?:[-_]|$)/i.test(primaryLanguage.trim()) ? 'zh' : 'en'
}

export function resolveInitialLocale(storage: LocaleStorage, languages?: readonly string[], language?: string): Locale {
  const preference = storage.getItem(LOCALE_PREFERENCE_KEY)
  if (isLocale(preference)) return preference

  // Older releases wrote the automatic default to this key. Only `en` was a
  // deliberate choice in those releases, because their automatic default was
  // always Chinese. Let legacy `zh` follow the host language from now on.
  if (storage.getItem(LEGACY_LOCALE_KEY) === 'en') return 'en'
  return detectLocale(languages, language)
}

export function saveLocalePreference(storage: LocaleStorage, locale: Locale) {
  storage.setItem(LOCALE_PREFERENCE_KEY, locale)
  // Keep the old key aligned for users updating from an earlier release.
  storage.setItem(LEGACY_LOCALE_KEY, locale)
}
