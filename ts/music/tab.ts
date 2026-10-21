// Technique exercises on tab (Trainer → Tab): pure logic. The exercises are
// generated from simple rules (fingerings, scales, sequences), not copied from
// anyone's book; `from` names whose idea each one is. The view
// (ts/features/trainer/tab.view.ts) draws them on a strip of tab paper that
// moves by itself and feeds the mic's readings to a session
// (ts/features/trainer/tab.session.ts); nothing here touches the DOM or the
// audio graph, so `npm run check:tab` runs it in Node.
import { readJSON, writeJSON } from '../core/storage.ts'

export type Goal = 'agility' | 'sync' | 'speed' | 'strings' | 'legato' | 'sweep' | 'bends'

export const GOALS: { id: Goal; label: string }[] = [
	{ id: 'agility', label: 'Agility' },
	{ id: 'sync', label: 'Sync' },
	{ id: 'speed', label: 'Speed' },
	{ id: 'strings', label: 'Strings' },
	{ id: 'legato', label: 'Legato' },
	{ id: 'sweep', label: 'Sweep' },
	{ id: 'bends', label: 'Bends' },
]

/** One note on the tab. String 1 = high E (as tab is written), fret 0 = open. */
export interface TabNote {
	string: number
	fret: number
	/** Start, in steps from the top of the loop (a step = 1 / perBeat of a beat). */
	step: number
	/** Hammer-on or pull-off from the note before: no pick attack to hear. */
	tech?: 'h' | 'p'
	/** Bend up this many semitones; the note to reach is fret + bend. */
	bend?: number
	/** Length in steps (bends only: the time there is to reach the pitch). */
	length?: number
}

export interface TabExercise {
	id: string
	name: string
	goal: Goal
	/** Whose idea it is, or what kind of drill. */
	from: string
	/** What to do, one line. */
	how: string
	/** Notes per beat: 1 quarters, 2 eighths, 3 triplets, 4 sixteenths. */
	perBeat: number
	startBpm: number
	notes: TabNote[]
	/** Loop length in steps: whole 4/4 bars, rests filling the last one. */
	steps: number
}

// Standard tuning, string 1 (high E) first.
export const OPEN_MIDI = [64, 59, 55, 50, 45, 40]
export const BEATS_PER_BAR = 4
export const MIN_BPM = 30
export const MAX_BPM = 240

export const midiOf = (note: TabNote) => OPEN_MIDI[note.string - 1] + note.fret
/** The pitch the note has to sound at: a bend's target, otherwise the fretted note. */
export const targetMidi = (note: TabNote) => midiOf(note) + (note.bend ?? 0)

export const subdivisionName = (perBeat: number) => ({ 1: 'quarters', 2: '8ths', 3: 'triplets', 4: '16ths' })[perBeat] ?? ''

/* Builders ------------------------------------------------------------------- */

type Fingering = [string: number, fret: number, tech?: 'h' | 'p']

/** One note per step from step 0, then the loop padded to whole bars. */
function exercise(base: Omit<TabExercise, 'notes' | 'steps'>, played: (Fingering | null)[]): TabExercise {
	const notes: TabNote[] = []
	played.forEach((n, step) => {
		if (n) notes.push({ string: n[0], fret: n[1], step, ...(n[2] ? { tech: n[2] } : {}) })
	})
	return { ...base, notes, steps: wholeBars(played.length, base.perBeat) }
}

const wholeBars = (steps: number, perBeat: number) => Math.ceil(steps / (perBeat * BEATS_PER_BAR)) * perBeat * BEATS_PER_BAR

/** The 24 orders of fingers 1-2-3-4, 1234 first. */
export const PERMUTATIONS: number[][] = (() => {
	const out: number[][] = []
	const walk = (left: number[], acc: number[]) => {
		if (!left.length) out.push(acc)
		for (const f of left)
			walk(
				left.filter((x) => x !== f),
				[...acc, f]
			)
	}
	walk([1, 2, 3, 4], [])
	return out
})()

