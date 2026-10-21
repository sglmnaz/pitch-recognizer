// Playable guitar voicings for a chord, in standard tuning or any other:
// every shape within a 4-fret span (plus open strings), at most four
// fingers (a barre counts as one), ranked by how easy and how standard it
// is. Pure, so `npm run check:chord-theory` runs it under Node.
import { omittable, spellChord, type ChordType } from './chord-theory.ts'
import type { Dot, NeckSpec } from '../ui/fretboard.ts'
import { degreeRole, degreesOf, ROOTS, semitonesOf, STRINGS } from './scales.ts'

export interface Voicing {
	/** Per string as in `STRINGS` (0 = highest): -1 muted, 0 open, else the fret. */
	frets: number[]
	/** Per string: 0 none, 1 index … 4 little finger. */
	fingers: number[]
	/** The index finger across strings `from`–`to` (string indices) at `fret`. */
	barre: { fret: number; from: number; to: number } | null
	/** Lowest fretted fret (1 for an all-open shape). */
	base: number
	/** Highest fretted fret (0 for an all-open shape). */
	high: number
	/** First fret of its 4-fret chord diagram: 1 (the nut) when a string rings
	 * open or everything fits frets 1–4, else `base`. */
	from: number
	/** The bass is not the root. */
	inversion: boolean
	/** Chord degrees left out (mostly the 5th). */
	omitted: string[]
	score: number
}

export interface ShapeOptions {
	/** MIDI notes, highest string first (default standard tuning). */
	tuning?: number[]
	/** Highest fret a shape may use. */
	maxFret?: number
	/** How many voicings to return. */
	limit?: number
	/** Also return shapes with another chord tone in the bass. */
	inversions?: boolean
}

// Lowest to highest fretted note: 3 frets apart at most (a 4-fret span).
const SPAN = 3
const MIN_STRINGS = 3
// Frets a chord diagram shows. A shape with an open string must fit the
// window from the nut (frets 1–4), or its diagram could not show both.
const WINDOW = 4

const mod12 = (n: number) => ((n % 12) + 12) % 12

/** The lowest sounding string (highest index). */
function bassString(frets: number[]) {
	let s = frets.length - 1
	while (s > 0 && frets[s] < 0) s--
	return s
}

/** Low string first, as chord books write them: C → x32010; frets past 9 get dashes (x-10-12-12-12-10). */
export function shapeString(voicing: Pick<Voicing, 'frets'>): string {
	const frets = [...voicing.frets].reverse().map((f) => (f < 0 ? 'x' : String(f)))
	return frets.join(voicing.frets.some((f) => f > 9) ? '-' : '')
}

/**
 * Finger numbers for the fretted notes, lowest fret first (bass string first
 * on a shared fret), each finger at least its fret's distance from the
 * lowest one so a stretch gets the little finger (x355xx → 1 3 4). More
 * than four notes need the index across the lowest fret: a barre from the
 * lowest to the highest string fretted there, with nothing open or muted
 * under it. Null when the hand cannot do it.
 */
function fingering(frets: number[]): Pick<Voicing, 'fingers' | 'barre'> | null {
	const fingers = frets.map(() => 0)
	const fretted = frets.map((f, s) => [f, s]).filter(([f]) => f > 0)
	if (fretted.length === 0) return { fingers, barre: null }
	const low = Math.min(...fretted.map(([f]) => f))
	let barre: Voicing['barre'] = null
	let notes = fretted
	if (fretted.length > 4) {
		const atLow = fretted.filter(([f]) => f === low).map(([, s]) => s)
		const from = Math.min(...atLow)
		const to = Math.max(...atLow)
		for (let s = from; s <= to; s++) if (frets[s] < low) return null
		barre = { fret: low, from, to }
		for (let s = from; s <= to; s++) if (frets[s] === low) fingers[s] = 1
		notes = fretted.filter(([f, s]) => !(f === low && s >= from && s <= to))
	}
	notes.sort((a, b) => a[0] - b[0] || b[1] - a[1])
	let prev = barre ? 1 : 0
	for (let i = 0; i < notes.length; i++) {
		const [f, s] = notes[i]
		const finger = Math.max(prev + 1, Math.min(f - low + 1, 4 - (notes.length - 1 - i)))
		if (finger > 4) return null
		fingers[s] = prev = finger
	}
	return { fingers, barre }
}

