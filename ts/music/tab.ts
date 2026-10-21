// Technique exercises on tab (Trainer → Tab): pure logic. The exercises are
// generated from simple rules (fingerings, scales, sequences), not copied from
// anyone's book (Giuliani and Carcassi, public domain, are note for note);
// `credit` names the player or book an exercise comes from, when it has one
// (the sources are in docs/adr/0008). The view
// (ts/features/trainer/tab.view.ts) draws them on a strip of tab paper that
// moves by itself and feeds the mic's readings to a session
// (ts/features/trainer/tab.session.ts); nothing here touches the DOM or the
// audio graph, so `npm run check:tab` runs it in Node.
import { clamp } from '../core/math.ts'
import { readJSON, writeJSON } from '../core/storage.ts'
import { t } from '../core/i18n.ts'
import { noteName } from './note-names.ts'

export type Goal = 'agility' | 'sync' | 'speed' | 'strings' | 'legato' | 'sweep' | 'bends' | 'fingerstyle'

export const GOALS: { id: Goal; label: string }[] = [
	{ id: 'agility', label: 'Agility' },
	{ id: 'sync', label: 'Sync' },
	{ id: 'speed', label: 'Speed' },
	{ id: 'strings', label: 'Strings' },
	{ id: 'legato', label: 'Legato' },
	{ id: 'sweep', label: 'Sweep' },
	{ id: 'bends', label: 'Bends' },
	{ id: 'fingerstyle', label: 'Fingerstyle' },
]

export type Level = 'beginner' | 'intermediate' | 'advanced'

export const LEVELS: { id: Level; label: string }[] = [
	{ id: 'beginner', label: 'Beginner' },
	{ id: 'intermediate', label: 'Intermediate' },
	{ id: 'advanced', label: 'Advanced' },
]

/** One note on the tab. String 1 = high E (as tab is written), fret 0 = open. */
export interface TabNote {
	string: number
	fret: number
	/** Start, in steps from the top of the loop (a step = 1 / perBeat of a beat). */
	step: number
	/** Hammer-on or pull-off from the note before (no pick attack to hear), or a
	 * tap with the picking hand (an attack of its own, like a pick). */
	tech?: 'h' | 'p' | 't'
	/** Bend up this many semitones; the note to reach is fret + bend. */
	bend?: number
	/** Length in steps (bends only: the time there is to reach the pitch). */
	length?: number
}

export interface TabExercise {
	id: string
	name: string
	goal: Goal
	level: Level
	/** The player or book it comes from (proper names and a short source), if any. */
	credit?: string
	/** What to do, one line. */
	how: string
	/** Notes per beat: 1 quarters, 2 eighths, 3 triplets, 4 sixteenths. */
	perBeat: number
	notes: TabNote[]
	/** Loop length in steps: whole 4/4 bars, rests filling the last one. */
	steps: number
}

// Standard tuning, string 1 (high E) first.
const OPEN_MIDI = [64, 59, 55, 50, 45, 40]
export const BEATS_PER_BAR = 4
// The fader's range (index.html): slow enough to learn a pattern note by note.
export const MIN_BPM = 10
export const MAX_BPM = 250

export const midiOf = (note: TabNote) => OPEN_MIDI[note.string - 1] + note.fret
/** The pitch the note has to sound at: a bend's target, otherwise the fretted note. */
export const targetMidi = (note: TabNote) => midiOf(note) + (note.bend ?? 0)

export const subdivisionName = (perBeat: number) => t(({ 1: 'quarters', 2: '8ths', 3: 'triplets', 4: '16ths' } as Record<number, string>)[perBeat] ?? '')

/* Builders ------------------------------------------------------------------- */

type Fingering = [string: number, fret: number, tech?: TabNote['tech']]

/** The seven note letters as placeholders ({A} → 'La'): a translation names the notes of its sentence in the chosen system. */
const NOTE_WORDS = () => Object.fromEntries([...'CDEFGAB'].map((letter) => [letter, noteName(letter)]))

/**
 * One note per step from step 0, then the loop padded to whole bars. Name and
 * instructions in the app's language (t() at call time; `vars` fill the
 * instructions' own placeholders).
 */
