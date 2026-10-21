// Pure tuner data and maths: tunings, their string frequencies for a given A4,
// and "which string is the player on". No DOM, so scripts/tuning-check.ts runs
// it in Node (hence the explicit .ts import).
import { clamp } from '../core/math.ts'
import { centsBetween, frequencyOfMidi } from '../core/notes.ts'

export interface Tuning {
	id: string
	name: string
	/** Scientific names, low string to high. Flats stay flats (Eb, not D#). */
	notes: string[]
}

// Lists are ordered by how often guitarists reach for them.
export const TUNINGS: Tuning[] = [
	{ id: 'standard', name: 'Standard', notes: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
	{ id: 'drop-d', name: 'Drop D', notes: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
	{ id: 'half-down', name: 'Half step down', notes: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'] },
	{ id: 'whole-down', name: 'Whole step down', notes: ['D2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
	{ id: 'drop-c', name: 'Drop C', notes: ['C2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
	{ id: 'dadgad', name: 'DADGAD', notes: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'] },
	{ id: 'open-g', name: 'Open G', notes: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] },
	{ id: 'open-d', name: 'Open D', notes: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'] },
	{ id: 'open-e', name: 'Open E', notes: ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'] },
	{ id: 'open-c', name: 'Open C', notes: ['C2', 'G2', 'C3', 'G3', 'C4', 'E4'] },
]

export const STANDARD = TUNINGS[0]

/** The tuning with this id; an unknown one (stale storage) falls back to Standard. */
export const tuningById = (id: string): Tuning => TUNINGS.find((tuning) => tuning.id === id) ?? STANDARD

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** MIDI number of a scientific name such as `Eb2` or `F#3`. */
export function midiOfName(name: string): number {
	const match = /^([A-G])([#b]?)(-?\d)$/.exec(name)
	if (!match) throw new Error(`Bad note name: ${name}`)
	const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0
	return (Number(match[3]) + 1) * 12 + PITCH_CLASS[match[1]] + accidental
}

export interface TuningString {
	/** Note letter with accidental, no octave: `Eb`. */
	name: string
	octave: number
	midi: number
	/** Target frequency for the A4 in use. */
	frequency: number
}

/** The strings of a tuning, low to high, with target frequencies for `a4`. */
export function tuningStrings(tuning: Tuning, a4: number): TuningString[] {
	return tuning.notes.map((note) => {
		const midi = midiOfName(note)
		return { name: note.slice(0, -1), octave: Number(note.slice(-1)), midi, frequency: frequencyOfMidi(midi, a4) }
	})
}

/**
 * The string closest in pitch to `frequency`, with the signed cents off its
 * target (positive = sharp). Distance is in cents, not Hz, so the low strings
 * are not favoured. No cap: a string that is a whole step flat must still map
 * to the string it is being tuned to.
 */
export function nearestString(frequency: number, strings: TuningString[]): { index: number; cents: number } {
	let index = 0
	let cents = centsBetween(frequency, strings[0].frequency)
	for (let i = 1; i < strings.length; i++) {
		const candidate = centsBetween(frequency, strings[i].frequency)
		if (Math.abs(candidate) < Math.abs(cents)) {
			index = i
			cents = candidate
		}
	}
	return { index, cents }
}

export const A4_MIN = 415
export const A4_MAX = 466

/** A4 within the supported 415–466 Hz; anything else (bad storage) becomes 440. */
export function clampA4(a4: unknown): number {
	return typeof a4 === 'number' && Number.isFinite(a4) ? clamp(a4, A4_MIN, A4_MAX) : 440
}
