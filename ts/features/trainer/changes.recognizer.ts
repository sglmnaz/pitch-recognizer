// Trainer → Changes: the one seam to the chord recognizer. What the mic hears
// as a chord symbol each frame, whether this frame is a strum, and the ?debug
// hook that feeds fake chords from the console instead.
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import { createChordTracker, PITCH_CLASSES, withSilenceReset } from '../../music/chords'

/**
 * What the recognizer hears right now. Contract: `symbol` spelt like
 * Changes.CHANGE_CHORDS (a PITCH_CLASSES root + a chord-theory symbol: 'C',
 * 'Am', 'G7'), `rootPc` 0–11 (C = 0), `type` the symbol after the root ('',
 * 'm', '7'), `confidence` 0–1; null = no chord. Called once per mic frame
 * with the frame's time: the HMM tracker smooths over time.
 */
export interface HeardChord {
	symbol: string
	rootPc: number
	type: string
	confidence?: number
}

// Our own tracker (ts/music/chords.ts): the Chords view's smoother never
// shares state with it. Like the Chords view, it forgets the chord after
// this much continuous silence.
const SILENCE_RESET_MS = 300
const tracker = withSilenceReset(createChordTracker(), SILENCE_RESET_MS)

// ?debug: chords fed by hand from the console (the mic is often unavailable
// where the UI is tested). undefined = off, null = "no chord". Each fed
// chord counts as strummed once.
let fake: string | null | undefined
let fakeStrum = false

export function heardChord(now: number): HeardChord | null {
	if (fake !== undefined) {
		const root = fake?.match(/^[A-G][#b]?/)?.[0]
		return fake && root ? { symbol: fake, rootPc: PITCH_CLASSES.indexOf(root), type: fake.slice(root.length) } : null
	}
	// Same silence gate as the Chords view. Until the model has loaded the
	// tracker answers "no chord" (and starts the load itself).
	const spectrum = Microphone.getSpectrum()
	const analysis = tracker.track(Microphone.isSounding() ? spectrum : null, now, Settings.get().a4)
	const chord = analysis?.chord
	if (!chord) return null
	const root = chord.notes[0]
	return { symbol: chord.name, rootPc: PITCH_CLASSES.indexOf(root), type: chord.name.slice(root.length), confidence: chord.score }
}

/** Forgets what the recognizer was following, so a new session (or a mic restart) starts clean. */
export function resetHeard() {
	tracker.reset()
	levels = []
	lastStrum = Number.NEGATIVE_INFINITY
}

// The pitch pipeline's onset rule wants the level to double over its running
// envelope: right for single notes, but a chord strummed while the previous
// one still rings often rises less, so changes went uncounted. A rise of
// STRUM_RISE over the quietest level of the last STRUM_WINDOW_MS counts too.
// A held chord only decays, so it never trips this; a recognizer flip on it
// stays a flip.
const STRUM_RISE = 1.5
const STRUM_WINDOW_MS = 250
// One strum fires once. The mic's 'attack' state lasts several frames after
// an onset, and a strum's level keeps rising for a few: counted every frame,
// a phone logged ~16 strums a beat and any of them could date a change.
const STRUM_REFRACTORY_MS = 120
let levels: { at: number; volume: number }[] = []
let lastStrum = Number.NEGATIVE_INFINITY

/** A strum's attack this frame: what tells a played chord from a recognizer flip. */
export function strummed(now: number): boolean {
	if (fake !== undefined) {
		const strum = fakeStrum
		fakeStrum = false
		return strum
	}
	const { reason, volume } = Microphone.getStats()
	levels.push({ at: now, volume })
	levels = levels.filter((level) => level.at >= now - STRUM_WINDOW_MS)
	const quietest = Math.min(...levels.map((level) => level.volume))
	if (!(reason === 'attack' || (Microphone.isSounding() && volume > STRUM_RISE * quietest))) return false
	// Only the first frame of a run of attack frames, after STRUM_REFRACTORY_MS without one.
	const fresh = now - lastStrum >= STRUM_REFRACTORY_MS
	lastStrum = now
	return fresh
}

/** ?debug chords are being fed: a session may start without the mic. */
export const faking = () => fake !== undefined

/**
 * ?debug: window.pluckChanges.hear('G') feeds that chord as if strummed
 * (null = silence; hear('Am', false) = the recognizer flipping a ringing
 * chord), calling `drive` every frame so the view can run without the mic;
 * .off() returns to the mic. A timer, not rAF: rAF stalls in a hidden or
 * embedded test pane.
 */
export function installDebugHook(drive: () => void) {
	if (!new URLSearchParams(location.search).has('debug')) return
	let loop = 0
	const tick = () => {
		loop = 0
		if (fake === undefined) return
		drive()
		loop = window.setTimeout(tick, 16)
	}
	;(window as unknown as { pluckChanges: object }).pluckChanges = {
		hear(symbol: string | null, strum = true) {
			fake = symbol
			fakeStrum = strum && symbol !== null
			if (!loop) tick()
		},
		off() {
			fake = undefined
		},
	}
}
