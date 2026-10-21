// Self-check for the translations (ts/core/i18n.ts, ts/i18n/*.ts): every
// literal t() / plural() key in ts/ has an Italian entry, every entry keeps
// its key's {placeholders}, and the lookup, plural and number helpers behave.
// index.html's text is checked in the browser (tests/visual/i18n.spec.ts).
// Run with `npm run check:i18n`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { english, num, plural, t, useLanguage, type PluralForms } from '../ts/core/i18n.ts'
import { it } from '../ts/i18n/it.ts'
import { CHORD_TYPES } from '../ts/music/chord-theory.ts'
import { CHORD_GROUPS } from '../ts/music/chord-library.ts'
import { SCALE_TYPES } from '../ts/music/scales.ts'
import { PROGRESSIONS } from '../ts/music/harmony.ts'
import { INTERVALS, QUALITIES } from '../ts/music/ear.ts'
import { TUNINGS } from '../ts/music/tuning.ts'
import { check, finish } from './check.ts'

/* Helpers ------------------------------------------------------------------ */
check('English is the key', t('Match this note') === 'Match this note')
check('context dropped in English', t('string|Open') === 'Open' && english('string|Open') === 'Open')
check('placeholders filled', t('Find {note}', { note: 'C' }) === 'Find C')
check('plural, English', plural(1, '{n} change', '{n} changes') === '1 change' && plural(3, '{n} change', '{n} changes') === '3 changes')
check('number, English', num(196, 1) === '196.0' && num(-3) === '-3')
useLanguage('it', { 'Find {note}': 'Trova {note}', '{n} changes': { one: '{n} cambio', other: '{n} cambi' } })
check('Italian lookup', t('Find {note}', { note: 'Do' }) === 'Trova Do')
check('missing: English', t('Nowhere') === 'Nowhere' && t('ctx|Nowhere') === 'Nowhere')
check('plural, Italian', plural(1, '{n} change', '{n} changes') === '1 cambio' && plural(0, '{n} change', '{n} changes') === '0 cambi')
check('number, Italian', num(196, 1) === '196,0')
useLanguage('en')

/* Keys used in ts/ --------------------------------------------------------- */
const files: string[] = []
const walk = (dir: string) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) walk(path)
		else if (path.endsWith('.ts') && !path.includes('i18n')) files.push(path)
	}
}
walk('ts')

// A quoted literal: '…', "…" or `…` without ${}.
const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|` + '`([^`$\\\\]*)`'
const unquote = (m: RegExpExecArray, at: number) => (m[at] ?? m[at + 1] ?? m[at + 2]).replace(/\\(.)/g, '$1')
const used = new Map<string, string>()
for (const file of files) {
	const src = readFileSync(file, 'utf8')
	for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*(?:${LITERAL})`, 'g'))) used.set(unquote(m, 1), file)
	for (const m of src.matchAll(new RegExp(String.raw`\bplural\(\s*[^,]+,\s*(?:${LITERAL})\s*,\s*(?:${LITERAL})`, 'g'))) {
		used.set(unquote(m, 4), file)
		used.set(`plural:${unquote(m, 1)}`, file)
	}
}

// Names the views pass through t() from tables (t(type.name)): the same rule.
const tables: [string, string[]][] = [
	['CHORD_TYPES', CHORD_TYPES.map((type) => type.name)],
	['CHORD_GROUPS', CHORD_GROUPS.map((group) => group.label)],
	['SCALE_TYPES', SCALE_TYPES.flatMap((type) => [type.name, ...(type.aka ? [type.aka] : [])])],
	['PROGRESSIONS', PROGRESSIONS.map((progression) => progression.name)],
	['INTERVALS', INTERVALS.map((interval) => `interval|${interval.name}`)],
	['QUALITIES', QUALITIES.map((quality) => quality.name)],
	['TUNINGS', TUNINGS.map((tuning) => tuning.name)],
]
for (const [table, names] of tables) for (const name of names) used.set(name, table)

let missing = 0
for (const [key, file] of used) {
	if (key.startsWith('plural:')) continue
	if (!(key in it)) {
		missing++
		check(`Italian for "${key}"`, false, file)
	}
}
check(`every t() / plural() key of ts/ has Italian (${used.size} keys)`, missing === 0, `${missing} missing`)

/* Entries ------------------------------------------------------------------ */
// {n} may go from a plural's forms ("un cambio"); every other placeholder stays.
const holes = (text: string, plural: boolean) =>
	[...text.matchAll(/\{(\w+)\}/g)]
		.map((m) => m[1])
		.filter((name) => !plural || name !== 'n')
		.sort()
		.join()
let broken = 0
for (const [key, value] of Object.entries(it)) {
	const isPlural = typeof value !== 'string'
	const want = holes(english(key), isPlural)
	for (const form of isPlural ? Object.values(value as PluralForms) : [value]) {
		if (!form.trim()) check(`"${key}": not empty`, false)
		if (
			holes(form, isPlural)
				.replace(/\b[A-G]\b,?/g, '')
				.replace(/,$/, '') !== want
		) {
			broken++
			check(`"${key}": placeholders {${want}}`, false, form)
		}
	}
}
check(`every Italian entry keeps its placeholders (${Object.keys(it).length} entries)`, broken === 0)

// Entries nothing asks for: written in index.html (text, attributes) or used in ts/.
const html = readFileSync('index.html', 'utf8').replace(/\s+/g, ' ').replace(/&amp;/g, '&')
const unused = Object.keys(it).filter((key) => !used.has(key) && !html.includes(english(key)))
console.log(unused.length ? `note: ${unused.length} Italian entries look unused: ${unused.slice(0, 20).join(' | ')}` : 'no unused Italian entries')

finish('i18n ok')
