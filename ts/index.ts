import './style.css'
import * as Microphone from './microphone'
import { createTrainerView } from './views/trainer'
import { createTunerView } from './views/tuner'
import { createChordsView } from './views/chords'
import { createScalesView } from './views/scales'
import { createMetronomeView } from './views/metronome'
import { createSettingsPanel } from './views/settings-panel'
import type { View } from './views/view'

function byId<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id)
	if (!element) throw new Error(`Missing #${id} element`)
	return element as T
}

const micButton = byId<HTMLButtonElement>('micButton')
const themeToggle = byId<HTMLButtonElement>('themeToggle')
const settingsToggle = byId<HTMLButtonElement>('settingsToggle')
const settingsPanel = byId('settings')
const status = byId('status')
const waveform = byId<HTMLCanvasElement>('waveform')
const mic = byId('mic')
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))

createSettingsPanel(settingsPanel)

// The Scales tab has its own mic toggle instead of the shared #mic block.
const scalesView = createScalesView(byId('view-scales'), {
	state: () => (micBlocked ? 'blocked' : !micActive ? 'off' : Microphone.isSuspended() ? 'waiting' : 'listening'),
	listen: (on) => {
		if (!on) stopMic()
		else if (!micActive) startMic()
		else resumeMic()
	},
})

const views: Record<string, { view: View; section: HTMLElement }> = {
	// Switching between its exercises changes whether it needs the mic.
	trainer: { view: createTrainerView(byId('view-trainer'), () => syncMicNeed()), section: byId('view-trainer') },
	tuner: { view: createTunerView(byId('view-tuner')), section: byId('view-tuner') },
	chords: { view: createChordsView(byId('view-chords')), section: byId('view-chords') },
	scales: { view: scalesView, section: byId('view-scales') },
	// No microphone use (wantsMic false, no .readout for the #mic block).
	metronome: { view: createMetronomeView(byId('view-metronome')), section: byId('view-metronome') },
}

let currentName = 'tuner'
let micActive = false
let micBlocked = false
// Views with no use for the mic (wantsMic false: the Metronome, the Trainer's
// Chords exercise) turn it off: it would hear the clicks or the strums, and on
// phones an open mic can change audio routing. True while the mic should come
// back on leaving them: it was on when they opened, or the app booted straight
// into one. A mic the user had stopped stays stopped.
let micResume = false

function syncMicNeed() {
	const wanted = views[currentName].view.wantsMic?.() ?? true
	// One shared mic control, placed right under the active view's readout.
	// Views without one (Scales) have their own mic toggle: hide it there.
	const readout = views[currentName].section.querySelector('.readout')
	readout?.after(mic)
	mic.hidden = !readout || !wanted
	if (!wanted) {
		if (micActive) {
			micResume = true
			stopMic()
		}
	} else if (micResume) {
		micResume = false
		startMic()
	}
}

/* Theme ------------------------------------------------------------------ */
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'

function applyTheme(theme: 'light' | 'dark') {
	document.documentElement.dataset.theme = theme
	themeToggle.innerHTML = theme === 'dark' ? SUN : MOON
	themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')
	localStorage.setItem('theme', theme)
}

themeToggle.addEventListener('click', () => {
	applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
})

/* Settings popover ------------------------------------------------------- */
function setSettingsOpen(open: boolean) {
	settingsPanel.hidden = !open
	settingsToggle.setAttribute('aria-expanded', String(open))
}

settingsToggle.addEventListener('click', (event) => {
	event.stopPropagation()
	setSettingsOpen(settingsPanel.hidden)
})

document.addEventListener('click', (event) => {
	if (!settingsPanel.hidden && !settingsPanel.contains(event.target as Node)) {
		setSettingsOpen(false)
	}
})

document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') setSettingsOpen(false)
})

