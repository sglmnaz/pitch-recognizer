// Trainer → Changes: the one seam to the chord recognizer. What the mic hears
// as a chord symbol each frame, whether this frame is a strum, and the ?debug
// hook that feeds fake chords from the console instead.
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import { createChordTracker, withSilenceReset } from '../../music/chords'
import { createStrumDetector } from '../../music/changes'
import { newestEnergy } from '../../music/tab'

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

/**
 * The chord the recognizer hears right now, spelt like Changes.CHANGE_CHORDS
 * (a PITCH_CLASSES root + a chord-theory symbol: 'C', 'Am', 'G7'); null = no
 * chord. Called once per mic frame with the frame's time: the HMM tracker
 * smooths over time.
 */
export function heardChord(now: number): string | null {
	if (fake !== undefined) return fake && /^[A-G][#b]?/.test(fake) ? fake : null
	// Same silence gate as the Chords view. Until the model has loaded the
	// tracker answers "no chord" (and starts the load itself).
	const spectrum = Microphone.getSpectrum()
	return tracker.track(Microphone.isSounding() ? spectrum : null, now, Settings.get().a4)?.chord?.name ?? null
}

/** Forgets what the recognizer was following, so a new session (or a mic restart) starts clean. */
export function resetHeard() {
	tracker.reset()
	strums.reset()
}

// Strums from the energy of the newest samples (Changes.createStrumDetector,
// tuned on a field report), not the mic's attack state or a level rise: those
// fired on the metronome's clicks and on the fingers leaving the strings.
const strums = createStrumDetector()

/** A strum's attack this frame: what tells a played chord from a recognizer flip, and what dates a change. */
export function strummed(now: number): boolean {
	if (fake !== undefined) {
		const strum = fakeStrum
		fakeStrum = false
		return strum
	}
	const wave = Microphone.getWaveform()
	// No noise gate on top: on two field reports the mic's gate (or 10 dB over its noise floor) lost 4–11 strums of ~40.
	return wave !== null && strums.feed(now, newestEnergy(wave))
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
