import { centsBetween, getClosestNote, pitchClass, type NoteInfo } from './notes'
import * as Settings from './settings'
import type { PitchReading } from './microphone'

// The note must be held in tune for at least this long to win the round.
// Long enough to rule out a passing glissando, short enough to feel responsive.
const HOLD_MS = 350

export interface Evaluation {
	/** Note closest to the current reading, or null while silent. */
	detected: NoteInfo | null
	/** Cents off the detected note (-50..+50), for the tuner display. */
	cents: number | null
	/** Whether the detected note currently matches the target. */
	onTarget: boolean
	/** Whether the target has been held in tune long enough to win the round. */
	solved: boolean
}

export interface GameState {
	target: NoteInfo
	score: number
	streak: number
	best: number
}

// The best streak persists across sessions; score and streak are per-session.
const BEST_KEY = 'pitch-recognizer:best'

function loadBest(): number {
	try {
		return Number(localStorage.getItem(BEST_KEY)) || 0
	} catch {
		return 0
	}
}

function saveBest(value: number) {
	try {
		localStorage.setItem(BEST_KEY, String(value))
	} catch {
		// Storage may be unavailable (private mode); best stays in memory.
	}
}

let target: NoteInfo
let score = 0
let streak = 0
let best = loadBest()
let onTargetSince: number | null = null

/** Does a detected note satisfy the target, honouring the any-octave setting? */
function matches(detected: NoteInfo): boolean {
	if (Settings.get().matchAnyOctave) {
		return pitchClass(detected.note) === pitchClass(target.note)
	}
	return detected.note === target.note
}

/** Picks a fresh target note from the active pool, avoiding an immediate repeat. */
export function nextNote(): NoteInfo {
	const notes = Settings.activePool()
	let candidate: NoteInfo
	do {
		candidate = notes[Math.floor(Math.random() * notes.length)]
	} while (notes.length > 1 && candidate === target)

	target = candidate
	onTargetSince = null
	return target
}

/** Gives up on the current note: resets the streak and picks a new target. */
export function skip(): NoteInfo {
	streak = 0
	return nextNote()
}

/**
 * Scores a single reading against the current target. `now` is a monotonic
 * timestamp (e.g. from `performance.now()`) used to measure the hold duration.
 */
export function evaluate(reading: PitchReading | null, now: number): Evaluation {
	if (!reading) {
		onTargetSince = null
		return { detected: null, cents: null, onTarget: false, solved: false }
	}

	const detected = getClosestNote(reading.frequency)
	const cents = centsBetween(reading.frequency, detected.frequency)
	const onTarget = matches(detected)

	if (!onTarget) {
		onTargetSince = null
		return { detected, cents, onTarget: false, solved: false }
	}

	if (onTargetSince === null) {
		onTargetSince = now
	}

	const solved = now - onTargetSince >= HOLD_MS
	if (solved) {
		score += 1
		streak += 1
		if (streak > best) {
			best = streak
			saveBest(best)
		}
		onTargetSince = null
	}

	return { detected, cents, onTarget, solved }
}

/** Ensures the current target is still in the active pool; re-picks if not. */
export function revalidateTarget() {
	if (!target || !Settings.activePool().some((note) => note.note === target.note)) {
		nextNote()
	}
}

export function getState(): GameState {
	return { target, score, streak, best }
}
