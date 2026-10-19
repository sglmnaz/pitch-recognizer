// Ear training (Trainer → Intervals / Chords): pure round logic. The view
// (ts/views/trainer.ts) plays the questions with ts/sound.ts and feeds the
// answers back; nothing here touches the DOM or the audio graph, so
// `npm run check:ear` runs it in Node.

export type Exercise = 'intervals' | 'chords'
export type Direction = 'up' | 'down' | 'harmonic'

export interface Interval {
	id: string
	semitones: number
	name: string
}

export const INTERVALS: Interval[] = [
	{ id: 'm2', semitones: 1, name: 'minor 2nd' },
	{ id: 'M2', semitones: 2, name: 'major 2nd' },
	{ id: 'm3', semitones: 3, name: 'minor 3rd' },
	{ id: 'M3', semitones: 4, name: 'major 3rd' },
	{ id: 'P4', semitones: 5, name: 'perfect 4th' },
	{ id: 'TT', semitones: 6, name: 'tritone' },
	{ id: 'P5', semitones: 7, name: 'perfect 5th' },
	{ id: 'm6', semitones: 8, name: 'minor 6th' },
	{ id: 'M6', semitones: 9, name: 'major 6th' },
	{ id: 'm7', semitones: 10, name: 'minor 7th' },
	{ id: 'M7', semitones: 11, name: 'major 7th' },
	{ id: 'P8', semitones: 12, name: 'octave' },
]

export interface Quality {
	id: string
	name: string
	/** Chord tones in semitones above the root. */
	formula: number[]
	/**
	 * How it is strummed, low to high, in semitones above the bass root: the
	 * common barre / movable shape with the root on the low E string, so it
	 * sounds like a guitar and not a piano block chord.
	 */
	voicing: number[]
}

export const QUALITIES: Quality[] = [
	{ id: 'maj', name: 'major', formula: [0, 4, 7], voicing: [0, 7, 12, 16, 19, 24] }, // E shape
	{ id: 'm', name: 'minor', formula: [0, 3, 7], voicing: [0, 7, 12, 15, 19, 24] }, // Em shape
	{ id: 'dim', name: 'diminished', formula: [0, 3, 6], voicing: [0, 6, 12, 15] },
	{ id: 'aug', name: 'augmented', formula: [0, 4, 8], voicing: [0, 4, 8, 12, 16] },
	{ id: 'sus2', name: 'suspended 2nd', formula: [0, 2, 7], voicing: [0, 7, 12, 14, 19] },
	{ id: 'sus4', name: 'suspended 4th', formula: [0, 5, 7], voicing: [0, 7, 12, 17, 19, 24] },
	{ id: '7', name: 'dominant 7th', formula: [0, 4, 7, 10], voicing: [0, 7, 10, 16, 19, 24] }, // E7 shape
	{ id: 'maj7', name: 'major 7th', formula: [0, 4, 7, 11], voicing: [0, 7, 11, 16, 19] },
	{ id: 'm7', name: 'minor 7th', formula: [0, 3, 7, 10], voicing: [0, 7, 10, 15, 19, 24] }, // Em7 shape
	{ id: 'm7b5', name: 'half-diminished', formula: [0, 3, 6, 10], voicing: [0, 6, 10, 15] },
]

export const DEFAULT_INTERVALS = INTERVALS.map((i) => i.id)
export const DEFAULT_QUALITIES = ['maj', 'm', '7', 'maj7', 'm7']

// Comfortable ranges, as MIDI notes. An interval's first note sits where both
// it and anything up to an octave away stay between A2 and C5 (a voice or a
// guitar can answer it; a phone speaker still plays it). Chord roots run along
// the low E string, E2–E3, so the widest voicing (two octaves) tops out at E5.
const INTERVAL_LOW = 45 // A2
const INTERVAL_HIGH = 72 // C5
export const CHORD_ROOT_LOW = 40 // E2
export const CHORD_ROOT_HIGH = 52 // E3
// Strum: one string every 30 ms, low to high, like a downstroke.
export const STRUM_S = 0.03

export interface Question {
	exercise: Exercise
	/** Id of the right answer (an INTERVALS or QUALITIES id). */
	id: string
	/** First note of an interval (the reference), or the chord's bass root. */
	root: number
	/** Intervals only: how the two notes are played. */
	direction: Direction
}

export const labelOf = (exercise: Exercise, id: string) =>
	(exercise === 'intervals' ? INTERVALS : QUALITIES).find((item) => item.id === id)?.name ?? id

/** The enabled ids that still exist, in table order; all defaults if none survive. */
export function pool(exercise: Exercise, enabled: readonly string[]): string[] {
	const table = exercise === 'intervals' ? INTERVALS : QUALITIES
	const ids = table.map((item) => item.id).filter((id) => enabled.includes(id))
	return ids.length > 0 ? ids : exercise === 'intervals' ? DEFAULT_INTERVALS : DEFAULT_QUALITIES
}

const pick = <T>(items: readonly T[], rng: () => number) => items[Math.floor(rng() * items.length)]

/**
 * A fresh question: never the same answer twice in a row (when there is a
 * choice), and never the same starting note, so the ear cannot lean on the
 * previous round. `direction` 'mixed' picks one per question.
 */
