// Pure chord data + helpers: chord types as degree formulas, spelling, the
// identifier and the diatonic chords of a scale. No DOM, so
// `npm run check:chord-theory` can run it under Node. Chord types have the
// same shape as scale types, so ts/scales.ts spells them (degreesOf,
// semitonesOf, spellScale all accept a ChordType).
import { degreesOf, pitchClassesOf, ROOTS, semitonesOf, spellScale, type ScaleType } from './scales.ts'

export interface ChordType {
	name: string
	/** What follows the root in the chord symbol: '' (C), 'm' (Cm), 'maj7' (Cmaj7). */
	symbol: string
	/** Degrees relative to the major scale; 9, 11, 13 are an octave up. */
	formula: string
	/** Degrees a voicing may leave out. Default: the 5th, in chords of 4+ notes. */
	omit?: string[]
}

// Order = how common the chord is; the identifier uses it as a tiebreak.
export const CHORD_TYPES: ChordType[] = [
	{ name: 'major', symbol: '', formula: '1 3 5' },
	{ name: 'minor', symbol: 'm', formula: '1 b3 5' },
	{ name: 'dominant 7th', symbol: '7', formula: '1 3 5 b7' },
	{ name: 'minor 7th', symbol: 'm7', formula: '1 b3 5 b7' },
	{ name: 'major 7th', symbol: 'maj7', formula: '1 3 5 7' },
	{ name: 'power chord', symbol: '5', formula: '1 5' },
	{ name: 'suspended 4th', symbol: 'sus4', formula: '1 4 5' },
	{ name: 'suspended 2nd', symbol: 'sus2', formula: '1 2 5' },
	{ name: 'added 9th', symbol: 'add9', formula: '1 3 5 9' },
	{ name: 'major 6th', symbol: '6', formula: '1 3 5 6' },
	{ name: 'minor 6th', symbol: 'm6', formula: '1 b3 5 6' },
	{ name: 'dominant 9th', symbol: '9', formula: '1 3 5 b7 9' },
	{ name: 'diminished', symbol: 'dim', formula: '1 b3 b5' },
	{ name: 'half-diminished', symbol: 'm7b5', formula: '1 b3 b5 b7' },
	{ name: 'diminished 7th', symbol: 'dim7', formula: '1 b3 b5 bb7' },
	{ name: 'augmented', symbol: 'aug', formula: '1 3 #5' },
	{ name: 'dominant 7th sus4', symbol: '7sus4', formula: '1 4 5 b7' },
	{ name: 'minor 9th', symbol: 'm9', formula: '1 b3 5 b7 9' },
	{ name: 'major 9th', symbol: 'maj9', formula: '1 3 5 7 9' },
	// Six notes on six strings rarely fit: guitarists drop the 3rd (it clashes
	// with the 11) and 9th of an 11, the 5th and 9th of a 13.
	{ name: 'dominant 11th', symbol: '11', formula: '1 3 5 b7 9 11', omit: ['3', '5', '9'] },
	{ name: 'dominant 13th', symbol: '13', formula: '1 3 5 b7 9 13', omit: ['5', '9'] },
	// Only diatonic to harmonic / melodic minor, so chordsOfScale can name them.
	{ name: 'minor-major 7th', symbol: 'mMaj7', formula: '1 b3 5 7' },
	{ name: 'augmented major 7th', symbol: 'maj7#5', formula: '1 3 #5 7' },
]

const mod12 = (n: number) => ((n % 12) + 12) % 12

export const chordType = (symbol: string) => CHORD_TYPES.find((t) => t.symbol === symbol)

/** Degrees a voicing may leave out. */
export const omittable = (type: ChordType) => type.omit ?? (degreesOf(type).length >= 4 ? ['5'] : [])

export interface SpelledChord {
	/** May be the enharmonic of the root asked for when that reads simpler (Db, not C#). */
	root: string
	notes: string[]
	degrees: string[]
	symbol: string
}

/** C + dominant 7th → C E G Bb, degrees 1 3 5 b7, symbol C7. */
export function spellChord(root: string, type: ChordType): SpelledChord {
	const spelled = spellScale(root, type)
	return { root: spelled.root, notes: spelled.notes, degrees: degreesOf(type), symbol: spelled.root + type.symbol }
}

/* Identifier ------------------------------------------------------------- */

export interface ChordMatch extends SpelledChord {
	rootPc: number
	type: ChordType
	/** Chord tones not played; an omittable one (the 5th) counts half. */
	missing: number
	/** Played notes outside the chord. */
	extra: number
	/** The bass note when it is not the root: the symbol is a slash chord (C/E). */
	bass?: string
}

/**
 * Chords containing the played pitch classes, best first: exact matches, then
 * fewest missing + extra notes, then the root being the bass, then how common
 * the chord is. The root must be played; at most one extra note and one
 * missing required tone. Omittable tones (the 5th, an 11's 3rd and 9th — what
 * ts/chord-shapes.ts may leave out) may all be missing at half cost each, so
 * every generated voicing is recognised.
 */
