// Pure harmony data for the Scales tab: a scale's family and the scale its
// chords come from, common progressions resolved in a key, the circle of
// fifths, and the scales that fit a chord. No DOM, so `npm run check:harmony`
// runs it under Node.
import { chordType, type ChordType } from './chord-theory.ts'
import { degreeNumber, degreesOf, identifyScales, pitchClassOf, ROOTS, SCALE_TYPES, spellFrom, spellScale, type ScaleMatch, type ScaleType } from './scales.ts'

const mod12 = (n: number) => ((n % 12) + 12) % 12
const scaleNamed = (name: string) => SCALE_TYPES.find((t) => t.name === name)!

export const MAJOR = scaleNamed('Major')
export const MINOR = scaleNamed('Natural minor')

export type Family = 'major' | 'minor'

/**
 * Major-like (major 3rd and perfect 5th: major, Lydian, Mixolydian, major
 * pentatonic) or minor-like (minor 3rd and perfect 5th: the minors, Dorian,
 * Phrygian, minor pentatonic, blues). Null for Locrian, whole tone, the
 * diminished scales and chromatic: no plain tonic triad to resolve to.
 */
export function familyOf(type: ScaleType): Family | null {
	const degrees = degreesOf(type)
	const major = degrees.includes('3')
	if (!degrees.includes('5') || major === degrees.includes('b3')) return null
	return major ? 'major' : 'minor'
}

/**
 * The seven-note scale whose chords go with a scale: itself, or the major /
 * natural minor a pentatonic or the blues scale is cut from (A minor
 * pentatonic → A natural minor). Null when there is no obvious one (whole
 * tone, diminished, chromatic).
 */
export function chordSource(type: ScaleType): ScaleType | null {
	if (degreesOf(type).length === 7) return type
	if (type.name === 'Major pentatonic') return MAJOR
	if (type.name === 'Minor pentatonic' || type.name === 'Blues') return MINOR
	return null
}

/* Progressions ----------------------------------------------------------- */

export interface Progression {
	name: string
	/** Roman numerals, one bar each, relative to the major scale (bVI in minor). */
	numerals: string
	/** Spelled in the major or the natural minor scale on the root; offered to scales of that family. */
	mode: Family
	/** Also offered for these scales (the 12-bar blues over the blues scale). */
	alsoFor?: string[]
}

export const PROGRESSIONS: Progression[] = [
	{ name: 'Three-chord', numerals: 'I IV V I', mode: 'major' },
	{ name: 'Pop', numerals: 'I V vi IV', mode: 'major' },
	{ name: 'Doo-wop', numerals: 'I vi IV V', mode: 'major' },
	{ name: 'Pop, minor start', numerals: 'vi IV I V', mode: 'major' },
	{ name: 'Jazz ii–V–I', numerals: 'ii7 V7 Imaj7', mode: 'major' },
	{ name: '12-bar blues', numerals: 'I7 I7 I7 I7 IV7 IV7 I7 I7 V7 IV7 I7 V7', mode: 'major', alsoFor: ['Blues', 'Minor pentatonic', 'Mixolydian'] },
	{ name: 'Minor three-chord', numerals: 'i iv v i', mode: 'minor' },
	{ name: 'Minor pop', numerals: 'i bVI bIII bVII', mode: 'minor' },
	// The major V borrows harmonic minor's leading tone, as both cadences do.
	{ name: 'Andalusian', numerals: 'i bVII bVI V', mode: 'minor' },
	{ name: 'Minor ii–V–i', numerals: 'ii° V i', mode: 'minor' },
]

/**
 * Progressions for a scale: those of its family for the major and minor
 * scales (natural, harmonic, melodic) and their pentatonics; modes only get
 * what is written for them (the 12-bar blues over Mixolydian), since a
 * minor i–iv–v is not Dorian's i–IV–v.
 */
