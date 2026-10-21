import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { parseChordSymbol } from '../../music/chord-library'
import { chordModelReady, loadChordModel, PITCH_CLASSES, resetChordTracking, trackChord, withSilenceReset } from '../../music/chords'
import { scoped } from '../../ui/dom'
import type { View } from '../../ui/view'
import { chordName, createChordModes } from './chord-library.view'
import { noteName } from '../../music/note-names'

// A new label (chord or "none") must win for this long before it is shown.
// trackChord's HMM already keeps a strum's attack and decay from flickering
// through other chords; this only hides brief changes. (250 ms before the
// HMM, which made a chord change appear ~0.5 s late.)
const CHORD_CONFIRM_MS = 150
// The HMM forgets the chord only after this much continuous silence, so a
// short gap between strums (the gate closing on a decay) keeps its evidence.
const SILENCE_RESET_MS = 300
const tracker = withSilenceReset({ track: trackChord, reset: resetChordTracking }, SILENCE_RESET_MS)

const OPEN_HINT = 'Voicings, notes and keys of the chord you play'

/** 'C#m7' → 'C# minor 7th', the name the Library gives it. */
function fullName(symbol: string) {
	const type = parseChordSymbol(symbol)?.type
	return type ? chordName(noteName(symbol.replace(/^([A-G][#b]?).*/, '$1')), type.name) : []
}

/** Only Listen uses the mic (the modes call micNeedChanged on a switch). */
export function createChordsView(root: HTMLElement): View {
	const { $ } = scoped(root)
	const symbol = $('.chord-reader__symbol')
	const name = $('.chord-reader__name')
	const notesLine = $('.chord-reader__notes')
	const openKey = $<HTMLButtonElement>('.chord-open__key')
	const openHint = $('.chord-open__sub')
	// Listen / Library / Identify switch; the shown chord opens in the Library.
	const modes = createChordModes(root)
	// aria-disabled, not disabled: the key keeps focus when the chord fades out.
	openKey.addEventListener('click', () => shown && modes.openChord(shown))

	const bars = PITCH_CLASSES.map((pitchClass) => {
		const bin = document.createElement('div')
		bin.className = 'chroma__bin'
		const bar = document.createElement('span')
		bar.className = 'chroma__bar'
		const label = document.createElement('span')
		label.className = 'chroma__label'
		label.textContent = noteName(pitchClass)
		bin.append(bar, label)
		$('.chroma').append(bin)
		return bin
	})

	let shown: string | null = null
	let candidate: string | null = null
	let candidateSince = 0

	function render(label: string | null, notes: string[], idleText: string) {
		const shownName = label && noteName(label)
		symbol.textContent = shownName ?? '--'
		symbol.classList.toggle('lcd__dim', label === null)
		name.replaceChildren(...(label ? fullName(label) : []))
		notesLine.textContent = label ? notes.map(noteName).join(' · ') : idleText
		openKey.setAttribute('aria-disabled', String(label === null))
		openKey.setAttribute('aria-label', label ? `Open ${shownName} in the Library` : 'Open in the Library (no chord yet)')
		openHint.textContent = label ? `Voicings, notes and keys for ${shownName}` : OPEN_HINT
	}

	// Each column lights from the bottom up to its level (chords.css clips the dot column).
	function drawChroma(chroma: number[], tones: string[]) {
		bars.forEach((bin, i) => {
			bin.style.setProperty('--level', String(chroma[i]))
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
