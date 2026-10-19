// ?debug field diagnostics: a live line with what the gate sees, and a recorder that
// captures the raw mic stream exactly as the app hears it (same device, voice
// processing off), so a problem on someone's guitar and phone can be replayed
// with `npm run bench` instead of guessed at.
import * as Microphone from '../core/microphone'

const DEBUG = new URLSearchParams(location.search).has('debug')
const RECORD_SECONDS = 20
const debugLine = document.createElement('p')
let debugFrame = 0

const db = (x: number) => (x > 0 ? `${(20 * Math.log10(x)).toFixed(0)} dB` : '-∞')

/** Once per mic frame: refreshes the live line (with ?debug). */
export function updateDebug() {
	// ~10 updates a second is readable; 60 is a blur.
	if (!DEBUG || debugFrame++ % 6 !== 0) return
	const { volume, noiseFloor, clarity, reason } = Microphone.getStats()
	debugLine.textContent = `level ${db(volume)} · noise ${db(noiseFloor)} · clarity ${clarity.toFixed(2)} · ${reason}`
}

function recordSample(button: HTMLButtonElement) {
	const stream = Microphone.getStream()
	if (!stream) {
		button.textContent = 'Start listening first'
		return
	}
	const recorder = new MediaRecorder(stream)
	const chunks: Blob[] = []
	recorder.ondataavailable = (event) => chunks.push(event.data)
	recorder.onstop = () => {
		const blob = new Blob(chunks, { type: recorder.mimeType })
		const extension = recorder.mimeType.includes('mp4') ? 'm4a' : recorder.mimeType.includes('ogg') ? 'ogg' : 'webm'
		const link = document.createElement('a')
		link.href = URL.createObjectURL(blob)
		link.download = `pluck-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
		link.click()
		setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
		button.disabled = false
		button.textContent = `Record ${RECORD_SECONDS} s sample`
	}
	recorder.start()
	button.disabled = true
	let left = RECORD_SECONDS
	button.textContent = `Recording… ${left} s`
	const timer = setInterval(() => {
		left--
		button.textContent = `Recording… ${left} s`
		if (left <= 0) {
			clearInterval(timer)
			recorder.stop()
		}
	}, 1000)
}

/** With ?debug: adds the live line and the record button to the mic block. */
export function initDebug(mic: HTMLElement) {
	if (!DEBUG) return
	debugLine.className = 'debug'
	const recordButton = document.createElement('button')
	recordButton.type = 'button'
	recordButton.className = 'btn'
	recordButton.textContent = `Record ${RECORD_SECONDS} s sample`
	recordButton.addEventListener('click', () => recordSample(recordButton))
	mic.append(debugLine, recordButton)
}
