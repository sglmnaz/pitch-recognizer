// UI language. The English text is the key (gettext style): t('Match this
// note') looks the sentence up in the dictionary of the language in use and
// falls back to the English itself, so English needs no dictionary and a
// missing translation shows English, never a key. index.html stays written in
// English; ts/ui/translate.ts swaps its text at boot. Dictionaries live in
// ts/i18n/<lang>.ts. docs/adr/0010.
//
// - Placeholders: t('Find {note}', { note }).
// - Same English, different meaning: a context before a bar, 'string|Open'
//   (an open string) vs 'Open' (the key); English shows what follows the bar.
// - Plurals: plural(n, '{n} change', '{n} changes'); a dictionary gives the
//   other form's key an { one, other } entry (Intl.PluralRules picks).
//
// The language is set once at boot (ts/main.ts; a change reloads the app),
// English until then, so the Node checks always read English.
import type { Language } from './locale.ts'

export interface PluralForms {
	one: string
	other: string
	/** Languages with more forms (slavic, arabic) add them here. */
	few?: string
	many?: string
}

export type Dictionary = Record<string, string | PluralForms>

let language: Language = 'en'
let dictionary: Dictionary = {}
let rules = new Intl.PluralRules('en')

/** From now on t() and friends speak `lang`, from `words` (English needs none). */
export function useLanguage(lang: Language, words: Dictionary = {}) {
	language = lang
	dictionary = words
	rules = new Intl.PluralRules(lang)
}

export const currentLanguage = () => language

type Params = Record<string, string | number>

const fill = (text: string, params?: Params) =>
	params ? text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all)) : text

/** The English without its context: 'string|Open' → 'Open'. */
export const english = (key: string) => key.slice(key.indexOf('|') + 1)

/** The translation of `key`, or undefined when the dictionary has none (English never has one). */
export function lookup(key: string): string | undefined {
	const entry = dictionary[key]
	return typeof entry === 'string' ? entry : entry?.other
}

export function t(key: string, params?: Params): string {
	return fill(lookup(key) ?? english(key), params)
}

/** `n` with the right form: plural(3, '{n} change', '{n} changes') → '3 changes'. {n} is filled in, and `params` too. */
export function plural(n: number, one: string, other: string, params?: Params): string {
	const entry = dictionary[other]
	const form = rules.select(n) as keyof PluralForms
	const text = typeof entry === 'object' ? (entry[form] ?? entry.other) : typeof entry === 'string' ? entry : form === 'one' ? english(one) : english(other)
	return fill(text, { n, ...params })
}

/** A number in the language's own way: num(196, 1) → '196.0' / '196,0'. */
export const num = (value: number, digits = 0) =>
	new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value)
