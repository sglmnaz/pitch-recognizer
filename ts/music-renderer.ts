import * as Vex from 'vexflow'
import { possibleFrequenciesWithoutAccidentals } from './notes'

let noteToRender: { note: any; frequency?: number; altName?: string }

let vf: Vex.Factory = new Vex.Factory({
	renderer: { elementId: 'vexFlow', width: 150, height: 200 },
})

export function clear() {
	vf.getContext().clear()
}

export function displayNewNote() {
	clear()

	const score = vf.EasyScore()
	const system = vf.System()

	noteToRender = pickRandomNote()
	var noteModified = noteToRender.note[0] + (+noteToRender.note[1] + 1)
	console.log(noteToRender.altName)

	const stave = {
		voices: [score.voice(score.notes(`${noteModified}/w`, { stem: 'up' }))],
	}

	system.addStave(stave).addClef('treble', undefined, '8va').addTimeSignature('4/4')

	vf.draw()
}

function pickRandomNote() {
	return possibleFrequenciesWithoutAccidentals[Math.floor(Math.random() * possibleFrequenciesWithoutAccidentals.length)]
}

export function checkIfFrequencyIsCorrect(frequency) {
	if (!noteToRender) return false

	return Math.abs(frequency - noteToRender.frequency!) < 10
}
