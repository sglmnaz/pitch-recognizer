import { centsBetween, getClosestNote } from '../notes'
import type { PitchReading } from '../microphone'
import type { View } from './view'

// Within this many cents of a note we call it "in tune" and lock the readout.
const LOCK_CENTS = 5
const CENTS_RANGE = 50

export function createTunerView(root: HTMLElement): View {
	const readout = root.querySelector<HTMLElement>('.readout')!
	const note = root.querySelector<HTMLElement>('.readout__note')!
	const sub = root.querySelector<HTMLElement>('.readout__sub')!
	const needle = root.querySelector<HTMLElement>('.meter__needle')!

	function idle() {
		note.textContent = '--'
		note.classList.add('readout__idle')
		sub.textContent = 'Play a note to begin'
		needle.style.left = '50%'
		readout.classList.remove('readout--locked')
	}

	return {
		onActivate: idle,
		reset: idle,

		onReading(reading: PitchReading | null) {
			if (!reading) {
				note.textContent = '--'
				note.classList.add('readout__idle')
				sub.textContent = 'Listening…'
				readout.classList.remove('readout--locked')
				return
			}

			const closest = getClosestNote(reading.frequency)
			const cents = centsBetween(reading.frequency, closest.frequency)

			note.classList.remove('readout__idle')
			note.textContent = closest.note.split('/')[0]
			sub.textContent = `${reading.frequency.toFixed(1)} Hz · ${cents > 0 ? '+' : ''}${Math.round(cents)} cents`

			const clamped = Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, cents))
			needle.style.left = `${50 + (clamped / CENTS_RANGE) * 50}%`

			readout.classList.toggle('readout--locked', Math.abs(cents) <= LOCK_CENTS)
		},
	}
}