/** A different order each day, the same one all day. */
export const permutationOfDay = (date: Date) => PERMUTATIONS[Math.floor(date.getTime() / 86_400_000 - date.getTimezoneOffset() / 1440) % PERMUTATIONS.length]

/** Frets on `string` within [from, to] whose pitch class is in `pcs`. */
function scaleFrets(string: number, pcs: number[], from: number, to: number): number[] {
	const out: number[] = []
	for (let fret = from; fret <= to; fret++) if (pcs.includes((OPEN_MIDI[string - 1] + fret) % 12)) out.push(fret)
	return out
}

// Frets 5–8 for fingers 1–4: the hand sits in the middle of the neck, where
// the frets are neither wide nor cramped (the usual advice for these drills).
const POSITION = 4

function spider(): TabExercise {
	// Up through the string pairs, 1 and 3 on the lower string, 2 and 4 on the
	// upper, then the same notes back down.
	const up: Fingering[] = []
	for (const [low, high] of [
		[6, 5],
		[5, 4],
		[4, 3],
		[3, 2],
		[2, 1],
	]) {
		up.push([low, POSITION + 1], [high, POSITION + 2], [low, POSITION + 3], [high, POSITION + 4])
	}
	return exercise(
		{
			id: 'spider',
			name: 'Spider 1-3 / 2-4',
			goal: 'agility',
			from: 'Classic warm-up: fingers apart from any scale shape',
			how: 'One finger per fret, two strings at a time, frets 5–8. Alternate picking.',
			perBeat: 2,
			startBpm: 60,
		},
		[...up, ...[...up].reverse()]
	)
}

function permutations(date: Date): TabExercise {
	const order = permutationOfDay(date)
	const strings = [6, 5, 4, 3, 2, 1, 2, 3, 4, 5]
	return exercise(
		{
			id: 'permutations',
			name: 'Finger permutations',
			goal: 'agility',
			from: 'One of the 24 orders of 1-2-3-4, a new one each day',
			how: `Today: ${order.join('-')}, frets 5–8, on every string and back.`,
			perBeat: 4,
			startBpm: 50,
		},
		strings.flatMap((s) => order.map((f): Fingering => [s, POSITION + f]))
	)
}

function chromaticShift(): TabExercise {
	// 1-2-3-4 up the strings, a fret higher 4-3-2-1 back down: picking and
	// fretting have to land together on every note.
	const up = [6, 5, 4, 3, 2, 1].flatMap((s) => [1, 2, 3, 4].map((f): Fingering => [s, POSITION + f]))
	const down = [1, 2, 3, 4, 5, 6].flatMap((s) => [4, 3, 2, 1].map((f): Fingering => [s, POSITION + 1 + f]))
	return exercise(
		{
			id: 'chromatic',
			name: 'Chromatic shift',
			goal: 'sync',
			from: 'Hand synchronization drill (John Petrucci, Rock Discipline)',
			how: '1-2-3-4 up the strings, then a fret higher 4-3-2-1 back down. Alternate picking.',
			perBeat: 4,
			startBpm: 50,
		},
		[...up, ...down]
	)
}

function bursts(): TabExercise {
	// Short bursts on one string with rests to reset, then the same speed with a
	// string change (Troy Grady: speed on one string first, string changes in short chunks).
	const b = (n: number): (Fingering | null)[] => Array.from({ length: n }, (): Fingering => [2, 7])
	const rest = (n: number) => Array<null>(n).fill(null)
	const change: Fingering[] = [
		[2, 5],
		[2, 7],
		[1, 5],
		[1, 7],
	]
	return exercise(
		{
			id: 'bursts',
			name: 'Single-string bursts',
			goal: 'speed',
			from: 'Troy Grady (Cracking the Code): one string first, then string changes',
			how: 'Bursts of 4, 6 and 8 on the B string, then a string change. Relax in the rests.',
			perBeat: 4,
			startBpm: 70,
		},
		[...b(4), ...rest(4), ...b(6), ...rest(2), ...b(8), ...rest(8), ...change, ...change, ...rest(8)]
	)
}

