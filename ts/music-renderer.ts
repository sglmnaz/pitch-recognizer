import { Factory } from 'vexflow'
import type { NoteInfo } from './notes'

const STAFF_ELEMENT_ID = 'staff'
const STAFF_WIDTH = 220
const STAFF_HEIGHT = 220

function container(): HTMLElement {
	const element = document.getElementById(STAFF_ELEMENT_ID)
	if (!element) throw new Error(`Missing #${STAFF_ELEMENT_ID} element`)
	return element
}

export function clear() {
	container().innerHTML = ''
}

export function render(note: NoteInfo) {
	// Rebuild from scratch each round: VexFlow's Factory accumulates systems,
	// so reusing one instance would stack every note ever drawn.
	clear()

	try {
		const factory = new Factory({
			renderer: { elementId: STAFF_ELEMENT_ID, width: STAFF_WIDTH, height: STAFF_HEIGHT },
		})
		const score = factory.EasyScore()
		const system = factory.System()

		// Parse the first enharmonic spelling, e.g. "C#4/Db4" -> letter C,
		// accidental #, octave 4. The note may or may not carry an accidental.
		const spelling = note.note.split('/')[0]
		const match = spelling.match(/^([A-G])([#b]?)(\d)$/)
		if (!match) throw new Error(`Unrecognised note: ${note.note}`)
		const [, letter, accidental, octaveDigit] = match

		// The playable range dips to E2; written an octave up under an 8va treble
		// clef it stays readable without a forest of ledger lines.
		const octave = Number(octaveDigit) + 1
		const easyScoreNote = `${letter}${accidental}${octave}/w`

		system
			.addStave({ voices: [score.voice(score.notes(easyScoreNote, { stem: 'up' }))] })
			.addClef('treble', undefined, '8va')
			.addTimeSignature('4/4')

		factory.draw()
	} catch (error) {
		// Leave a clean (empty) staff rather than a half-drawn one; the note name
		// is still shown elsewhere, so the round stays playable.
		console.error(`Could not render note "${note.note}":`, error)
		clear()
	}
}