/* View routing ----------------------------------------------------------- */
function activate(name: string) {
	if (!views[name]) name = 'tuner'
	views[currentName].view.reset()
	currentName = name

	for (const [key, { section }] of Object.entries(views)) {
		section.hidden = key !== name
	}
	for (const button of tabButtons) {
		button.setAttribute('aria-selected', String(button.dataset.tab === name))
	}

	// Settings exist for the Tuner, Chords, Scales, Trainer and Metronome; show that tab's section.
	const sections = settingsPanel.querySelectorAll<HTMLElement>('[data-for]')
	sections.forEach((section) => (section.hidden = section.dataset.for !== name))
	const hasSettings = [...sections].some((section) => !section.hidden)
	settingsToggle.hidden = !hasSettings
	if (!hasSettings) setSettingsOpen(false)

	syncMicNeed()
	views[name].view.onActivate()
}

for (const button of tabButtons) {
	button.addEventListener('click', () => {
		location.hash = `#${button.dataset.tab}`
	})
}

window.addEventListener('hashchange', () => activate(location.hash.replace('#', '')))

/* Microphone ------------------------------------------------------------- */
function setStatus(text: string, live: boolean) {
	status.textContent = ''
	const dot = document.createElement('span')
	dot.className = 'status__dot'
	status.append(dot, document.createTextNode(text))
	status.classList.toggle('status--live', live)
}

// Button and status reflect three states: idle, waiting for a tap (the browser
// holds audio until a gesture when listening starts on load), and listening.
let waitingShown = false

function syncMicUi() {
	const waiting = micActive && Microphone.isSuspended()
	waitingShown = waiting
	const listening = micActive && !waiting
	micButton.textContent = listening ? 'Stop' : 'Listen'
	micButton.classList.toggle('btn--solid', !listening)
	setStatus(listening ? 'Listening' : waiting ? 'Tap to start' : 'Idle', listening)
	scalesView.syncMic()
}

// ~23 ms at 44.1 kHz: two periods of the low E string, many of the high ones.
const WAVE_SAMPLES = 1024
// Display-only automatic gain, like a scope's auto-range: the trace aims for
// WAVE_TARGET of the half-height, so a loud acoustic and an unplugged electric
// look alike, with headroom. The remembered peak jumps up at once (never
// clips) and decays slowly (WAVE_RELEASE per frame, ~0.4 s half-life) so the
// trace does not pump. The gain is capped by how tall room noise would be
// drawn: WAVE_NOISE_SILENT while nothing is sounding (silence stays almost
// flat), WAVE_NOISE_SOUNDING once the gate hears a note, so a quiet source
// (an unplugged electric) still fills the strip. The noise level is the
// average trace peak while nothing is sounding, so it calibrates itself.
const WAVE_TARGET = 0.6
const WAVE_RELEASE = 0.97
const WAVE_NOISE_SILENT = 0.04
const WAVE_NOISE_SOUNDING = 0.3
const WAVE_GAIN_BEFORE_NOISE = 4 // until some silence has been heard
let wavePeak = 0
let noisePeak = 0