function pentatonicFours(): TabExercise {
	// A minor pentatonic, position 1, in groups of four up and down.
	const scale: Fingering[] = [
		[6, 5],
		[6, 8],
		[5, 5],
		[5, 7],
		[4, 5],
		[4, 7],
		[3, 5],
		[3, 7],
		[2, 5],
		[2, 8],
		[1, 5],
		[1, 8],
	]
	const fours = (line: Fingering[]) => line.slice(0, -3).flatMap((_, i) => line.slice(i, i + 4))
	return exercise(
		{
			id: 'pentatonic',
			name: 'Pentatonic in fours',
			goal: 'speed',
			from: 'Standard sequence for alternate picking',
			how: 'A minor pentatonic at fret 5, four notes from each note, up and back down.',
			perBeat: 4,
			startBpm: 50,
		},
		[...fours(scale), ...fours([...scale].reverse())]
	)
}

function stringSkipping(): TabExercise {
	// G major, three notes per string, on the G and high E strings only: each
	// group on the G string, the next three scale notes on the high E in the
	// same hand position, then up a scale step (Paul Gilbert).
	const pcs = [7, 9, 11, 0, 2, 4, 6]
	const g = scaleFrets(3, pcs, 0, 17)
	const e = scaleFrets(1, pcs, 0, 19)
	const up: Fingering[] = []
	for (let k = 1; k <= 5; k++) {
		const low = g.slice(k, k + 3)
		const high = e.filter((f) => f >= low[0] - 1).slice(0, 3)
		up.push(...low.map((f): Fingering => [3, f]), ...high.map((f): Fingering => [1, f]))
	}
	return exercise(
		{
			id: 'skipping',
			name: 'G major on strings 1 and 3',
			goal: 'strings',
			from: 'Paul Gilbert: string skipping with alternate picking',
			how: 'Three notes on the G string, three on the high E, skip the B string. Outside picking.',
			perBeat: 3,
			startBpm: 50,
		},
		[...up, ...[...up].reverse()]
	)
}

function trills(): TabExercise {
	// First finger held at fret 5 on the B string; trill against it with 2, 3 and 4.
	const trill = (f: number): Fingering[] => Array.from({ length: 8 }, (_, i): Fingering => (i === 0 ? [2, 5] : i % 2 ? [2, f, 'h'] : [2, 5, 'p']))
	return exercise(
		{
			id: 'trills',
			name: 'Anchored trills',
			goal: 'legato',
			from: 'Joe Satriani: one finger per fret, hammer-ons and pull-offs',
			how: 'Pick once, then only hammer-ons and pull-offs. First finger stays on fret 5.',
			perBeat: 4,
			startBpm: 50,
		},
		[...trill(6), ...trill(7), ...trill(8)]
	)
}

function sweeps(): TabExercise {
	// Three-string triads Am F G E on the G, B and high E strings, swept up and
	// back (Frank Gambale's economy picking: the pick keeps going the way it went).
	const chords = [
		[14, 13, 12],
		[10, 10, 8],
		[12, 12, 10],
		[13, 12, 12],
	]
	const shape = ([g, b, e]: number[]): Fingering[] => [
		[3, g],
		[2, b],
		[1, e],
		[2, b],
	]
	return exercise(
		{
			id: 'sweeps',
			name: 'Three-string sweeps',
			goal: 'sweep',
			from: 'Frank Gambale: economy picking, the pick keeps its direction',
			how: 'Am F G E on the top three strings: one down stroke through G-B-E, up from E.',
			perBeat: 4,
			startBpm: 50,
		},
		chords.flatMap((c) => [...shape(c), ...shape(c)])
	)
}

