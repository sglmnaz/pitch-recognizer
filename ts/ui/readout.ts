// The note + needle readout of the Tuner and the Trainer's Notes: a big note
// name, a line under it, a needle over ±CENTS_RANGE and a green lock.
import { clamp } from '../core/math'

const CENTS_RANGE = 50

export function createReadout(root: HTMLElement) {
	const readout = root.querySelector<HTMLElement>('.readout')!
	const note = root.querySelector<HTMLElement>('.readout__note')!
	const sub = root.querySelector<HTMLElement>('.readout__sub')!
	const needle = root.querySelector<HTMLElement>('.meter__needle')!

	return {
		/** "--" and `text`; `centre` false leaves the needle where it was (the tuner between notes). */
		idle(text: string, centre = true) {
			note.textContent = '--'
			note.classList.add('readout__idle')
			sub.textContent = text
			if (centre) needle.style.left = '50%'
			readout.classList.remove('readout--locked')
		},

		/** A note `cents` off, the needle clamped to the meter. */
		show(label: string, line: string, cents: number, locked: boolean) {
			note.classList.remove('readout__idle')
			note.textContent = label
			sub.textContent = line
			needle.style.left = `${50 + (clamp(cents, -CENTS_RANGE, CENTS_RANGE) / CENTS_RANGE) * 50}%`
			readout.classList.toggle('readout--locked', locked)
		},
	}
}
