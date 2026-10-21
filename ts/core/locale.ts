// The device's language among the ones Pluck speaks: the first of the
// browser's preferred languages we support, matched by its prefix (it-IT,
// it-CH → it); anything else is English. Takes the list so Node can check it.

export type Language = 'en' | 'it'

export const LANGUAGES: Language[] = ['en', 'it']

export function deviceLanguage(languages: readonly string[] = globalThis.navigator?.languages ?? []): Language {
	for (const tag of languages) {
		const prefix = tag.toLowerCase().split('-')[0] as Language
		if (LANGUAGES.includes(prefix)) return prefix
	}
	return 'en'
}