function bends(): TabExercise {
	// Bend, then fret the note the bend had to reach to hear whether it got there
	// (Andy Timmons). The tuner checks it to the cent.
	const notes: TabNote[] = [
		{ string: 2, fret: 7, step: 0, bend: 2, length: 2 },
		{ string: 1, fret: 4, step: 2 },
		{ string: 3, fret: 7, step: 4, bend: 1, length: 2 },
		{ string: 2, fret: 4, step: 6 },
	]
	return {
		id: 'bends',
		name: 'Bend to pitch',
		goal: 'bends',
		from: 'Andy Timmons: bend, then check against the fretted note',
		how: 'Whole step on the B string, half step on the G, each followed by the note to reach.',
		perBeat: 1,
		startBpm: 60,
		notes,
		steps: 8,
	}
}

/** Every exercise, in list order. `date` picks the day's permutation. */
export function exercises(date = new Date()): TabExercise[] {
	return [spider(), permutations(date), chromaticShift(), bursts(), pentatonicFours(), stringSkipping(), trills(), sweeps(), bends()]
}

export const EXERCISE_IDS = exercises().map((e) => e.id)
export const exerciseById = (id: string, date = new Date()) => exercises(date).find((e) => e.id === id) ?? exercises(date)[0]

/* Hearing notes -------------------------------------------------------------- */

/** A note the player started: its pitch (MIDI, rounded) and when it began (ms). */
export interface NoteEvent {
	midi: number
	at: number
}

/* Picks. The pitch pipeline's own attack rule (the level doubling over its
   running envelope) suits single notes after silence, but a note picked while
   the one before still rings rises far less: on a synthetic run of the spider
   through the real pipeline it caught 1 pick in 40, so repeated notes counted
   once and everything else was dated by its pitch change, late. This detector
   watches the energy of the newest ONSET_WINDOW samples instead (23 ms at
   44.1 kHz, two periods of the low E): a pick is a jump over the quietest
   level of the last ONSET_LOOK_MS and over the frame before. Tuned on the
   same synthetic runs (scripts/tab-check.ts): 1.3 and 1.3 found 98% of the
   picks with few false ones; lower ratios fired on the beating of a ringing
   note, higher ones missed fast repeated notes. */
export const ONSET_WINDOW = 1024
const ONSET_LOOK_MS = 100
const ONSET_RISE = 1.3
const ONSET_STEP = 1.3
// Mean square of ~-64 dBFS: under it nothing is a pick (room noise, a click far away).
const ONSET_FLOOR = 4e-7
// One pick fires once: its own attack keeps rising for a frame or two.
const ONSET_REFRACTORY_MS = 60

/** Mean square of the newest `n` samples of an input window. */
export function newestEnergy(samples: Float32Array, n = ONSET_WINDOW): number {
	const from = Math.max(0, samples.length - n)
	let sum = 0
	for (let i = from; i < samples.length; i++) sum += samples[i] * samples[i]
	return sum / Math.max(1, samples.length - from)
}

export interface OnsetDetector {
	/** One frame's newest energy (newestEnergy): true when it is a pick. */
	feed(now: number, energy: number): boolean
	reset(): void
}

export function createOnsetDetector(): OnsetDetector {
	let history: { at: number; energy: number }[] = []
	let last = Number.NEGATIVE_INFINITY
	return {
		feed(now, energy) {
			history = history.filter((h) => now - h.at <= ONSET_LOOK_MS)
			const quietest = history.length ? Math.min(...history.map((h) => h.energy)) : Number.POSITIVE_INFINITY
			const before = history.length ? history[history.length - 1].energy : Number.POSITIVE_INFINITY
			history.push({ at: now, energy })
			const pick = energy > ONSET_FLOOR && energy > ONSET_RISE * quietest && energy > ONSET_STEP * before && now - last > ONSET_REFRACTORY_MS
			if (pick) last = now
			return pick
		},
		reset() {
			history = []
			last = Number.NEGATIVE_INFINITY
		},
	}
}

// The frame's own pitch (Microphone FrameStats.pitch) counts from this clarity.
// The tuner wants 0.85 for a new note, but two strings ringing together (the
// note just picked over the one before) drop the clarity to 0.6–0.8 and the
// frame read as unpitched for a whole note. On the synthetic runs 0.4–0.7 all
// did as well; 0.6 keeps a margin above room noise (under 0.3).
export const MIN_CLARITY = 0.6

