// Pure scale data + helpers: spelling, fretboard positions and the identifier.
// No DOM, so `npm run check:scales` can run it under Node.

export interface ScaleType {
	name: string
	/** Degrees relative to the major scale. Semitones and letter spelling both
	 * derive from these, so a new scale is one line. */
	formula: string
	/** Other names for the exact same notes (shown alongside, matched once). */
	aka?: string
}

// Order = how common the scale is; the identifier uses it as a tiebreak.
export const SCALE_TYPES: ScaleType[] = [
	{ name: 'Major', formula: '1 2 3 4 5 6 7', aka: 'Ionian' },
	{ name: 'Natural minor', formula: '1 2 b3 4 5 b6 b7', aka: 'Aeolian' },
	{ name: 'Major pentatonic', formula: '1 2 3 5 6' },
	{ name: 'Minor pentatonic', formula: '1 b3 4 5 b7' },
	{ name: 'Blues', formula: '1 b3 4 b5 5 b7' },
	{ name: 'Harmonic minor', formula: '1 2 b3 4 5 b6 7' },
	{ name: 'Melodic minor', formula: '1 2 b3 4 5 6 7' },
	{ name: 'Dorian', formula: '1 2 b3 4 5 6 b7' },
	{ name: 'Mixolydian', formula: '1 2 3 4 5 6 b7' },
	{ name: 'Lydian', formula: '1 2 3 #4 5 6 7' },
	{ name: 'Phrygian', formula: '1 b2 b3 4 5 b6 b7' },
	{ name: 'Locrian', formula: '1 b2 b3 4 b5 b6 b7' },
	{ name: 'Whole tone', formula: '1 2 3 #4 #5 b7' },
	{ name: 'Diminished (whole-half)', formula: '1 2 b3 4 b5 b6 6 7' },
	{ name: 'Diminished (half-whole)', formula: '1 b2 b3 3 #4 5 6 b7' },
	{ name: 'Chromatic', formula: '1 b2 2 b3 3 4 b5 5 b6 6 b7 7' },
]

/** Root names offered in the picker, one per pitch class. */
export const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

const LETTERS = 'CDEFGAB'
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
// The other spelling of each black-key root, tried when it reads simpler
// (G# minor rather than Ab minor's Cb and Fb).
const ENHARMONIC: Record<string, string> = { 'C#': 'Db', Db: 'C#', Eb: 'D#', 'D#': 'Eb', 'F#': 'Gb', Gb: 'F#', Ab: 'G#', 'G#': 'Ab', Bb: 'A#', 'A#': 'Bb' }

const mod12 = (n: number) => ((n % 12) + 12) % 12

export function pitchClassOf(name: string): number {
	const letter = LETTERS.indexOf(name[0])
	let acc = 0
	for (const ch of name.slice(1)) acc += ch === '#' ? 1 : ch === 'b' ? -1 : 0
	return mod12(LETTER_PC[letter] + acc)
}