function exercise(base: Omit<TabExercise, 'notes' | 'steps'>, played: (Fingering | null)[], vars: Record<string, string> = {}): TabExercise {
	const notes: TabNote[] = []
	played.forEach((n, step) => {
		if (n) notes.push({ string: n[0], fret: n[1], step, ...(n[2] ? { tech: n[2] } : {}) })
	})
	const words = NOTE_WORDS()
	return { ...base, name: t(base.name, words), how: t(base.how, { ...words, ...vars }), notes, steps: wholeBars(played.length, base.perBeat) }
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

/** Where `midi` lies within frets [from, to]: on the lowest string that has it there. */
function inPosition(midi: number, from: number, to: number): Fingering {
	for (let string = 6; string >= 1; string--) {
		const fret = midi - OPEN_MIDI[string - 1]
		if (fret >= from && fret <= to) return [string, fret]
	}
	throw new Error(`MIDI ${midi} is not within frets ${from}–${to}`)
}

/** The notes (MIDI) of pitch classes `pcs` from `low` to `high`. */
function scaleRun(pcs: number[], low: number, high: number): number[] {
	const out: number[] = []
	for (let midi = low; midi <= high; midi++) if (pcs.includes(midi % 12)) out.push(midi)
	return out
}

const G_MAJOR = [7, 9, 11, 0, 2, 4, 6]

// A minor pentatonic, position 1 (fret 5), low E to high E.
const PENTATONIC: Fingering[] = [
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

const VAI = 'Steve Vai · 10-Hour Workout (Guitar World, 1990)'
const SATRIANI = 'Joe Satriani · Guitar One, 1999'
const GILBERT = 'Paul Gilbert · Intense Rock (1988)'
const SANDERCOE = 'Justin Sandercoe · JustinGuitar'

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
			level: 'beginner',
			how: 'Classic warm-up: one finger per fret, two strings at a time, frets 5–8. Alternate picking.',
			perBeat: 2,
		},
		[...up, ...[...up].reverse()]
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
			level: 'beginner',
			credit: 'Nita Strauss · Guitar World, 2018',
			how: '1-2-3-4 up the strings, then a fret higher 4-3-2-1 back down. Alternate picking.',
			perBeat: 4,
		},
		[...up, ...down]
	)
}

function pentatonicBox(): TabExercise {
	return exercise(
		{
			id: 'pentatonic-box',
			name: 'Minor pentatonic box',
			goal: 'agility',
			level: 'beginner',
			credit: SANDERCOE,
			how: 'A minor pentatonic at fret 5, up and down, slowly. Keep every finger close to the strings.',
			perBeat: 2,
		},
		[...PENTATONIC, ...PENTATONIC.slice(1, -1).reverse()]
	)
}

function fingerGym(): TabExercise {
	// Finger number = fret number. Each pair across all six strings, from the
	// high E down and back up with the next pair: pick one, hammer the other.
	const pairs = [
		[1, 2],
		[2, 3],
		[3, 4],
		[1, 3],
		[2, 4],
		[1, 4],
	]
	const strings = [1, 2, 3, 4, 5, 6]
	return exercise(
		{
			id: 'finger-gym',
			name: 'Finger Gym',
			goal: 'legato',
			level: 'beginner',
			credit: SANDERCOE,
			how: 'One finger per fret from fret 1: pick the first note, hammer the second just as loud. Pairs 1-2, 2-3, 3-4, 1-3, 2-4, 1-4.',
			perBeat: 2,
		},
		pairs.flatMap(([a, b], k) =>
			(k % 2 ? [...strings].reverse() : strings).flatMap((s): Fingering[] => [
				[s, a],
				[s, b, 'h'],
			])
		)
	)
}

function bends(): TabExercise {
	// Bend, then fret the note the bend had to reach to hear whether it got
	// there. No vibrato: it hides the pitch. The tuner checks it to the cent.
	const notes: TabNote[] = [
		{ string: 2, fret: 12, step: 0, bend: 2, length: 2 },
		{ string: 1, fret: 9, step: 2 },
		{ string: 3, fret: 14, step: 4, bend: 2, length: 2 },
		{ string: 2, fret: 12, step: 6 },
	]
	return {
		id: 'bends',
		name: t('Bend to pitch'),
		goal: 'bends',
		level: 'beginner',
		credit: 'Andy Timmons · Guitar World, 2022',
		how: t('Whole-step bends without vibrato, each checked against the fretted note: B 12 against high E 9, G 14 against B 12.', NOTE_WORDS()),
		perBeat: 1,
		notes,
		steps: 8,
	}
}