/**
 * Score, higher = easier and more standard. Chord-book shapes sound every
 * string from the bass through the high E (all 19 in the self-check do) with
 * the root on the 6th or 5th string where they can (the CAGED shapes):
 * those, more strings and low positions win;
 * every finger, a barre, a stretch, a muted string in the middle, dropped
 * tones and inversions cost. Open strings help in open position (fretted
 * notes within frets 1–3, the chord-book open chords) and cost a lot
 * against higher frets (x20402 for Bm: it sounds, but nobody teaches it).
 */
function scoreOf(frets: number[], fingerCount: number, barre: boolean, omitted: number, inversion: boolean) {
	const fretted = frets.filter((f) => f > 0)
	const low = fretted.length ? Math.min(...fretted) : 0
	const high = fretted.length ? Math.max(...fretted) : 0
	const sounding = frets.filter((f) => f >= 0).length
	const open = frets.filter((f) => f === 0).length
	const bass = bassString(frets)
	const top = frets.findIndex((f) => f >= 0)
	const gaps = bass - top + 1 - sounding
	return (
		(high <= 3 ? 2 : -6) * open +
		2 * sounding -
		3 * fingerCount -
		(barre ? 2 : 0) -
		0.5 * low -
		(high - low) -
		6 * gaps +
		(top === 0 && gaps === 0 ? 6 : 0) -
		2 * omitted -
		(inversion ? 10 : 0) +
		(!inversion && bass >= frets.length - 2 ? 2 : 0)
	)
}

// Computed once per chord, tuning and range, on first use: the generator
// walks ~10⁵ fret combinations, a dictionary page asks for dozens of chords.
const cache = new Map<string, Voicing[]>()

/** The best `limit` voicings, best first. Cached: treat them as read-only. */
export function chordShapes(rootPc: number, type: ChordType, options: ShapeOptions = {}): Voicing[] {
	const { tuning = STRINGS, maxFret = 15, limit = 8, inversions = false } = options
	const key = [mod12(rootPc), type.formula, type.omit ?? '', tuning, maxFret, inversions].join('|')
	let all = cache.get(key)
	if (!all) cache.set(key, (all = generate(mod12(rootPc), type, tuning, maxFret, inversions)))
	return all.slice(0, limit)
}

