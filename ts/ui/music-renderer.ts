import { Factory } from 'vexflow'
import type { NoteInfo } from '../core/notes'

const STAFF_ELEMENT_ID = 'staff'
// A strip of chart paper: the stave runs its whole width (the system is given
// the width, not left to size itself to the one note).
const STAFF_WIDTH = 360
const STAFF_HEIGHT = 160
const STAVE_MARGIN = 10
// The band the drawing is cropped to (viewBox): the stave sits at y 50-90
// (VexFlow's default 4 lines of headroom), the written range E3-C6 needs 3
// ledger lines below and 2 above, plus the 8va mark over the clef.
const CROP_TOP = 14
const CROP_HEIGHT = 124

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
		const system = factory.System({ x: STAVE_MARGIN, width: STAFF_WIDTH - 2 * STAVE_MARGIN })

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
		// Scales with its window: trainer.css sets the width, the viewBox crops the
		// empty margins and gives the aspect ratio. VexFlow's inline px size would
		// beat the stylesheet and its width / height would set the ratio: they go.
		const svg = container().querySelector('svg')
		if (svg) {
			for (const attribute of ['style', 'width', 'height']) svg.removeAttribute(attribute)
			svg.setAttribute('viewBox', `0 ${CROP_TOP} ${STAFF_WIDTH} ${CROP_HEIGHT}`)
		}
	} catch (error) {
		// Leave a clean (empty) staff rather than a half-drawn one; the note name
		// is still shown elsewhere, so the round stays playable.
		console.error(`Could not render note "${note.note}":`, error)
		clear()
	}
}