// A pitch must hold this many frames in a row to count (a frame is ~16 ms):
// one stray frame at a string change is not a note.
export const STABLE_FRAMES = 2
// A picked note is dated at its pick: the detector fires about this long after
// the pick enters the window (median on the synthetic runs). Calibration knob:
// raise it if clean notes read late on real guitars.
export const ATTACK_LATENCY_MS = 15
// A hammer-on or pull-off has no attack: only the pitch moves, and the frame's
// own pitch follows once the new note fills about half the 93 ms window, then
// holds STABLE_FRAMES. On the synthetic trills this dates them within 10 ms.
// Calibration knob, like ATTACK_LATENCY_MS.
export const LEGATO_LATENCY_MS = 70
// An attack that brings no pitch (a muted pluck, a click) is forgotten after this.
const ATTACK_KEEP_MS = 250
// Right after a pick the input window still holds mostly the note before, so
// its pitch is not the new note's: give the new one this long to take over.
export const AFTER_ATTACK_MS = 45
// After this much silence the same note picked again is a new note.
const SILENCE_MS = 120

/** Same note name in any octave. The detector reads one pitch from strings
 * that ring together and often lands an octave off (a subharmonic of two
 * notes, or the octave of the louder one), so notes match by pitch class. */
export const samePitchClass = (a: number, b: number) => (((a - b) % 12) + 12) % 12 === 0

export interface NoteFollower {
	/** One mic frame: the rounded MIDI heard (null = none) and whether it was an attack. */
	feed(now: number, midi: number | null, attack: boolean): NoteEvent | null
	reset(): void
}

/**
 * Turns per-frame pitches into note starts. A new note is a new pitch that
 * holds, or the same pitch picked again (an attack in between): so repeated
 * notes on one fret count one by one, and a hammer-on counts without a pick.
 */
export function createNoteFollower(): NoteFollower {
	let current: number | null = null
	let candidate: { midi: number; since: number; frames: number } | null = null
	let attackAt: number | null = null
	let silentSince: number | null = null

	return {
		feed(now, midi, attack) {
			if (attack) {
				attackAt = now
				current = null
				candidate = null
			}
			if (attackAt !== null && now - attackAt > ATTACK_KEEP_MS) attackAt = null
			if (attackAt !== null && now - attackAt < AFTER_ATTACK_MS) return null
			if (midi === null) {
				candidate = null
				silentSince ??= now
				if (now - silentSince > SILENCE_MS) current = null
				return null
			}
			silentSince = null
			if (candidate && samePitchClass(candidate.midi, midi)) candidate.frames++
			else candidate = { midi, since: now, frames: 1 }
			if (candidate.frames < STABLE_FRAMES || (current !== null && samePitchClass(midi, current))) return null
			current = midi
			const at = attackAt !== null ? attackAt - ATTACK_LATENCY_MS : candidate.since - LEGATO_LATENCY_MS
			attackAt = null
			return { midi, at }
		},
		reset() {
			current = candidate = attackAt = silentSince = null
		},
	}
}

/* Judging -------------------------------------------------------------------- */

export type Mark = 'hit' | 'early' | 'late' | 'miss'

// On time = within a third of a step of where the note falls, never under
// HIT_FLOOR_MS (detection jitters by a frame or two) nor over HIT_MS (at slow
// tempos a third of a step would forgive a clearly late note).
export const HIT_FLOOR_MS = 60
export const HIT_MS = 110

/** The windows for a step of `stepMs`: on time within `hit`, early or late within `reach`. */
export function noteWindow(stepMs: number): { hit: number; reach: number } {
	const hit = Math.max(HIT_FLOOR_MS, Math.min(HIT_MS, stepMs / 3))
	return { hit, reach: Math.max(hit, stepMs / 2) }
}

const markOf = (dt: number, hit: number): Mark => (dt < -hit ? 'early' : dt > hit ? 'late' : 'hit')