function drawWaveform(voiced: boolean) {
	const dpr = window.devicePixelRatio || 1
	const width = Math.round(waveform.clientWidth * dpr)
	const height = Math.round(waveform.clientHeight * dpr)
	if (waveform.width !== width || waveform.height !== height) {
		waveform.width = width
		waveform.height = height
	}

	const data = Microphone.getWaveform()
	waveform.classList.toggle('wave--live', data !== null)
	waveform.classList.toggle('wave--voiced', voiced)

	const ctx = waveform.getContext('2d')
	if (!ctx || width === 0) return
	ctx.clearRect(0, 0, width, height)
	ctx.strokeStyle = getComputedStyle(waveform).color
	ctx.lineWidth = 1.5 * dpr
	ctx.lineJoin = 'round'
	ctx.beginPath()

	if (!data) {
		ctx.moveTo(0, height / 2)
		ctx.lineTo(width, height / 2)
	} else {
		// Start at a rising zero crossing so a steady note stands still on screen
		// instead of scrolling, like an oscilloscope trigger.
		let start = data.length - 2 * WAVE_SAMPLES
		for (let i = start; i < data.length - WAVE_SAMPLES; i++) {
			if (data[i - 1] < 0 && data[i] >= 0) {
				start = i
				break
			}
		}
		let peak = 0
		for (let i = start; i < start + WAVE_SAMPLES; i++) peak = Math.max(peak, Math.abs(data[i]))
		wavePeak = Math.max(peak, wavePeak * WAVE_RELEASE)
		const sounding = Microphone.isSounding()
		if (!sounding) noisePeak = noisePeak ? 0.95 * noisePeak + 0.05 * peak : peak
		const noiseCap = noisePeak ? (sounding ? WAVE_NOISE_SOUNDING : WAVE_NOISE_SILENT) / noisePeak : WAVE_GAIN_BEFORE_NOISE
		const gain = Math.min(noiseCap, WAVE_TARGET / Math.max(wavePeak, 1e-9))
		for (let x = 0; x <= width; x++) {
			const sample = data[start + Math.floor((x / width) * (WAVE_SAMPLES - 1))]
			const y = height / 2 - Math.max(-1, Math.min(1, sample * gain)) * (height / 2 - ctx.lineWidth)
			if (x === 0) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
	}
	ctx.stroke()
}

async function startMic() {
	micActive = true
	micBlocked = false
	syncMicUi()

	await Microphone.start(
		(reading) => {
			try {
				views[currentName].view.onReading(reading)
			} catch (error) {
				console.error('View update failed:', error)
			}
			// The browser may release audio on its own (e.g. sticky activation).
			if (waitingShown && !Microphone.isSuspended()) syncMicUi()
			try {
				drawWaveform(reading !== null)
				updateDebug()
			} catch (error) {
				console.error('Waveform draw failed:', error)
			}
		},
		() => {
			micBlocked = true
			stopMic()
			setStatus('Microphone unavailable', false)
		}
	)
	if (micActive) syncMicUi()
}

function stopMic() {
	micActive = false
	Microphone.stop()
	syncMicUi()
	drawWaveform(false)
	views[currentName].view.reset()
}

async function resumeMic() {
	await Microphone.resume()
	syncMicUi()
}

micButton.addEventListener('click', () => {
	if (micActive && Microphone.isSuspended()) resumeMic()
	else if (micActive) stopMic()
	else startMic()
})

// Any tap unlocks audio that auto-started on load. (The mic button handles its
// own click, so skip it here or the same tap would resume and then stop.)
document.addEventListener('pointerdown', (event) => {
	if (micActive && Microphone.isSuspended() && !micButton.contains(event.target as Node)) resumeMic()
})

/* Debug (?debug) ---------------------------------------------------------- */
// Field diagnostics: a live line with what the gate sees, and a recorder that
// captures the raw mic stream exactly as the app hears it (same device, voice
// processing off), so a problem on someone's guitar and phone can be replayed
// with `npm run bench` instead of guessed at.
const DEBUG = new URLSearchParams(location.search).has('debug')
const RECORD_SECONDS = 20
const debugLine = document.createElement('p')
let debugFrame = 0

const db = (x: number) => (x > 0 ? `${(20 * Math.log10(x)).toFixed(0)} dB` : '-∞')

function updateDebug() {
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

if (DEBUG) {
	debugLine.className = 'debug'
	const recordButton = document.createElement('button')
	recordButton.type = 'button'
	recordButton.className = 'btn'
	recordButton.textContent = `Record ${RECORD_SECONDS} s sample`
	recordButton.addEventListener('click', () => recordSample(recordButton))
	mic.append(debugLine, recordButton)
}

/* Boot ------------------------------------------------------------------- */
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
activate(location.hash.replace('#', ''))
drawWaveform(false)
// Listen by default: a tuner that is not listening just looks broken. (Not
// where the view has no use for it: the mic starts when the user leaves.)
if (views[currentName].view.wantsMic?.() === false) micResume = true
else startMic()
