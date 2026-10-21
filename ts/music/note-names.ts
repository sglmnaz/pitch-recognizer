// Display names of notes in the four systems Settings offers (the set MuseScore's
// chord symbols use): letters, fixed-do solfège (Italy, Spain, Latin America…),
// French solfège (accents) and German (H = B natural, B = B flat). Everything
// inside the app stays spelled in letters ('C#', 'Bb4', 'Am7'): ids, stored
// settings, records, VexFlow keys, logs. Only text shown to the player goes
// through here, so a name keeps the accidental style it came with ('#'/'b' or
// '♯'/'♭'). The system in use is set once at boot (ts/main.ts, from Settings →
// Appearance → Note names; a change reloads the app), letters until then, so
// the Node checks always read letters.

export type NoteSystem = 'letters' | 'solfege' | 'french' | 'german'

export const NOTE_SYSTEMS: NoteSystem[] = ['letters', 'solfege', 'french', 'german']

const SYLLABLES: Record<'solfege' | 'french', Record<string, string>> = {
	solfege: { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' },
	french: { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' },
}

const FLAT = /[b♭]/

/** One note letter with its accidentals, octave or chord suffix after it: 'C#', 'Bb4', 'F♯'. */
function formatOne(letter: string, accidentals: string, system: NoteSystem): string {
	if (system === 'letters') return letter + accidentals
	if (system !== 'german') return SYLLABLES[system][letter] + accidentals
	if (letter !== 'B') return letter + accidentals
	// German B is B flat, so B natural is H. A B with flats loses its first one
	// to the letter (Bbb = 'Bb': B flat, flattened again); sharps keep H (B# = H#).
	if (!FLAT.test(accidentals)) return `H${accidentals}`
	return `B${accidentals.slice(1)}`
}

const PART = /^([A-G])([#b♯♭]*)(.*)$/

/**
 * A spelled note, a pitch with its octave, a chord symbol or a slash pair
 * ('C#/Db', 'C#4/Db4', 'C/E') in `system`. Anything after the note letter and
 * its accidentals is kept: the octave, a chord suffix ('m7b5'). A part that
 * does not start with a note letter comes back as it is.
 */
export function formatNote(name: string, system: NoteSystem): string {
	if (system === 'letters') return name
	return name
		.split('/')
		.map((part) => {
			const match = PART.exec(part)
			return match ? formatOne(match[1], match[2], system) + match[3] : part
		})
		.join('/')
}

export interface SpokenWords {
	sharp: string
	flat: string
	or: string
}

/** A name as a screen reader should say it: 'C#/Db' → 'C sharp or D flat', 'Sib' → 'Si flat'. */
export function spokenNote(name: string, system: NoteSystem, words: SpokenWords = { sharp: 'sharp', flat: 'flat', or: 'or' }): string {
	return formatNote(name, system)
		.split('/')
		.map((part) => {
			const [, base, accidentals] = /^(.*?)([#b♯♭]*)$/.exec(part)!
			return [base, ...[...accidentals].map((a) => (a === '#' || a === '♯' ? words.sharp : words.flat))].join(' ')
		})
		.join(` ${words.or} `)
}

let current: NoteSystem = 'letters'

/** The system in use. */
export const noteSystem = () => current

/** The system noteName() and spokenName() use from now on. */
export function useNoteSystem(system: NoteSystem) {
	current = system
}

/** The setting's choice: auto is Do Re Mi in Italian, letters in any other language. */
export const noteSystemFor = (choice: 'auto' | NoteSystem, language: string): NoteSystem =>
	choice !== 'auto' ? choice : language === 'it' ? 'solfege' : 'letters'

/** 'C#' → 'Do#', 'Bb4' → 'Sib4', 'Am7' → 'Lam7', 'C#/Db' → 'Do#/Reb' in the system in use (letters: unchanged). */
export const noteName = (name: string) => formatNote(name, current)

/** Read aloud in the system in use: 'C#/Db' → 'C sharp or D flat', 'Sib' → 'Si flat'. */
export const spokenName = (name: string) => spokenNote(name, current)