function giuliani(): TabExercise {
	// 120 right-hand studies, Op. 1, No. 4, note for note (public domain): C
	// then G7, each beat rising p-i-m from its bass note.
	const c: Fingering[] = [
		[5, 3],
		[4, 2],
		[3, 0],
		[4, 2],
		[3, 0],
		[2, 1],
		[3, 0],
		[2, 1],
		[1, 0],
		[5, 3],
		[2, 1],
		[1, 0],
	]
	const g7: Fingering[] = [
		[5, 2],
		[4, 0],
		[3, 0],
		[4, 0],
		[3, 0],
		[2, 3],
		[3, 0],
		[2, 3],
		[1, 1],
		[5, 2],
		[2, 3],
		[1, 1],
	]
	return exercise(
		{
			id: 'giuliani',
			name: 'Arpeggios p-i-m',
			goal: 'fingerstyle',
			level: 'beginner',
			credit: 'Mauro Giuliani · Op. 1 No. 4 (1812)',
			how: 'C, then G7: thumb on the bass, then index and middle, rising on every beat. Let the notes ring.',
			perBeat: 3,
		},
		[...c, ...g7]
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
			level: 'intermediate',
			credit: VAI,
			how: 'One of the 24 orders of 1-2-3-4, a new one each day. Today: {order}, frets 5–8, on every string and back.',
			perBeat: 4,
		},
		strings.flatMap((s) => order.map((f): Fingering => [s, POSITION + f])),
		{ order: order.join('-') }
	)
}

function rotation(): TabExercise {
	// Each string starts the four fingers one later (1234, 2341, 3412, 4123),
	// up the strings and back down: no two strings in a row share an order.
	const orders = [0, 1, 2, 3].map((k) => [0, 1, 2, 3].map((i) => ((i + k) % 4) + 1))
	const strings = [6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6]
	return exercise(
		{
			id: 'rotation',
			name: 'Rotating 1-2-3-4',
			goal: 'sync',
			level: 'intermediate',
			credit: VAI,
			how: 'One finger per fret at frets 5–8, each string starting a finger later: 1234, 2341, 3412, 4123.',
			perBeat: 4,
		},
		strings.flatMap((s, i) => orders[i % 4].map((f): Fingering => [s, POSITION + f]))
	)
}

function pedal(): TabExercise {
	// Every other note back to a held top note over a falling line: E (high E,
	// fret 12) over D C B A, then C (B string, fret 13) over B A G F.
	const line = (string: number, top: number, frets: number[]) =>
		frets.flatMap((f): Fingering[] => [
			[string, top],
			[string, f],
		])
	const e = line(1, 12, [10, 8, 7, 5])
	const b = line(2, 13, [12, 10, 8, 6])
	return exercise(
		{
			id: 'pedal',
			name: 'Pedal tone',
			goal: 'sync',
			level: 'intermediate',
			how: 'Every other note goes back to the top note: fret 12 on the high E, then 13 on the B. Alternate picking.',
			perBeat: 4,
		},
		[...e, ...e, ...b, ...b]
	)
}

function oneString(): TabExercise {
	// C major up the B string from fret 1 to 13 and back: the hand shifts all the way.
	const frets = scaleFrets(2, [0, 2, 4, 5, 7, 9, 11], 1, 13)
	return exercise(
		{
			id: 'one-string',
			name: 'Major scale on one string',
			goal: 'agility',
			level: 'intermediate',
			credit: SATRIANI,
			how: 'C major up the B string from fret 1 to 13 and back down. Shift cleanly, alternate picking.',
			perBeat: 2,
		},
		[...frets, ...frets.slice(1, -1).reverse()].map((f): Fingering => [2, f])
	)
}

