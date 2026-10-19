// Pure helpers for the chord Library and Identify sub-views of the Chords tab
// (ts/views/chord-library.ts): picker labels and grouping, the keys a chord
// is diatonic to, symbol parsing, a marked shape's notes and how a match
// differs from what was played. No DOM, so `npm run check:chord-library`
// runs it under Node.
import { CHORD_TYPES, chordsOfScale, chordType, spellChord, type ChordMatch, type ChordType } from './chord-theory.ts'
import { shapeString, type Voicing } from './chord-shapes.ts'
import { degreesOf, pitchClassOf, ROOTS, SCALE_TYPES, semitonesOf, spellScale, STRINGS } from './scales.ts'

const mod12 = (n: number) => ((n % 12) + 12) % 12

/** Root picker: both names on the black keys guitarists spell either way;
 * Eb, Ab, Bb are what chord books write. The chord itself is spelled by
 * spellChord, which picks whichever reads simpler (Db, not C#). */
export const ROOT_LABELS = ['C', 'C#/Db', 'D', 'Eb', 'E', 'F', 'F#/Gb', 'G', 'Ab', 'A', 'Bb', 'B']

// Groups for the type picker; CHORD_TYPES order (commonness) within each.
const GROUP_OF: Record<string, string> = {
	'': 'Triads',
	m: 'Triads',
	'5': 'Triads',
	dim: 'Triads',
	aug: 'Triads',
	'7': 'Sixths & sevenths',
	m7: 'Sixths & sevenths',
	maj7: 'Sixths & sevenths',
	'6': 'Sixths & sevenths',
	m6: 'Sixths & sevenths',
	m7b5: 'Sixths & sevenths',
	dim7: 'Sixths & sevenths',
	'9': 'Extended',
	m9: 'Extended',
	maj9: 'Extended',
	'11': 'Extended',
	'13': 'Extended',
	sus4: 'Suspended & added',
	sus2: 'Suspended & added',
	'7sus4': 'Suspended & added',
	add9: 'Suspended & added',
}
const GROUPS = ['Triads', 'Sixths & sevenths', 'Extended', 'Suspended & added', 'Altered']

// A type missing from GROUP_OF lands in Altered rather than vanishing.
export const CHORD_GROUPS = GROUPS.map((label) => ({ label, types: CHORD_TYPES.filter((t) => (GROUP_OF[t.symbol] ?? 'Altered') === label) }))

/* In keys ----------------------------------------------------------------- */

export interface KeyUse {
	/** 'G', 'Em': the key, spelled by its usual signature (Db, not C#). */
	key: string
	minor: boolean
	/** IV, bVII7, ii°… as chordsOfScale writes it. */
	numeral: string
}

const MAJOR = SCALE_TYPES.find((t) => t.name === 'Major')!
const MINOR = SCALE_TYPES.find((t) => t.name === 'Natural minor')!
// The keys whose two spellings tie (six sharps or six flats), where
// spellScale keeps the ROOTS name: Bbm7 is iii7 in Gb, not in F# (A#m7).
const TIED: Record<string, string> = { 'F#': 'Gb', Eb: 'D#' }

/** The major and natural-minor keys whose triads or sevenths include this
 * chord, majors first, each by scale degree. [] for chords no key stacks
 * (sus, 6, 9…). */
export function keysOf(rootPc: number, type: ChordType): KeyUse[] {
	const found: (KeyUse & { rank: number })[] = []
	const spelledRoot = spellChord(ROOTS[mod12(rootPc)], type).root
	for (const [minor, scale] of [MAJOR, MINOR].entries()) {
		for (let keyPc = 0; keyPc < 12; keyPc++) {
			chordsOfScale(keyPc, scale).forEach((degree, i) => {
				if (degree.rootPc !== mod12(rootPc)) return
				for (const chord of [degree.triad, degree.seventh]) {
					if (chord.type !== type) continue
					let key = spellScale(ROOTS[keyPc], scale)
					const alt = TIED[key.root] && spellScale(TIED[key.root], scale)
					if (alt && !key.notes.includes(spelledRoot) && alt.notes.includes(spelledRoot)) key = alt
					found.push({ key: key.root + (minor ? 'm' : ''), minor: minor === 1, numeral: chord.numeral, rank: minor * 10 + i })
				}
			})
		}
	}
	return found.sort((a, b) => a.rank - b.rank).map(({ rank: _, ...use }) => use)
}

/* Symbols ------------------------------------------------------------------ */

/** 'C#m7' → C# minor 7th; 'C/E' → C major (the bass is the Library's to show,
 * not part of the type). Null for anything CHORD_TYPES has no symbol for. */
export function parseChordSymbol(symbol: string): { rootPc: number; type: ChordType } | null {
	const match = /^([A-G][#b]?)([^/]*)/.exec(symbol.trim())
	const type = match && chordType(match[2])
	return type ? { rootPc: pitchClassOf(match[1]), type } : null
}

/* Shapes -------------------------------------------------------------------- */

/** A shape (per string as in STRINGS, -1 muted): sounding notes low string
 * first (the strum order), their pitch classes, and the bass, the lowest
 * pitch (a fret high on the low E can sit above an open A). */
export function shapeNotes(frets: number[], tuning: number[] = STRINGS) {
	const midis = frets.flatMap((f, s) => (f < 0 ? [] : [tuning[s] + f])).reverse()
	return {
		midis,
		pcs: new Set(midis.map(mod12)),
		bassPc: midis.length ? mod12(Math.min(...midis)) : undefined,
	}
}

/** '1 · x32010' and where it sits: 'open', 'barre · fret 3', 'fret 5'. */
export function voicingCaption(voicing: Voicing, index: number) {
	const position = voicing.frets.includes(0) ? 'open' : `${voicing.barre ? 'barre · ' : ''}fret ${voicing.base}`
	return { title: `${index + 1} · ${shapeString(voicing)}`, position }
}

/* Identify ------------------------------------------------------------------ */

const ORDINAL: Record<string, string> = {
	'1': 'root',
	'2': '2nd',
	'3': '3rd',
	'4': '4th',
	'5': '5th',
	'6': '6th',
	'7': '7th',
	'9': '9th',
	'11': '11th',
	'13': '13th',
}
// A played note outside the chord, named by its interval above the root.
const ADDED = ['1', 'b9', '9', '#9', '3', '11', '#11', '5', 'b13', '13', 'b7', '7']

/** How a match differs from what was played: ['no 5th', '+ add9']; [] = exact. */
export function matchNotes(match: ChordMatch, played: Set<number>): string[] {
	const semitones = semitonesOf(match.type)
	const tones = new Set(semitones.map((s) => mod12(match.rootPc + s)))
	const missing = degreesOf(match.type)
		.filter((_, i) => !played.has(mod12(match.rootPc + semitones[i])))
		.map((d) => `no ${ORDINAL[d] ?? d}`)
	const extra = [...played].filter((pc) => !tones.has(pc)).map((pc) => `+ add${ADDED[mod12(pc - match.rootPc)]}`)
	return [...missing, ...extra]
}