/**
 * Judges one note due at `at` from note starts alone: the first event with its
 * pitch class within reach decides, and is used up (`used` holds the indexes of
 * events already spent).
 */
export function judgeNote(at: number, midi: number, stepMs: number, events: NoteEvent[], used: Set<number>): Mark {
	const { hit, reach } = noteWindow(stepMs)
	const index = events.findIndex((e, i) => !used.has(i) && samePitchClass(e.midi, midi) && Math.abs(e.at - at) <= reach)
	if (index < 0) return 'miss'
	used.add(index)
	return markOf(events[index].at - at, hit)
}

// After a pick, the frames this long after the detector fired are searched for
// the note's pitch class. The note just picked is the loudest thing for a
// moment, but with other strings still ringing the detector reads it only in
// some frames: one is enough. 120 ms = a 16th at 125 BPM.
export const PICK_LISTEN_MS = 120

// Pitch-class profile of a frame's power spectrum: each note E2–E6 scores the
// power at its first four harmonics (weighted 1/h, best of three bins), folded
// into its pitch class; the twelve add up to 1. Where two strings ring
// together the single pitch reads one of them, often the wrong one; the note
// just picked still shows as its pitch class rising here.
const CHROMA_LOW = 40
const CHROMA_HIGH = 88
const CHROMA_HARMONICS = 4

/** Pitch-class profile (12 shares summing to 1) of a power spectrum with bins `binHz` wide. */
export function chromaOf(power: ArrayLike<number>, binHz: number, a4 = 440): Float32Array {
	const out = new Float32Array(12)
	const top = power.length / 2 - 2
	for (let m = CHROMA_LOW; m <= CHROMA_HIGH; m++) {
		const f0 = a4 * 2 ** ((m - 69) / 12)
		let score = 0
		for (let h = 1; h <= CHROMA_HARMONICS; h++) {
			const bin = Math.round((f0 * h) / binHz)
			if (bin > top) break
			score += Math.max(power[bin - 1], power[bin], power[bin + 1]) / h
		}
		out[m % 12] += score
	}
	const sum = out.reduce((a, b) => a + b, 0)
	if (sum > 0) for (let i = 0; i < 12; i++) out[i] /= sum
	return out
}

// A pick counts for a note on the spectrum when the note's pitch class gains
// at least CHROMA_RISE of the profile from the frames before the pick to those
// after it, and holds at least CHROMA_SHARE of it. 0.05–0.12 and 0.12–0.2
// scored the same: right notes all found, a fret off almost never. Tuned on synthetic ringing
// strings (scripts/tab-check.ts) against the same runs played a fret off.
const CHROMA_RISE = 0.08
const CHROMA_SHARE = 0.15
// Before = the frames this long before the pick; after = from this long after it (the window fills).
const CHROMA_BEFORE_MS = 100
const CHROMA_SETTLE_MS = 40

/** What the mic gave a session: picks (dated), every frame's raw pitch and pitch-class profile, note starts. */
export interface Hearing {
	/** Pick times, ascending, already dated back by ATTACK_LATENCY_MS. */
	picks: number[]
	frames: { at: number; midi: number | null; chroma: Float32Array | null }[]
	events: NoteEvent[]
}

const meanShare = (frames: Hearing['frames'], from: number, to: number, pc: number): number | null => {
	let sum = 0
	let n = 0
	for (const f of frames) {
		if (f.at < from || f.at > to || !f.chroma) continue
		sum += f.chroma[pc]
		n++
	}
	return n ? sum / n : null
}

/** Whether most frames just before the pick at `pick` already read `midi`'s pitch class. */
function rangBefore(frames: Hearing['frames'], pick: number, midi: number): boolean {
	const heardAt = pick + ATTACK_LATENCY_MS
	let read = 0
	let n = 0
	for (const f of frames) {
		if (f.at < heardAt - CHROMA_BEFORE_MS || f.at >= heardAt || f.midi === null) continue
		n++
		if (samePitchClass(f.midi, midi)) read++
	}
	return n > 0 && read / n >= 0.5
}

