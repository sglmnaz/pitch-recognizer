// Chord-change trainer (Trainer → Changes): pure logic. The view
// (ts/views/changes.ts) feeds it the chord the mic hears every frame and the
// metronome's downbeats; nothing here touches the DOM or the audio graph, so
// `npm run check:changes` runs it in Node.

/** Open chords a beginner changes between, spelt as the recognizer names them. */
export const CHANGE_CHORDS = ['C', 'G', 'D', 'A', 'E', 'Am', 'Em', 'Dm', 'F', 'A7', 'D7', 'E7', 'G7']

// The classic beginner pairs (Justin Sandercoe's one-minute changes start
// with these), plus the two four-chord progressions every songbook opens with.
export const PRESETS: string[][] = [
	['G', 'C'],
	['C', 'D'],
	['A', 'D'],
	['D', 'E'],
	['Em', 'C'],
	['Am', 'E'],
	['G', 'D'],
	['C', 'Am'],
	['A', 'E'],
	['D', 'Em'],
	['C', 'G', 'Am', 'F'],
	['G', 'D', 'Em', 'C'],
]

export const MAX_CHORDS = 4
export const DEFAULT_SEQUENCE = ['G', 'C']
export const DURATIONS = [30, 60, 120]
export const BEATS_PER_CHORD = [1, 2, 4]
export const MIN_BPM = 40
export const MAX_BPM = 160

/** Stored or hand-edited input: known chords, no repeats, at most four; under two = the default pair. */
export function validSequence(value: unknown): string[] {
	const chords = Array.isArray(value) ? value.filter((s, i, all) => CHANGE_CHORDS.includes(s) && all.indexOf(s) === i).slice(0, MAX_CHORDS) : []
	return chords.length >= 2 ? chords : [...DEFAULT_SEQUENCE]
}

/* Stability ---------------------------------------------------------------- */

// A chord counts once the recognizer has named it for STABLE_MS: long enough
// that a strum's attack (and a metronome click) passing through other chord
// names is not a change, short enough that a fast change still lands. The
// HMM tracker (ts/chords.ts) already smooths over time, so this only has to
// outlast a few frames of its switching (the raw per-frame recognizer
// needed 150 ms); more would just add latency.
export const STABLE_MS = 70
// Gaps shorter than this inside a run are bridged: a frame or two of another
// name (the relative minor, "no chord" while the spectrum refills) must not
// restart the clock of a chord that is still ringing. Four frames at 60 fps.
export const FLICKER_MS = 70
// A run that takes over from a steady chord with less than this of anything
// else (silence, other names) between them is a direct flip, what a held C
// does when the recognizer swaps it for Am (they share two notes). Measured
// from the first frame that left the old chord, so any frame rate works.
const GAP_MS = 40
// A strum's attack this long before a run starts still makes it a played
// chord: the tracker names a chord ~200–370 ms after its strum (check:chords,
// bench median 283 ms), with room to spare.
const ATTACK_LEAD_MS = 500

export interface Onset {
	symbol: string
	/** When the run started, not when it became stable: the in-time judge needs the strum's time. */
	at: number
	/** Played, not a flip: a gap or another name came between it and the
	 * previous chord, or a strum was heard. Only fresh onsets are changes. */
	fresh: boolean
}

export interface Stabilizer {
	/** One frame: the chord heard (null = none), and whether a strum's attack
	 * was heard. Returns the run's onset on the frame it becomes stable, once per run. */
	feed(heard: string | null, now: number, attack?: boolean): Onset | null
	/** The chord heard steadily right now, or null. */
	current(): string | null
}

export function createStabilizer(): Stabilizer {
	let symbol: string | null = null
	let since = 0
	let seen = -Infinity
	let stable = false
	let direct = false
	let lastAttack = -Infinity
	// Whether the last frame was the run's chord, and when the frames stopped being it.
	let onRun = true
	let gapStart = 0
	// What has been heard instead during a gap, and since when: when the gap
	// outlasts FLICKER_MS it becomes the run, dated from its first frame.
	let challenger: string | null = null
	let challengerSince = 0

	return {
		feed(heard, now, attack = false) {
			if (attack) lastAttack = now
			if (heard === symbol) {
				seen = now
				challenger = null
				onRun = true
			} else {
				if (onRun) {
					gapStart = now
					onRun = false
				}
				if (heard !== challenger) {
					challenger = heard
					challengerSince = now
				}
				if (now - seen > FLICKER_MS) {
					direct = stable && symbol !== null && challengerSince - gapStart < GAP_MS
					symbol = challenger
					since = challengerSince
					seen = now
					stable = false
					challenger = null
					// This frame is the new run's (the challenger is what was heard).
					onRun = true
				}
			}
			// Measured to the last frame it was heard: the bridge over a gap does not make a blip longer.
			if (symbol === null || stable || seen - since < STABLE_MS) return null
			stable = true
			return { symbol, at: since, fresh: !direct || lastAttack >= since - ATTACK_LEAD_MS }
		},
		current: () => (stable ? symbol : null),
	}
}

/* One-minute changes --------------------------------------------------------- */

// After a counted change nothing counts for this long: a recognizer flipping
// back and forth around one strum is not two changes. That allows ~150
// changes a minute, far past anyone's pace between two open chords.
export const REFRACTORY_MS = 400

