import * as Microphone from './microphone'
import * as MusicRenderer from './music-renderer'
import { getNoteName } from './notes'

const startButton = document.getElementById('startButton') as HTMLButtonElement
const stopButton = document.getElementById('stopButton') as HTMLButtonElement
const noteDisplay = document.getElementById('note')

startButton!.addEventListener('click', () => {
	startButton!.disabled = true
	stopButton.disabled = false

	MusicRenderer.displayNewNote()

	Microphone.start(
		(frequency) => {
			const note = getNoteName(frequency)
			noteDisplay!.textContent = note

			if (MusicRenderer.checkIfFrequencyIsCorrect(frequency)) MusicRenderer.displayNewNote()
		},
		() => {
			alert('Could not access microphone.')
			startButton!.disabled = false
			stopButton.disabled = true
		}
	)
})

stopButton.addEventListener('click', () => {
	startButton!.disabled = false
	stopButton.disabled = true

	Microphone.stop()

	noteDisplay!.textContent = '--'

	MusicRenderer.clear()
})