export function makeQuestion(
	exercise: Exercise,
	enabled: readonly string[],
	direction: Direction | 'mixed',
	previous: Question | null,
	rng: () => number = Math.random
): Question {
	const ids = pool(exercise, enabled)
	const fresh = ids.length > 1 && previous?.exercise === exercise ? ids.filter((id) => id !== previous.id) : ids
	const id = pick(fresh, rng)
	const dir: Direction = exercise === 'chords' ? 'up' : direction === 'mixed' ? pick(['up', 'down', 'harmonic'] as const, rng) : direction
	// Descending starts high and falls; ascending and harmonic start low.
	const [low, high] =
		exercise === 'chords' ? [CHORD_ROOT_LOW, CHORD_ROOT_HIGH] : dir === 'down' ? [INTERVAL_LOW + 12, INTERVAL_HIGH] : [INTERVAL_LOW, INTERVAL_HIGH - 12]
	const roots = Array.from({ length: high - low + 1 }, (_, i) => low + i).filter((root) => root !== previous?.root)
	return { exercise, id, root: pick(roots, rng), direction: dir }
}

/** MIDI notes in play order for `id` on this question's root (another id: what that answer would sound like). */
export function notesOf(question: Question, id = question.id): number[] {
	if (question.exercise === 'chords') {
		const quality = QUALITIES.find((q) => q.id === id)!
		return quality.voicing.map((step) => question.root + step)
	}
	const semitones = INTERVALS.find((i) => i.id === id)!.semitones
	return [question.root, question.root + (question.direction === 'down' ? -semitones : semitones)]
}

export interface Playback {
	notes: { midi: number; at: number }[]
	/** Per-note level, lower when several ring together so the sum does not clip. */
	gain: number
}

/** When each note sounds, in seconds from now. `gapS` separates melodic interval notes. */
export function playback(question: Question, id: string, gapS: number): Playback {
	const midis = notesOf(question, id)
	if (question.exercise === 'chords') {
		// ~1/sqrt(strings): the noise bursts add up like uncorrelated signals.
		return { notes: midis.map((midi, i) => ({ midi, at: i * STRUM_S })), gain: 1 / Math.sqrt(midis.length) }
	}
	if (question.direction === 'harmonic') return { notes: midis.map((midi) => ({ midi, at: 0 })), gain: 0.7 }
	return { notes: midis.map((midi, i) => ({ midi, at: i * gapS })), gain: 1 }
}

/**
 * The interval a sung or played answer names: the distance from the reference
 * (the first note) to `midi` in the question's direction (harmonic: up from
 * the lower note). A voice an octave off (a low voice under a high question,
 * or past the octave) is folded back; the reference's own pitch class names
 * nothing. Null too when the interval is not in `enabled`: a held note that
 * is not one of the buttons is more likely a stray than an answer.
 */
export function intervalOfAnswer(question: Question, midi: number, enabled: readonly string[] = DEFAULT_INTERVALS): string | null {
	const distance = question.direction === 'down' ? question.root - midi : midi - question.root
	const semitones = distance >= 1 && distance <= 12 ? distance : ((distance % 12) + 12) % 12
	const id = INTERVALS.find((i) => i.semitones === semitones)?.id ?? null
	return id && pool('intervals', enabled).includes(id) ? id : null
}

/* Session: score, streak, best (persisted), per-answer stats ----------------- */
export interface Stat {
	id: string
	right: number
	total: number
}

interface Session {
	question: Question | null
	/** The first answer of the round decided it; later taps only audition. */
	answered: boolean
	score: number
	streak: number
	best: number
	stats: Map<string, Stat>
}

// Same pattern as game.ts: the best streak survives sessions, the rest does not.
const bestKey = (exercise: Exercise) => `pitch-recognizer:best:${exercise}`

function loadBest(exercise: Exercise): number {
	try {
		return Number(localStorage.getItem(bestKey(exercise))) || 0
	} catch {
		return 0
	}
}

function saveBest(exercise: Exercise, value: number) {
	try {
		localStorage.setItem(bestKey(exercise), String(value))
	} catch {
		// Storage may be unavailable (private mode, Node); best stays in memory.
	}
}

const newSession = (exercise: Exercise): Session => ({
	question: null,
	answered: false,
	score: 0,
	streak: 0,
	best: loadBest(exercise),
	stats: new Map(),
})

const sessions: Record<Exercise, Session> = { intervals: newSession('intervals'), chords: newSession('chords') }

export const getSession = (exercise: Exercise): Readonly<Session> => sessions[exercise]

/** Starts the next round of `exercise`. */
export function next(
	exercise: Exercise,
	enabled: readonly string[],
	direction: Direction | 'mixed',
	rng: () => number = Math.random
): Question {
	const session = sessions[exercise]
	session.question = makeQuestion(exercise, enabled, direction, session.question, rng)
	session.answered = false
	return session.question
}

/**
 * Scores an answer. Only the round's first answer counts (score, streak,
 * stats); `counted` is false for the taps after it, which just audition.
 */
export function answer(exercise: Exercise, id: string): { correct: boolean; counted: boolean } {
	const session = sessions[exercise]
	const question = session.question
	if (!question) return { correct: false, counted: false }
	const correct = id === question.id
	if (session.answered) return { correct, counted: false }
	session.answered = true
	const stat = session.stats.get(question.id) ?? { id: question.id, right: 0, total: 0 }
	stat.total++
	if (correct) stat.right++
	session.stats.set(question.id, stat)
	if (correct) {
		session.score++
		session.streak++
		if (session.streak > session.best) {
			session.best = session.streak
			saveBest(exercise, session.best)
		}
	} else {
		session.streak = 0
	}
	return { correct, counted: true }
}

/** Session stats, weakest first (lowest share right, then most attempts). */
export function weakest(exercise: Exercise): Stat[] {
	return [...sessions[exercise].stats.values()].sort((a, b) => a.right / a.total - b.right / b.total || b.total - a.total)
}
