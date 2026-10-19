import './styles/style.css'
import * as Microphone from './core/microphone'
import * as Sound from './core/sound'
import { createTrainerView } from './features/trainer/trainer.view'
import { createTunerView } from './features/tuner/tuner.view'
import { createChordsView } from './features/chords/chords.view'
import { createScalesView } from './features/scales/scales.view'
import { createMetronomeView } from './features/metronome/metronome.view'
import { createSettingsView } from './features/settings/settings.view'
import { initHelp } from './ui/help'
import type { View } from './ui/view'
import { byId } from './ui/dom'
import { initDebug, updateDebug } from './ui/debug'
import { drawWaveform } from './ui/waveform'

const micButton = byId<HTMLButtonElement>('micButton')
const status = byId('status')
const waveform = byId<HTMLCanvasElement>('waveform')
const mic = byId('mic')
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))

// The Scales tab has its own mic toggle instead of the shared #mic block.
const scalesView = createScalesView(byId('view-scales'), {
	state: () => (micBlocked ? 'blocked' : !micActive ? 'off' : Microphone.isSuspended() ? 'waiting' : 'listening'),
	listen: (on) => {
		// Its own toggle only stops listening: a progression or Play scale keeps
		// playing (the view clears what it heard itself).
		if (!on) stopMic(false)
		else if (!micActive) startMic()
		else resumeMic()
	},
})

const views: Record<string, { view: View; section: HTMLElement }> = {
	// Switching between its exercises changes whether it needs the mic.
	trainer: { view: createTrainerView(byId('view-trainer'), () => syncMicNeed()), section: byId('view-trainer') },
	tuner: { view: createTunerView(byId('view-tuner')), section: byId('view-tuner') },
	// Only its Listen sub-view uses the mic (Library and Identify play sounds).
	chords: { view: createChordsView(byId('view-chords'), () => syncMicNeed()), section: byId('view-chords') },
	scales: { view: scalesView, section: byId('view-scales') },
	// No microphone use (wantsMic false, no .readout for the #mic block).
	metronome: { view: createMetronomeView(byId('view-metronome')), section: byId('view-metronome') },
	// Opens at the group of the tab the user came from. No mic (wantsMic false).
	settings: { view: createSettingsView(byId('view-settings'), () => lastTab), section: byId('view-settings') },
}

let currentName = 'tuner'
// The last tab shown other than Settings: the group Settings scrolls to on
// entry. Null while the app has shown nothing else (it opened on #settings).
let lastTab: string | null = null
let micActive = false
let micBlocked = false
// Views with no use for the mic (wantsMic false: the Metronome, Settings, the
// Trainer's Chords exercise) turn it off: it would hear the clicks or the
// strums, and on phones an open mic can change audio routing. True while the mic should come
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

/* View routing ----------------------------------------------------------- */
function activate(name: string) {
	if (!views[name]) name = 'tuner'
	views[currentName].view.reset()
	// Nothing the last tab played keeps sounding into the next (or into its mic).
	Sound.stopAll()
	Sound.stopTone()
	currentName = name
	if (name !== 'settings') lastTab = name

	for (const [key, { section }] of Object.entries(views)) {
		section.hidden = key !== name
	}
	for (const button of tabButtons) {
		button.setAttribute('aria-selected', String(button.dataset.tab === name))
	}

	syncMicNeed()
	// Each tab opens at its top (Settings then scrolls to a group itself): a
	// long page left scrolled would otherwise carry its offset over.
	window.scrollTo(0, 0)
	views[name].view.onActivate()
}

for (const button of tabButtons) {
	button.addEventListener('click', () => {
		location.hash = `#${button.dataset.tab}`
	})
}

window.addEventListener('hashchange', () => activate(location.hash.replace('#', '')))
// activate() decides where a tab opens; the browser restoring a reloaded
// page's old offset would fight it (and land Settings mid-page).
history.scrollRestoration = 'manual'

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
				drawWaveform(waveform, reading !== null)
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

// `resetView`: clear the view's readout state (a frozen last note, a trainer
// hold). The Tuner's reset keeps a reference tone playing on mic Stop.
function stopMic(resetView = true) {
	micActive = false
	Microphone.stop()
	syncMicUi()
	drawWaveform(waveform, false)
	if (resetView) views[currentName].view.reset()
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

// ?debug: a live line and a sample recorder under the mic button.
initDebug(mic)

/* Boot ------------------------------------------------------------------- */
initHelp()
activate(location.hash.replace('#', ''))
drawWaveform(waveform, false)
// Listen by default: a tuner that is not listening just looks broken. (Not
// where the view has no use for it: the mic starts when the user leaves.)
if (views[currentName].view.wantsMic?.() === false) micResume = true
else startMic()
