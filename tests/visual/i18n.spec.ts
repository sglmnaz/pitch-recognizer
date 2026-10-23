import type { Page } from '@playwright/test'
import { it as italian } from '../../ts/i18n/it'
import { expect, settle, test } from './fixtures'

// Whatever still reads English in Italian. Every screen is opened twice, in
// English and in Italian, and the words are compared: a text or label that is
// the same in both is untranslated, unless the dictionary says it stays the
// same (an entry equal to its key: Tuner, Loop) or it is a name (the plates'
// model names, the brand). One project is enough.

const SCREENS: [string, Record<string, unknown>][] = [
	['#tuner', {}],
	['#tuner', { tunerMode: 'chromatic' }],
	['#chords', {}],
	['#chords', { chordsMode: 'library' }],
	['#chords', { chordsMode: 'identify' }],
	['#scales', {}],
	['#trainer', { trainerExercise: 'notes' }],
	['#trainer', { trainerExercise: 'intervals' }],
	['#trainer', { trainerExercise: 'chords' }],
	['#trainer', { trainerExercise: 'changes' }],
	['#trainer', { trainerExercise: 'changes', changesMode: 'time' }],
	['#trainer', { trainerExercise: 'tab' }],
	['#trainer', { trainerExercise: 'songs' }],
	['#metronome', {}],
	['#metronome', { metroTrainerOn: true }],
	['#settings', {}],
	['#calibration', {}],
]

const SAME = new Set([
	...Object.entries(italian).flatMap(([key, value]) => (value === key.slice(key.indexOf('|') + 1) ? [value] : [])),
	// Italian words spelled like an English one elsewhere on the page (the Scales tab, Scale;
	// the position chip's "Pos"), names written alike (the trainer's Do Re Mi line under C4).
	'Scale',
	'Pos',
	'Power chord (5)',
	// A composer's name (Trainer → Songs).
	'L. van Beethoven',
])
// Plate model names ("TUNER · TU-100", "SET-UP") and the brand.
const NAME = /^(PLUCK|Pluck|SET-UP|.*· [A-Z]{2,3}-\d+)$/
// Numbers and units, roman numerals, chord suffixes, interval ids, shapes, solfège names.
const TECH =
	/^(?:[\s\d·×+−–\-./%:,|()°#♯♭=♩→]|BPM|Hz|MS|ms|min|fr|maj7?|dim|aug|sus[24]|TT|[mMP]\d|[bIViv]+(?:maj)?\d?|x\d*|A4|(?:Do|Re|Mi|Fa|Sol|La|Si)[#b]?\d?)+$/

/** Every text and label of the page, hidden ones too, and of the guide pages it would show. */
async function words(page: Page, language: 'en' | 'it'): Promise<Set<string>> {
	const list = await page.evaluate((language) => {
		const out: string[] = []
		const add = (text: string | null) => {
			const key = (text ?? '').replace(/\s+/g, ' ').trim()
			if (/\p{L}{2}/u.test(key)) out.push(key)
		}
		const walk = (root: Node) => {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (node.nodeType === Node.TEXT_NODE) {
					if (!node.parentElement?.closest('script, style')) add(node.textContent)
					continue
				}
				const el = node as Element
				for (const name of ['aria-label', 'title', 'placeholder']) add(el.getAttribute(name))
			}
		}
		walk(document.body)
		for (const template of document.querySelectorAll<HTMLTemplateElement>('template[id^="help-"]')) {
			const own = template.id.endsWith(`-${language}`)
			const english = !/-[a-z]{2}$/.test(template.id.replace(/^help-/, ''))
			const translated = english && document.getElementById(`${template.id}-${language}`)
			if (own || (english && !translated)) {
				add(template.dataset.title ?? '')
				walk(template.content)
			}
		}
		return out
	}, language)
	return new Set(list)
}

test.describe('italian', () => {
	test.skip(({ locale }) => locale !== 'it-IT', 'Italian project only')

	for (const [hash, settings] of SCREENS) {
		test(`nothing left in English: ${hash} ${JSON.stringify(settings)}`, async ({ page, open }) => {
			await open(hash, { ...settings, language: 'en' })
			const english = await words(page, 'en')
			// The fixture seeds the settings on the first load only: switch the language and reload.
			await page.evaluate(() => {
				const key = 'pitch-recognizer:settings'
				localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), language: 'it' }))
			})
			await page.reload()
			await settle(page)
			const left = [...(await words(page, 'it'))].filter((word) => english.has(word) && !SAME.has(word) && !NAME.test(word) && !TECH.test(word))
			expect(left).toEqual([])
		})
	}
})