function pentatonicFours(): TabExercise {
	// A minor pentatonic, position 1, in groups of four up and down.
	const fours = (line: Fingering[]) => line.slice(0, -3).flatMap((_, i) => line.slice(i, i + 4))
	return exercise(
		{
			id: 'pentatonic',
			name: 'Pentatonic in fours',
			goal: 'speed',
			level: 'intermediate',
			how: 'A minor pentatonic at fret 5, four notes from each note, up and back down.',
			perBeat: 4,
		},
		[...fours(PENTATONIC), ...fours([...PENTATONIC].reverse())]
	)
}

function threePerString(): TabExercise {
	// G major from the low G (fret 3), the next three scale notes on every string.
	const up = scaleRun(G_MAJOR, 43, 72).map((midi, i): Fingering => {
		const string = 6 - Math.floor(i / 3)
		return [string, midi - OPEN_MIDI[string - 1]]
	})
	return exercise(
		{
			id: 'three-per-string',
			name: 'Three notes per string',
			goal: 'speed',
			level: 'intermediate',
			how: 'G major from fret 3, three notes on every string, up and back. Alternate picking.',
			perBeat: 3,
		},
		[...up, ...up.slice(1, -1).reverse()]
	)
}

function sixNote(): TabExercise {
	// One six-note figure on the high E (A minor pentatonic), over and over:
	// slow until it is perfect, then the metronome a little faster each day.
	const figure = [12, 10, 8, 10, 12, 15]
	return exercise(
		{
			id: 'six-note',
			name: 'Six-note lick',
			goal: 'speed',
			level: 'intermediate',
			credit: 'Paul Gilbert · Guitar One, 1999',
			how: 'One six-note figure on the high E, alternate picking. Slow until it is perfect, then faster day by day.',
			perBeat: 3,
		},
		[1, 2, 3, 4].flatMap(() => figure.map((f): Fingering => [1, f]))
	)
}

function thirds(): TabExercise {
	// G major in 2nd position (frets 2–5), two octaves in thirds up, then back
	// down (not to the very top or bottom, so no note repeats at a turn).
	const run = scaleRun(G_MAJOR, 43, 67)
	const up = run.slice(0, -2).flatMap((midi, i) => [midi, run[i + 2]])
	const down = run
		.slice(1, -3)
		.flatMap((midi, i) => [run[i + 3], midi])
		.reverse()
	return exercise(
		{
			id: 'thirds',
			name: 'Major scale in thirds',
			goal: 'strings',
			level: 'intermediate',
			how: 'G major at fret 2 in thirds: G-B, A-C, B-D… up two octaves and back.',
			perBeat: 2,
		},
		[...up, ...down].map((midi) => inPosition(midi, 2, 5))
	)
}

function outside(): TabExercise {
	// The string changes on every note, a down stroke on the B and an up stroke
	// on the high E, so the pick hops over the pair each time.
	const cell = (b1: number, e1: number, b2: number, e2: number): Fingering[] => [
		[2, b1],
		[1, e1],
		[2, b2],
		[1, e2],
	]
	const low = cell(5, 5, 8, 8)
	const mid = cell(8, 8, 10, 10)
	const high = cell(10, 10, 13, 12)
	return exercise(
		{
			id: 'outside',
			name: 'Outside picking, B and E',
			goal: 'strings',
			level: 'intermediate',
			credit: GILBERT,
			how: 'A new string on every note: down on the B, up on the high E. A minor pentatonic, frets 5–13.',
			perBeat: 4,
		},
		[...low, ...low, ...mid, ...mid, ...high, ...high, ...mid, ...mid]
	)
}

function legatoCombos(): TabExercise {
	// Up the strings like a scale, three notes on each: pick the first, hammer
	// the other two. Fingers 1-3-4 and 1-2-4 in four frets, then over five.
	const combos = [
		[0, 2, 3],
		[0, 1, 3],
		[0, 2, 4],
		[0, 3, 4],
	]
	return exercise(
		{
			id: 'legato-combos',
			name: 'Legato 1-3-4 / 1-2-4',
			goal: 'legato',
			level: 'intermediate',
			credit: 'John Petrucci · Total Guitar, 2020',
			how: 'Pick the first note on each string, hammer the other two. Frets 5–8, then stretched to 5–9.',
			perBeat: 3,
		},
		combos.flatMap((frets) => [6, 5, 4, 3, 2, 1].flatMap((s) => frets.map((f, i): Fingering => (i ? [s, POSITION + 1 + f, 'h'] : [s, POSITION + 1 + f]))))
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
			level: 'intermediate',
			credit: SATRIANI,
			how: 'Pick once, then only hammer-ons and pull-offs. First finger stays on fret 5.',
			perBeat: 4,
		},
		[...trill(6), ...trill(7), ...trill(8)]
	)
}