function parseDegree(degree: string) {
	const number = Number(degree.replace(/[#b]/g, ''))
	const acc = [...degree].reduce((sum, ch) => sum + (ch === '#' ? 1 : ch === 'b' ? -1 : 0), 0)
	// 9, 11, 13 (chord extensions, ts/music/chord-theory.ts) are 2, 4, 6 an octave up.
	return { number, semitones: MAJOR_STEPS[(number - 1) % 7] + 12 * Math.floor((number - 1) / 7) + acc }
}

export function degreesOf(type: ScaleType): string[] {
	return type.formula.split(' ')
}

export function semitonesOf(type: ScaleType): number[] {
	return degreesOf(type).map((d) => parseDegree(d).semitones)
}

/** Each degree on its own letter from the root, e.g. F major → F G A Bb C D E.
 * Never swaps the root's spelling (ts/music/harmony.ts keeps a key's letters: Db
 * blues has Gb7, not F#7). */
export function spellFrom(root: string, type: ScaleType): string[] {
	const rootLetter = LETTERS.indexOf(root[0])
	const rootPc = pitchClassOf(root)
	return degreesOf(type).map((degree) => {
		const { number, semitones } = parseDegree(degree)
		const letter = (rootLetter + number - 1) % 7
		const acc = mod12(rootPc + semitones - LETTER_PC[letter] + 6) - 6
		return LETTERS[letter] + (acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc))
	})
}

// Fewest accidentals wins; a double sharp/flat costs as much as several.
const cost = (notes: string[]) => notes.reduce((sum, n) => sum + (n.length - 1) + (n.length > 2 ? 10 : 0), 0)

/** Spelled scale. `root` may be swapped for its enharmonic when that reads simpler. */
export function spellScale(root: string, type: ScaleType): { root: string; notes: string[] } {
	const notes = spellFrom(root, type)
	const alt = ENHARMONIC[root]
	if (alt) {
		const altNotes = spellFrom(alt, type)
		if (cost(altNotes) < cost(notes)) return { root: alt, notes: altNotes }
	}
	return { root, notes }
}

export function pitchClassesOf(rootPc: number, type: ScaleType): Set<number> {
	return new Set(semitonesOf(type).map((s) => mod12(rootPc + s)))
}

/* Fretboard -------------------------------------------------------------- */

/** Standard tuning as MIDI notes, high E first (top row of the diagram, like tab). */
export const STRINGS = [64, 59, 55, 50, 45, 40]
export const FRETS = 22

export const midiAt = (string: number, fret: number) => STRINGS[string] + fret

/* Identifier ------------------------------------------------------------- */

export interface ScaleMatch {
	root: string
	rootPc: number
	type: ScaleType
	notes: string[]
	/** Scale tones that were not marked. */
	extra: number
}

/**
 * Every root × type containing all `marked` pitch classes, best first: fewest
 * unmarked notes, then the root being the lowest marked note (a player
 * usually starts on it), then the root being marked at all, then how common
 * the scale is.
 */
export function identifyScales(marked: Set<number>, bassPc?: number): ScaleMatch[] {
	if (marked.size === 0) return []
	const matches: (ScaleMatch & { rank: number })[] = []
	for (let rootPc = 0; rootPc < 12; rootPc++) {
		SCALE_TYPES.forEach((type, typeIndex) => {
			const pcs = pitchClassesOf(rootPc, type)
			for (const pc of marked) if (!pcs.has(pc)) return
			const rootRank = rootPc === bassPc ? 0 : marked.has(rootPc) ? 1 : 2
			const spelled = spellScale(ROOTS[rootPc], type)
			matches.push({
				root: spelled.root,
				rootPc,
				type,
				notes: spelled.notes,
				extra: pcs.size - marked.size,
				rank: (pcs.size - marked.size) * 1000 + rootRank * 100 + typeIndex,
			})
		})
	}
	return matches.sort((a, b) => a.rank - b.rank)
}

export const scaleTitle = (root: string, type: ScaleType) => `${root} ${type.name}${type.aka ? ` · ${type.aka}` : ''}`

/* Degrees, positions, playback runs ------------------------------------- */

/** `b3` → 3, `#4` → 4: the degree chip a note belongs to. */
export const degreeNumber = (degree: string) => Number(degree.replace(/[#b]/g, ''))

/** Pitch class → degree as spelled in the scale (`b3`, `b7` in minor). */
export function degreeMap(rootPc: number, type: ScaleType): Map<number, string> {
	const degrees = degreesOf(type)
	return new Map(semitonesOf(type).map((s, i) => [mod12(rootPc + s), degrees[i]]))
}

/**
 * Five CAGED-style boxes, as [lowest fret, highest fret] windows of 5 frets.
 * Box k starts a fret below a scale tone on the low E string, counting up
 * from the root; for a pentatonic these are exactly the five classic boxes
 * (A minor: 4–8, 7–11, 9–13, 11–15, 2–6), other scales take five tones
 * spread evenly across the octave. A root on the open low E makes box 1 the
 * open position (0–3) instead of frets 11–15.
 */
export function positionWindows(rootPc: number, type: ScaleType): [number, number][] {
	const rootFret = mod12(rootPc - STRINGS[STRINGS.length - 1])
	const semitones = semitonesOf(type)
	return [0, 1, 2, 3, 4].map((k) => {
		const start = mod12(rootFret + semitones[Math.round((k * semitones.length) / 5)] - 1)
		return start === 11 && k === 0 ? [0, 3] : [start, start + 4]
	})
}

/** One octave up from the lowest root on the neck, root to root (MIDI). */
export function scaleRun(rootPc: number, type: ScaleType): number[] {
	const low = STRINGS[STRINGS.length - 1]
	const root = low + mod12(rootPc - low)
	return [...semitonesOf(type).map((s) => root + s), root + 12]
}

/** Every scale pitch inside a fret window, low to high (MIDI, no repeats). */
export function positionRun(rootPc: number, type: ScaleType, [lo, hi]: [number, number]): number[] {
	const pcs = pitchClassesOf(rootPc, type)
	const midis = new Set<number>()
	STRINGS.forEach((_, string) => {
		for (let fret = lo; fret <= hi; fret++) if (pcs.has(midiAt(string, fret) % 12)) midis.add(midiAt(string, fret))
	})
	return [...midis].sort((a, b) => a - b)
}
