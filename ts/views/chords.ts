import * as Microphone from '../microphone'
import { PITCH_CLASSES, recognizeChord } from '../chords'
import type { View } from './view'

// Below this input RMS nothing is analysed (the strum has died away).
// ponytail: fixed gate; reuse the tuner's adaptive noise floor if quiet rooms
// or loud ones need it.
const MIN_VOLUME = 0.008
// A new label (chord or "none") must win for this long before it is shown, so
// a strum's attack and decay do not flicker through other chords.
const CHORD_CONFIRM_MS = 250

function rootMeanSquare(input: Float32Array): number {
	let sumSquares = 0
	for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i]
	return Math.sqrt(sumSquares / input.length)
}

export function createChordsView(root: HTMLElement): View {
	const name = root.querySelector<HTMLElement>('.readout__note')!
	const sub = root.querySelector<HTMLElement>('.readout__sub')!
	const chromaRow = root.querySelector<HTMLElement>('.chroma')!

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
		sub.textContent = label ? notes.join(' · ') : idleText
	}

	function drawChroma(chroma: number[], tones: string[]) {
		bins.forEach(({ bin, bar }, i) => {
			bar.style.transform = `scaleY(${chroma[i]})`
			bin.classList.toggle('chroma__bin--tone', tones.includes(PITCH_CLASSES[i]))
		})
	}

	function idle(text = 'Strum a chord') {
		shown = null
		candidate = null
		render(null, [], text)
		drawChroma(new Array(12).fill(0), [])
	}

	return {
		onActivate: () => idle(),
		reset: () => idle(),

		onReading() {
			const input = Microphone.getWaveform()
			const spectrum = Microphone.getSpectrum()
			const loud = input !== null && rootMeanSquare(input) >= MIN_VOLUME
			const analysis = loud && spectrum ? recognizeChord(spectrum.spectrumDb, spectrum.binHz) : null
			const chord = analysis?.chord ?? null

			const now = performance.now()
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