function tapping(): TabExercise {
	// Tap, pull off to the first finger, hammer with the third, in triplets on
	// the B string; the tap moves from fret 12 to 13 and back.
	const cell = (tap: number): Fingering[] => [
		[2, tap, 't'],
		[2, 5, 'p'],
		[2, 8, 'h'],
	]
	return exercise(
		{
			id: 'tapping',
			name: 'Tapping triplets',
			goal: 'legato',
			level: 'intermediate',
			credit: 'Eddie Van Halen · Eruption (1978)',
			how: 'Tap fret 12 with the picking hand, pull off to 5, hammer 8. No picks. Then tap 13.',
			perBeat: 3,
		},
		[12, 12, 12, 12, 13, 13, 12, 12].flatMap(cell)
	)
}

function carcassi(): TabExercise {
	// 25 Études, Op. 60, No. 1, its first four bars note for note (public
	// domain): C major runs in first position, open strings included.
	const bars: Fingering[] = [
		[5, 3],
		[2, 1],
		[2, 0],
		[3, 2],
		[3, 0],
		[4, 3],
		[4, 2],
		[4, 0],
		[5, 3],
		[1, 0],
		[2, 3],
		[2, 1],
		[2, 0],
		[3, 2],
		[3, 0],
		[4, 3],
		[4, 2],
		[1, 3],
		[1, 1],
		[1, 0],
		[2, 3],
		[2, 1],
		[2, 0],
		[3, 2],
		[3, 0],
		[4, 4],
		[4, 2],
		[4, 0],
		[5, 3],
		[5, 2],
		[5, 0],
		[4, 0],
	]
	return exercise(
		{
			id: 'carcassi',
			name: 'Scale study in C',
			goal: 'fingerstyle',
			level: 'intermediate',
			credit: 'Matteo Carcassi · Op. 60 No. 1',
			how: 'The first four bars: C major runs in first position, index and middle alternating.',
			perBeat: 2,
		},
		bars
	)
}

function fives(): TabExercise {
	// Down the box in fives from each note: five notes in a beat of four start
	// every group somewhere new, so the accent moves round the beat.
	const down = [...PENTATONIC].reverse()
	return exercise(
		{
			id: 'fives',
			name: 'Pentatonic in fives',
			goal: 'speed',
			level: 'advanced',
			credit: 'Eric Johnson · MusicRadar, 2019',
			how: 'A minor pentatonic at fret 5, five notes down from each note, in 16ths. Accent the first of each five.',
			perBeat: 4,
		},
		down.slice(0, -4).flatMap((_, i) => down.slice(i, i + 5))
	)
}

function fiveFour(): TabExercise {
	// D major in 7th position: five notes down from a scale note, four down
	// from the note two steps under it, then again from the next note up.
	const scale = [61, 62, 64, 66, 67, 69, 71, 73, 74]
	const cell = (top: number) => [...scale.slice(top - 4, top + 1).reverse(), ...scale.slice(top - 5, top - 1).reverse()]
	return exercise(
		{
			id: 'five-four',
			name: 'Five and four, down',
			goal: 'speed',
			level: 'advanced',
			credit: 'Al Di Meola, via Alex Skolnick · Guitar Player, 2023',
			how: 'D major at fret 7: A-G-F♯-E-D, F♯-E-D-C♯, then the same from B, C♯ and D.',
			perBeat: 3,
		},
		[5, 6, 7, 8].flatMap(cell).map((midi) => inPosition(midi, 6, 10))
	)
}

