import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { chordModelReady, loadChordModel, PITCH_CLASSES, resetChordTracking, trackChord, withSilenceReset } from '../../music/chords'
import type { View } from '../../ui/view'
import { createChordModes } from './chord-library.view'

// A new label (chord or "none") must win for this long before it is shown.
// trackChord's HMM already keeps a strum's attack and decay from flickering
// through other chords; this only hides brief changes. (250 ms before the
// HMM, which made a chord change appear ~0.5 s late.)
const CHORD_CONFIRM_MS = 150
// The HMM forgets the chord only after this much continuous silence, so a
// short gap between strums (the gate closing on a decay) keeps its evidence.
const SILENCE_RESET_MS = 300
const tracker = withSilenceReset({ track: trackChord, reset: resetChordTracking }, SILENCE_RESET_MS)

/** Only Listen uses the mic (the modes call micNeedChanged on a switch). */
export function createChordsView(root: HTMLElement): View {
	const name = root.querySelector<HTMLButtonElement>('.readout__note')!
	const sub = root.querySelector<HTMLElement>('.readout__sub')!
	const chromaRow = root.querySelector<HTMLElement>('.chroma')!
	// Listen / Library / Identify switch; the shown chord opens in the Library.
	const modes = createChordModes(root)
	name.addEventListener('click', () => shown && modes.openChord(shown))

	const bins = PITCH_CLASSES.map((pitchClass) => {
		const bin = document.createElement('div')
		bin.className = 'chroma__bin'
		const bar = document.createElement('span')
		bar.className = 'chroma__bar'
		const label = document.createElement('span')
		label.className = 'chroma__label'
		label.textContent = pitchClass
		bin.append(bar, label)
		chromaRow.append(bin)
		return { bin, bar }
	})

	let shown: string | null = null
	let candidate: string | null = null
	let candidateSince = 0

	function render(label: string | null, notes: string[], idleText: string) {
		name.textContent = label ?? '--'
		name.classList.toggle('readout__idle', label === null)
		// The chord is a button into the Library; nothing to open while idle.
		name.disabled = label === null
		name.setAttribute('aria-label', label ? `Open ${label} in the Library` : 'No chord recognized')
		sub.textContent = label ? notes.join(' · ') : idleText
	}

	function drawChroma(chroma: number[], tones: string[]) {
		bins.forEach(({ bin, bar }, i) => {
			bar.style.transform = `scaleY(${chroma[i]})`
			bin.classList.toggle('chroma__bin--tone', tones.includes(PITCH_CLASSES[i]))
		})
	}

	function idle(text = 'Strum a chord') {
		tracker.reset()
		shown = null
		candidate = null
		render(null, [], text)
		drawChroma(new Array(12).fill(0), [])
	}

	return {
		onActivate: () => {
			// The model's weights load on first visit; frames are skipped until then.
			loadChordModel().catch(() => {}) // logged once by the loader
			idle()
			modes.onActivate()
		},
		reset: () => idle(),
		wantsMic: () => modes.listening(),

		onReading() {
			if (!modes.listening() || !chordModelReady()) return
			const spectrum = Microphone.getSpectrum()
			// Same adaptive silence gate as the tuner, so quiet sources (an
			// unplugged electric) are analysed too. The app's own strums (a sound
			// started elsewhere still ringing) count as silence, not as a chord.
			const loud = Microphone.isSounding() && !Sound.isRinging()
			const now = performance.now()
			const analysis = tracker.track(loud ? spectrum : null, now, Settings.get().a4)
			const chord = analysis?.chord ?? null

			const label = chord?.name ?? null
			if (label !== candidate) {
				candidate = label
				candidateSince = now
			}
			if (candidate !== shown && now - candidateSince >= CHORD_CONFIRM_MS) {
				shown = candidate
				render(shown, chord?.notes ?? [], loud ? 'Not a chord' : 'Listening…')
			}

			drawChroma(analysis?.chroma ?? new Array(12).fill(0), shown && chord?.name === shown ? chord.notes : [])
		},
	}
}