export interface ChangeCounter {
	/** A newly stable chord: 'start' for the first chord of the sequence heard, 'change' for a counted change. */
	onChord(onset: Onset): 'start' | 'change' | null
	readonly count: number
	/** The chord being played (null before the first one). */
	readonly at: string | null
	/** The chord to change to next. */
	target(): string
}

/**
 * Counts changes around the sequence: the first chord of it heard is where
 * the player starts (any of them, a pair has no first), then only the next
 * chord in order counts, and only when played (a fresh onset) at least
 * REFRACTORY_MS after the last one. Wrong chords and re-strums do nothing.
 */
export function createChangeCounter(sequence: string[]): ChangeCounter {
	let index: number | null = null
	let count = 0
	let lastAt = -Infinity
	return {
		onChord({ symbol, at, fresh }) {
			if (index === null) {
				const i = sequence.indexOf(symbol)
				if (i < 0) return null
				index = i
				lastAt = at
				return 'start'
			}
			const next = (index + 1) % sequence.length
			if (symbol !== sequence[next] || !fresh || at - lastAt < REFRACTORY_MS) return null
			index = next
			lastAt = at
			count++
			return 'change'
		},
		get count() {
			return count
		},
		get at() {
			return index === null ? null : sequence[index]
		},
		target: () => sequence[index === null ? 0 : (index + 1) % sequence.length],
	}
}

/* In time -------------------------------------------------------------------- */

export type Mark = 'hit' | 'early' | 'late' | 'miss'

// On time = within HIT_MS of the downbeat; at fast tempos a quarter of the
// slot, but never under HIT_FLOOR_MS. Recognition jitter is a frame or two
// plus the spectrum's refill, so a tighter window marks clean changes late
// (at 160 BPM, one beat per chord, a quarter slot would be ±94 ms).
export const HIT_MS = 200
export const HIT_FLOOR_MS = 120

/**
 * Judges one change: `onsets` are the times the slot's target chord started
 * ringing (stable runs). Each onset belongs to its nearest downbeat, so only
 * those within half a slot count; the first one decides.
 */
export function judge(downbeat: number, slotMs: number, onsets: number[]): Mark {
	const hit = Math.max(HIT_FLOOR_MS, Math.min(HIT_MS, slotMs / 4))
	const inSlot = onsets.filter((t) => t >= downbeat - slotMs / 2 && t < downbeat + slotMs / 2)
	if (!inSlot.length) return 'miss'
	const dt = Math.min(...inSlot) - downbeat
	return dt < -hit ? 'early' : dt > hit ? 'late' : 'hit'
}

// Auto speed-up: +SPEED_STEP BPM after CLEAN_PASSES passes through the
// sequence with every change on time, like the metronome's speed trainer.
export const CLEAN_PASSES = 2
export const SPEED_STEP = 5

/** Clean changes in a row after `mark`, and whether that run just earned a speed-up (the run then restarts). */
export function afterMark(clean: number, mark: Mark, perPass: number): { clean: number; speedUp: boolean } {
	if (mark !== 'hit') return { clean: 0, speedUp: false }
	return clean + 1 >= CLEAN_PASSES * perPass ? { clean: 0, speedUp: true } : { clean: clean + 1, speedUp: false }
}

export const accuracy = (marks: Mark[]) => (marks.length ? Math.round((100 * marks.filter((m) => m === 'hit').length) / marks.length) : 0)

/* Records -------------------------------------------------------------------- */

const RECORD_PREFIX = 'pitch-recognizer:changes:'
export const HISTORY = 10

// A pair is the same drill either way round (G C G… = C G C…); longer
// sequences keep their order.
export const recordKey = (sequence: string[]) => RECORD_PREFIX + (sequence.length === 2 ? [...sequence].sort() : sequence).join('-')

export interface ChangeRecord {
	best: number
	/** Oldest first, the last HISTORY sessions. */
	history: number[]
}

// Stored per session length: 30 s and 2 min counts do not compete with 60 s.
function readAll(sequence: string[]): { [seconds: string]: unknown } {
	try {
		const all = JSON.parse(localStorage.getItem(recordKey(sequence)) ?? '{}')
		return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
	} catch {
		// No storage (private mode, Node) or a hand-edited value: no record.
		return {}
	}
}

export function loadRecord(sequence: string[], seconds: number): ChangeRecord {
	const entry = readAll(sequence)[seconds] as Partial<ChangeRecord> | undefined
	const history = Array.isArray(entry?.history) ? entry.history.filter((n) => Number.isFinite(n) && n >= 0).slice(-HISTORY) : []
	return { best: Math.max(Number(entry?.best) || 0, ...history), history }
}

/** Stores a finished session; returns the record as it was before it (for the delta). */
export function saveSession(sequence: string[], seconds: number, count: number): ChangeRecord {
	const before = loadRecord(sequence, seconds)
	const all = readAll(sequence)
	all[seconds] = { best: Math.max(before.best, count), history: [...before.history, count].slice(-HISTORY) }
	try {
		localStorage.setItem(recordKey(sequence), JSON.stringify(all))
	} catch {
		// Storage unavailable: the result still shows, it just is not kept.
	}
	return before
}