function stringSkipping(): TabExercise {
	// G major, three notes per string, on the G and high E strings only: each
	// group on the G string, the next three scale notes on the high E in the
	// same hand position, then up a scale step.
	const g = scaleFrets(3, G_MAJOR, 0, 17)
	const e = scaleFrets(1, G_MAJOR, 0, 19)
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
			level: 'advanced',
			credit: GILBERT,
			how: 'Three notes on the G string, three on the high E, skip the B string. Outside picking.',
			perBeat: 3,
		},
		[...up, ...[...up].reverse()]
	)
}

function sweeps(): TabExercise {
	// Three-string triads Am F G E on the G, B and high E strings, swept up and
	// back (economy picking: the pick keeps going the way it went).
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
			level: 'advanced',
			credit: 'Frank Gambale · Monster Licks & Speed Picking (1988)',
			how: 'Am F G E on the top three strings: one down stroke through G-B-E, up from E.',
			perBeat: 4,
		},
		chords.flatMap((c) => [...shape(c), ...shape(c)])
	)
}

/** Every exercise, in list order (beginner first). `date` picks the day's permutation. */
export function exercises(date = new Date()): TabExercise[] {
	return [
		spider(),
		chromaticShift(),
		pentatonicBox(),
		fingerGym(),
		bends(),
		giuliani(),
		permutations(date),
		rotation(),
		pedal(),
		oneString(),
		pentatonicFours(),
		threePerString(),
		sixNote(),
		thirds(),
		outside(),
		legatoCombos(),
		trills(),
		tapping(),
		carcassi(),
		fives(),
		fiveFour(),
		stringSkipping(),
		sweeps(),
	]
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
const ONSET_WINDOW = 1024
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

// An attack (a pick, a strum) counts once the sound HELD_MS on still stands
// HELD_OVER_NOISE times over the room's noise floor (the mic's, RMS): strings
// ring, noise does not. PC fans at -58 dB swung enough for the detectors to
// fire (a Mic check counted 14 strums in 30 s of silence) but never held 1.9x
// their floor; on field reports the strums and the notes of a Tab session (an
// unplugged electric) held 2.6x and up, most 10-20x. Changes, Tab and the Mic
// check all go through it; the Mic delay calibration does not (a click does
// not ring).
export const HELD_MS = 80
const HELD_OVER_NOISE = 2

/** Attacks confirmed HELD_MS on, at their own times; noise that did not hold is dropped. */
export function createHeldGate() {
	let pending: number[] = []
	return {
		/** One frame: whether it is an attack, its level and the noise floor (RMS). The attacks confirmed now. */
		feed(now: number, attack: boolean, volume: number, noiseFloor: number): number[] {
			if (attack) pending.push(now)
			const due = pending.filter((at) => now - at >= HELD_MS)
			pending = pending.filter((at) => now - at < HELD_MS)
			return volume >= HELD_OVER_NOISE * noiseFloor ? due : []
		},
		reset() {
			pending = []
		},
	}
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
const AFTER_ATTACK_MS = 45
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
// ...but not the first frames: the window then holds the note before and the
// new one, and two notes a whole step apart read as the one in between (C#
// then D# reads D), so a line played a fret off scored a third of its notes
// on time on one string. From 40 ms on the new note fills the window enough;
// 40 and 50 scored the same on every exercise (scripts/tab-check.ts).
const READ_AFTER_PICK_MS = 40

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
		const read = heard.frames.some((f) => f.at >= pick + READ_AFTER_PICK_MS && f.at <= until && f.midi !== null && samePitchClass(f.midi, midi))
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

// The tempo is not kept per exercise: it is one setting (tabBpm), so changing
// exercise keeps the tempo the player chose.
export interface TabRecord {
	/** Fastest tempo with a whole loop on time (0 = none yet). */
	best: number
}

const clampBpm = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? clamp(Math.round(n), MIN_BPM, MAX_BPM) : fallback)

export function loadRecord(exercise: TabExercise): TabRecord {
	const stored = readJSON(RECORD_PREFIX + exercise.id, {}) as Partial<TabRecord> | null
	const best = stored && typeof stored === 'object' ? clampBpm(stored.best, 0) : 0
	return { best: best >= MIN_BPM ? best : 0 }
}

export function saveRecord(exercise: TabExercise, record: TabRecord) {
	writeJSON(RECORD_PREFIX + exercise.id, record)
}