export function progressionsFor(type: ScaleType): Progression[] {
	const family = MODES[type.name] === undefined ? familyOf(type) : null
	return PROGRESSIONS.filter((p) => p.mode === family || p.alsoFor?.includes(type.name))
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
const NUMERAL = /^([b#]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)([°ø]?)(maj7|7)?$/

/** 'bVII' → degree b7, major; 'ii7' → 2, m7; 'ii°' → 2, dim. */
export function parseNumeral(numeral: string): { degree: string; type: ChordType } {
	const match = NUMERAL.exec(numeral)
	if (!match) throw new Error(`Unknown numeral ${numeral}`)
	const [, accidental, roman, mark, seventh = ''] = match
	const minor = roman === roman.toLowerCase()
	const symbol = mark === '°' ? (seventh ? 'dim7' : 'dim') : mark === 'ø' ? 'm7b5' : (minor ? 'm' : '') + seventh
	const type = chordType(symbol)
	if (!type) throw new Error(`No chord type for ${numeral}`)
	return { degree: accidental + (ROMAN.indexOf(roman.toUpperCase()) + 1), type }
}

export interface KeyChord {
	numeral: string
	root: string
	rootPc: number
	type: ChordType
	symbol: string
	notes: string[]
}

/** A chord on the root's key letters (Bb in F, never A#). */
function keyChord(numeral: string, root: string, type: ChordType): KeyChord {
	return { numeral, root, rootPc: pitchClassOf(root), type, symbol: root + type.symbol, notes: spellFrom(root, type) }
}

/** The progression's chords in the key of `rootPc`, one per bar. */
export function resolveProgression(progression: Progression, rootPc: number): KeyChord[] {
	const key = spellScale(ROOTS[mod12(rootPc)], progression.mode === 'major' ? MAJOR : MINOR).notes
	return progression.numerals.split(' ').map((numeral) => {
		const { degree, type } = parseNumeral(numeral)
		// ponytail: the root is the key's own note on that degree. Every numeral
		// above is diatonic to its mode (the check asserts it); a chromatic one
		// (bII in major) would need its accidental applied here.
		return keyChord(numeral, key[degreeNumber(degree) - 1], type)
	})
}

/* Circle of fifths ------------------------------------------------------- */

export interface CircleKey {
	major: string
	/** Relative minor, without the 'm'. */
	minor: string
	majorPc: number
	minorPc: number
	/** Key signature: sharps positive, flats negative. */
	accidentals: number
	/** The bottom of the circle reads both ways: F# = Gb (6 flats), D#m = Ebm. */
	majorAlt?: string
	minorAlt?: string
}

const MAJORS = 'C G D A E B F# Db Ab Eb Bb F'.split(' ')
const MINORS = 'A E B F# C# G# D# Bb F C G D'.split(' ')

/** Clockwise from C at the top, a fifth apart. */
export const CIRCLE: CircleKey[] = MAJORS.map((major, i) => ({
	major,
	minor: MINORS[i],
	majorPc: pitchClassOf(major),
	minorPc: pitchClassOf(MINORS[i]),
	accidentals: i <= 6 ? i : i - 12,
	...(i === 6 ? { majorAlt: 'Gb', minorAlt: 'Eb' } : {}),
}))

/** Where a key sits on the circle: a major key on the outer ring, a minor one by its relative major. */
export const circleIndex = (pc: number, family: Family) => mod12((family === 'minor' ? pc + 3 : pc) * 7)

// Semitones a mode's root sits above its parent major's root (D Dorian: C major).
const MODES: Record<string, number> = { Dorian: 2, Phrygian: 4, Lydian: 5, Mixolydian: 7, Locrian: 11 }

export interface Key {
	pc: number
	family: Family
	/** A mode, shown as its parent major (D Dorian → C major). */
	mode: boolean
}

/**
 * The key a scale is written in, i.e. its key signature: its own major or
 * minor key (harmonic and melodic minor keep the natural minor's
 * signature), or a mode's parent major. Null for whole tone, the diminished
 * scales and chromatic.
 */
export function keyOf(rootPc: number, type: ScaleType): Key | null {
	const offset = MODES[type.name]
	if (offset !== undefined) return { pc: mod12(rootPc - offset), family: 'major', mode: true }
	const family = familyOf(type)
	return family && { pc: mod12(rootPc), family, mode: false }
}

/** The key's name as the circle spells it: 'C major', 'D# minor'. */
function keyTitle(key: Key): string {
	const k = CIRCLE[circleIndex(key.pc, key.family)]
	return key.family === 'major' ? `${k.major} major` : `${k.minor} minor`
}

/** 'A minor, no sharps or flats'; a mode: 'D Dorian · parent C major, no sharps or flats'. '' without a key. */
export function keyName(rootPc: number, type: ScaleType): string {
	const key = keyOf(rootPc, type)
	if (!key) return ''
	const signature = signatureName(CIRCLE[circleIndex(key.pc, key.family)].accidentals)
	return key.mode ? `${spellScale(ROOTS[mod12(rootPc)], type).root} ${type.name} · parent ${keyTitle(key)}, ${signature}` : `${keyTitle(key)}, ${signature}`
}

/** 2 → '2 sharps', -1 → '1 flat', 0 → 'no sharps or flats'. */
export function signatureName(accidentals: number): string {
	const n = Math.abs(accidentals)
	return n === 0 ? 'no sharps or flats' : `${n} ${accidentals > 0 ? 'sharp' : 'flat'}${n > 1 ? 's' : ''}`
}

/* Scales for a chord ----------------------------------------------------- */

/**
 * Seven-note scales holding every chord tone, best first: the chord's root
 * as the scale's root, then how common the scale is (SCALE_TYPES order),
 * then identifyScales' order (a chord tone as the root). For C: C major,
 * C Mixolydian, C Lydian, G major, F major, E, D and A minor…, where
 * identifyScales alone would put G Dorian ahead of F major. Pentatonics are
 * left out: "which key or mode am I in" is the question this answers.
 */
export function scalesForChord(chordPcs: Set<number>, rootPc: number, limit = 8): ScaleMatch[] {
	const rank = (m: ScaleMatch) => (m.rootPc === rootPc ? 0 : 100) + SCALE_TYPES.indexOf(m.type)
	return identifyScales(chordPcs, rootPc)
		.filter((m) => degreesOf(m.type).length === 7)
		.sort((a, b) => rank(a) - rank(b))
		.slice(0, limit)
}