function generate(rootPc: number, type: ChordType, tuning: number[], maxFret: number, inversions: boolean): Voicing[] {
	const degrees = degreesOf(type)
	const semitones = semitonesOf(type)
	const degreeOf = new Map(semitones.map((s, i) => [mod12(rootPc + s), degrees[i]]))
	const optional = new Set(omittable(type))
	const last = tuning.length - 1
	const found = new Map<string, Voicing>()
	const frets = tuning.map(() => -1)

	function leaf() {
		const sounding = frets.map((f, s) => (f < 0 ? null : degreeOf.get(mod12(tuning[s] + f))!)).filter((d) => d !== null)
		if (sounding.length < MIN_STRINGS) return
		const omitted = degrees.filter((d) => !sounding.includes(d))
		if (omitted.some((d) => !optional.has(d))) return
		const bass = bassString(frets)
		const inversion = mod12(tuning[bass] + frets[bass]) !== rootPc
		if (inversion && !inversions) return
		const hand = fingering(frets)
		if (!hand) return
		const fretted = frets.filter((f) => f > 0)
		const base = fretted.length ? Math.min(...fretted) : 1
		const high = fretted.length ? Math.max(...fretted) : 0
		const open = frets.includes(0)
		if (open && high > WINDOW) return
		const fingerCount = new Set(hand.fingers.filter((f) => f > 0)).size
		found.set(frets.join(','), {
			frets: [...frets],
			...hand,
			base,
			high,
			from: open || high <= WINDOW ? 1 : base,
			inversion,
			omitted,
			score: scoreOf(frets, fingerCount, hand.barre !== null, omitted.length, inversion),
		})
	}

	// Bass string first. Muted strings at the edges, plus at most one in the
	// middle (a fretting finger leans on it, as in x3x355). Phase: 0 nothing
	// sounding yet, 1 sounding, 2 muted after sounding, 3 sounding again after
	// that gap, 4 done (only mutes from here).
	const MUTE = [0, 2, 4, 4, 4]
	const SOUND = [1, 1, 3, 3]
	function walk(s: number, low: number, high: number, phase: number) {
		if (s < 0) return leaf()
		frets[s] = -1
		walk(s - 1, low, high, MUTE[phase])
		if (phase === 4) return
		for (let f = 0; f <= maxFret; f++) {
			if (!degreeOf.has(mod12(tuning[s] + f))) continue
			const lo = f > 0 ? Math.min(low, f) : low
			const hi = f > 0 ? Math.max(high, f) : high
			if (hi - lo > SPAN) continue
			frets[s] = f
			walk(s - 1, lo, hi, SOUND[phase])
		}
		frets[s] = -1
	}
	walk(last, Infinity, -Infinity, 0)

	// A shape that is another one minus an edge string (x3201x next to
	// x32010) only clutters the list: keep the fuller one, unless it is the
	// harder one (x02220 stays, 502220 adds a stretch).
	const fuller = new Map<string, number>()
	for (const v of found.values()) {
		if (v.inversion) continue
		const sounding = v.frets.map((f, s) => (f >= 0 ? s : -1)).filter((s) => s >= 0)
		for (const edge of [sounding[0], sounding.at(-1)!]) {
			const less = [...v.frets]
			less[edge] = -1
			const key = less.join(',')
			fuller.set(key, Math.max(fuller.get(key) ?? -Infinity, v.score))
		}
	}
	return [...found.entries()]
		.filter(([key, v]) => (fuller.get(key) ?? -Infinity) < v.score)
		.map(([, v]) => v)
		.sort((a, b) => b.score - a.score || a.base - b.base)
}

export interface VoicingSpecOptions {
	/** Text in the dots: chord degrees (default), note names or nothing. */
	labels?: 'degrees' | 'notes' | 'none'
	/** Finger numbers under the diagram (default true). */
	fingers?: boolean
	/** Default true, like a chord chart. */
	vertical?: boolean
	/** The tuning the voicing was generated for (default standard). */
	tuning?: number[]
	/** Shows a note name or chord symbol (ts/ui/names.ts noteName); letters by default. */
	name?: (note: string) => string
}

/**
 * A voicing as a fretboard chord diagram: fretted notes as dots coloured by
 * degree (root, 3rd / 5th, the rest), open rings and mute crosses above the
 * nut, the barre, finger numbers and the 4-fret window from `voicing.from`.
 */
export function voicingSpec(voicing: Voicing, rootPc: number, type: ChordType, options: VoicingSpecOptions = {}): NeckSpec {
	const { labels = 'degrees', fingers = true, vertical = true, tuning = STRINGS, name = (note: string) => note } = options
	const chord = spellChord(ROOTS[mod12(rootPc)], type)
	const semitones = semitonesOf(type)
	const indexOf = (midi: number) => semitones.findIndex((s) => mod12(rootPc + s) === mod12(midi))
	const dots: Dot[] = []
	voicing.frets.forEach((fret, string) => {
		if (fret <= 0) return
		const i = indexOf(tuning[string] + fret)
		const degree = chord.degrees[i]
		dots.push({
			string,
			fret,
			role: degreeRole(degree),
			label: labels === 'degrees' ? degree : labels === 'notes' ? name(chord.notes[i]) : '',
			detail: degree,
			finger: fingers && voicing.fingers[string] ? voicing.fingers[string] : undefined,
		})
	})
	return {
		dots,
		barres: voicing.barre ? [voicing.barre] : [],
		strings: voicing.frets.map((f) => (f < 0 ? 'muted' : f === 0 ? 'open' : null)),
		window: { from: voicing.from, frets: WINDOW, vertical },
		noteName: (midi) => name(chord.notes[indexOf(midi)] ?? ROOTS[mod12(midi)]),
		label: `${name(chord.symbol)}${voicing.inversion ? ' (inversion)' : ''}, ${shapeString(voicing)}`,
	}
}