/** Whether the pick at `pick` brought pitch class `pc` up on the spectrum before `until`. */
function risesAfter(frames: Hearing['frames'], pick: number, until: number, pc: number): boolean {
	const heardAt = pick + ATTACK_LATENCY_MS
	const before = meanShare(frames, heardAt - CHROMA_BEFORE_MS, heardAt - 1, pc) ?? 0
	const after = meanShare(frames, heardAt + CHROMA_SETTLE_MS, until, pc)
	return after !== null && after >= CHROMA_SHARE && after - before >= CHROMA_RISE
}

/** Picks and note starts a judged note used up, by time. */
export interface Spent {
	picks: Set<number>
	events: Set<number>
}

/**
 * Judges one note due at `at`, knowing which note it should be. The pick
 * nearest the note decides if any frame right after it reads the note's pitch
 * class (before the next pick); otherwise a note start with that pitch class
 * (a hammer-on, a pull-off, a pick the detector missed) does. Either is used up.
 */
export function judgeHeard(at: number, midi: number, stepMs: number, heard: Hearing, spent: Spent, repeat = false): Mark {
	const { hit, reach } = noteWindow(stepMs)
	const near = heard.picks.filter((p) => !spent.picks.has(p) && Math.abs(p - at) <= reach).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))
	const pc = ((midi % 12) + 12) % 12
	for (const pick of near) {
		const next = heard.picks.find((p) => p > pick) ?? Number.POSITIVE_INFINITY
		const until = Math.min(pick + ATTACK_LATENCY_MS + PICK_LISTEN_MS, next + ATTACK_LATENCY_MS)
		const read = heard.frames.some((f) => f.at >= pick && f.at <= until && f.midi !== null && samePitchClass(f.midi, midi))
		// A note already ringing before the pick (the one played before) is no
		// evidence of this one, unless the tab repeats that note here.
		const fresh = repeat || !rangBefore(heard.frames, pick, midi)
		if (!(read && fresh) && !risesAfter(heard.frames, pick, until, pc)) continue
		spent.picks.add(pick)
		// The follower dates the same pick: that start is this note's too.
		spent.events.add(pick)
		return markOf(pick - at, hit)
	}
	const start = heard.events.find((e) => !spent.events.has(e.at) && samePitchClass(e.midi, midi) && Math.abs(e.at - at) <= reach)
	if (!start) return 'miss'
	spent.events.add(start.at)
	return markOf(start.at - at, hit)
}

// A bend has reached its note within this many cents.
export const BEND_CENTS = 30

/** Cents from `frequency` to MIDI `midi` at reference `a4`. */
export const centsTo = (frequency: number, midi: number, a4 = 440) => 1200 * Math.log2(frequency / (a4 * 2 ** ((midi - 69) / 12)))

// Speed up like Changes: +SPEED_STEP BPM after CLEAN_LOOPS loops with every note on time.
export const CLEAN_LOOPS = 2
export const SPEED_STEP = 5

export const accuracy = (marks: Mark[]) => (marks.length ? Math.round((100 * marks.filter((m) => m === 'hit').length) / marks.length) : 0)

/* Records -------------------------------------------------------------------- */

const RECORD_PREFIX = 'pitch-recognizer:tab:'

export interface TabRecord {
	/** Fastest tempo with a whole loop on time (0 = none yet). */
	best: number
	/** The tempo last practised at, where the next session starts. */
	bpm: number
}

const clampBpm = (n: unknown, fallback: number) =>
	typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n))) : fallback

export function loadRecord(exercise: TabExercise): TabRecord {
	const stored = readJSON(RECORD_PREFIX + exercise.id, {}) as Partial<TabRecord> | null
	const best = stored && typeof stored === 'object' ? clampBpm(stored.best, 0) : 0
	return { best: best >= MIN_BPM ? best : 0, bpm: clampBpm(stored?.bpm, exercise.startBpm) }
}

export function saveRecord(exercise: TabExercise, record: TabRecord) {
	writeJSON(RECORD_PREFIX + exercise.id, record)
}