export function identifyChords(pitchClasses: Set<number>, bassPc?: number): ChordMatch[] {
	const played = new Set(pitchClasses)
	if (bassPc !== undefined) played.add(mod12(bassPc))
	if (played.size < 2) return []
	const matches: (ChordMatch & { rank: number })[] = []
	for (let rootPc = 0; rootPc < 12; rootPc++) {
		if (!played.has(rootPc)) continue
		CHORD_TYPES.forEach((type, typeIndex) => {
			const tones = pitchClassesOf(rootPc, type)
			const semitones = semitonesOf(type)
			const optional = omittable(type)
			let required = 0
			let dropped = 0
			degreesOf(type).forEach((degree, i) => {
				if (!played.has(mod12(rootPc + semitones[i]))) {
					if (optional.includes(degree)) dropped++
					else required++
				}
			})
			const missing = required + dropped / 2
			const extra = [...played].filter((pc) => !tones.has(pc)).length
			if (required > 1 || extra > 1) return
			const spelled = spellChord(ROOTS[rootPc], type)
			const inverted = bassPc !== undefined && mod12(bassPc) !== rootPc
			const bassIndex = inverted ? semitones.findIndex((s) => mod12(rootPc + s) === mod12(bassPc!)) : -1
			const bass = inverted ? (bassIndex >= 0 ? spelled.notes[bassIndex] : ROOTS[mod12(bassPc!)]) : undefined
			matches.push({
				...spelled,
				symbol: bass ? `${spelled.symbol}/${bass}` : spelled.symbol,
				rootPc,
				type,
				missing,
				extra,
				bass,
				rank: (missing + extra) * 1000 + (inverted ? 100 : 0) + typeIndex,
			})
		})
	}
	return matches.sort((a, b) => a.rank - b.rank).map(({ rank: _, ...match }) => match)
}

/* Diatonic chords ------------------------------------------------------- */

export interface DiatonicChord {
	type: ChordType
	/** Spelled from the scale: F major's IV is Bb, not A#. */
	root: string
	notes: string[]
	symbol: string
	/** I, ii, vii°, bIII, Imaj7, viiø7… */
	numeral: string
}

export interface ScaleDegreeChords {
	/** Scale degree as in the scale's formula ('b3' in minor). */
	degree: string
	rootPc: number
	triad: DiatonicChord
	seventh: DiatonicChord
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
// What follows the numeral, per chord symbol.
const NUMERAL_SUFFIX: Record<string, string> = {
	'': '',
	m: '',
	dim: '°',
	aug: '+',
	maj7: 'maj7',
	'7': '7',
	m7: '7',
	m7b5: 'ø7',
	dim7: '°7',
	mMaj7: 'maj7',
	'maj7#5': '+maj7',
}
// Stacked thirds only: a 6 chord has the same notes as some m7 and must not
// name a diatonic seventh.
const TERTIAN = CHORD_TYPES.filter((t) => ['1 3 5', '1 3 5 7'].includes(degreesOf(t).map((d) => d.replace(/[#b]/g, '')).join(' ')))

function diatonic(notes: string[], semitones: number[], degree: string, picks: number[]): DiatonicChord | null {
	const intervals = picks.map((j) => mod12(semitones[j] - semitones[picks[0]])).join(' ')
	const type = TERTIAN.find((t) => semitonesOf(t).map(mod12).join(' ') === intervals)
	if (!type) return null
	const roman = ROMAN[Number(degree.replace(/[#b]/g, '')) - 1]
	const minor = type.formula.includes('b3')
	return {
		type,
		root: notes[picks[0]],
		notes: picks.map((j) => notes[j]),
		symbol: notes[picks[0]] + type.symbol,
		numeral: degree.replace(/\d/g, '') + (minor ? roman.toLowerCase() : roman) + NUMERAL_SUFFIX[type.symbol],
	}
}

/**
 * The triad and seventh on each degree of a seven-note scale (major, minor,
 * harmonic / melodic minor, the modes), with roman numerals relative to the
 * major scale (natural minor: i ii° bIII iv v bVI bVII). Other scales, and
 * any 7-note scale stacking into a chord this table cannot name, give [].
 */
export function chordsOfScale(rootPc: number, type: ScaleType): ScaleDegreeChords[] {
	const degrees = degreesOf(type)
	if (degrees.length !== 7) return []
	const { notes } = spellScale(ROOTS[mod12(rootPc)], type)
	const semitones = semitonesOf(type)
	const chords: ScaleDegreeChords[] = []
	for (const [i, degree] of degrees.entries()) {
		const stack = [0, 2, 4, 6].map((k) => (i + k) % 7)
		const triad = diatonic(notes, semitones, degree, stack.slice(0, 3))
		const seventh = diatonic(notes, semitones, degree, stack)
		if (!triad || !seventh) return []
		chords.push({ degree, rootPc: mod12(rootPc + semitones[i]), triad, seventh })
	}
	return chords
}
