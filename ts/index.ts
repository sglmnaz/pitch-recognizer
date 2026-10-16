import './style.css'
import * as Microphone from './microphone'
import { createTrainerView } from './views/trainer'
import { createTunerView } from './views/tuner'
import { createChordsView } from './views/chords'
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

const views: Record<string, { view: View; section: HTMLElement }> = {
	trainer: { view: createTrainerView(byId('view-trainer')), section: byId('view-trainer') },
	tuner: { view: createTunerView(byId('view-tuner')), section: byId('view-tuner') },
	chords: { view: createChordsView(byId('view-chords')), section: byId('view-chords') },
}

let currentName = 'tuner'
let micActive = false

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
	// One shared mic control, placed right under the active view's readout.
	views[name].section.querySelector('.readout')?.after(mic)
	for (const button of tabButtons) {
		button.setAttribute('aria-selected', String(button.dataset.tab === name))
	}

	// All settings are trainer-related, so the gear only appears there.
	settingsToggle.hidden = name !== 'trainer'
	if (name !== 'trainer') setSettingsOpen(false)

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
}

// ~23 ms at 44.1 kHz: two periods of the low E string, many of the high ones.
const WAVE_SAMPLES = 1024
// Fixed gain so loudness reads honestly: noise stays a near-flat line, a
// plucked string fills the strip.
const WAVE_GAIN = 4

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
		for (let x = 0; x <= width; x++) {
			const sample = data[start + Math.floor((x / width) * (WAVE_SAMPLES - 1))]
			const y = height / 2 - Math.max(-1, Math.min(1, sample * WAVE_GAIN)) * (height / 2 - ctx.lineWidth)
			if (x === 0) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
	}
	ctx.stroke()
}

async function startMic() {
	micActive = true
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
			} catch (error) {
				console.error('Waveform draw failed:', error)
			}
		},
		() => {
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

/* Boot ------------------------------------------------------------------- */
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
activate(location.hash.replace('#', ''))
drawWaveform(false)
// Listen by default: a tuner that is not listening just looks broken.
startMic()
