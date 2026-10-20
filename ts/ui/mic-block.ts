// The app's one microphone: when it listens, and the shared #mic block (live
// waveform, the dot + mic + state toggle, a hint line) that shows it under the active view's
// readout. main.ts hands it the active view (initMic) and boots it (bootMic);
// views only signal through micNeedChanged() that their wantsMic() changed.
// Scales, which has its own toggle, reads micState() / setListening() and
// follows onMicChange. This module never imports a view.
import * as Microphone from '../core/microphone'
import { initDebug, updateDebug } from './debug'
import { byId } from './dom'
import type { View } from './view'
import { drawWaveform } from './waveform'

export type MicState = 'off' | 'waiting' | 'listening' | 'blocked'

const micButton = byId<HTMLButtonElement>('micButton')
const status = byId('status')
const waveform = byId<HTMLCanvasElement>('waveform')
const mic = byId('mic')

let current: () => { view: View; section: HTMLElement }
const listeners: (() => void)[] = []
let micActive = false
let micBlocked = false
// Views with no use for the mic (wantsMic false: the Metronome, Settings, the
// Trainer's Chords exercise) turn it off: it would hear the clicks or the
// strums, and on phones an open mic can change audio routing. True while the mic should come
// back on leaving them: it was on when they opened, or the app booted straight
// into one. A mic the user had stopped stays stopped.
let micResume = false

export const micState = (): MicState => (micBlocked ? 'blocked' : !micActive ? 'off' : Microphone.isSuspended() ? 'waiting' : 'listening')

/** `listener` runs whenever the mic's state is shown anew (Scales mirrors it on its own toggle). */
export function onMicChange(listener: () => void) {
	listeners.push(listener)
}

/** The active view's wantsMic() may have changed (or a tab opened): start or stop the mic to match. */
export function micNeedChanged() {
	const { view, section } = current()
	const wanted = view.wantsMic?.() ?? true
	// One shared mic control, placed right after the view's [data-mic-slot] (or,
	// failing that, its readout). Views with neither (Scales) have their own mic
	// toggle: hide it there.
	const anchor = section.querySelector('[data-mic-slot], .readout')
	anchor?.after(mic)
	mic.hidden = !anchor || !wanted
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

/**
 * Scales' own toggle. It only stops listening: a progression or Play scale
 * keeps playing (the view clears what it heard itself).
 */
export function setListening(on: boolean) {
	if (!on) stopMic(false)
	else if (!micActive) startMic()
	else resumeMic()
}

/** Points the player at the Listen button (a view that needs the mic found it off). */
export function focusMicButton() {
	micButton.focus()
}

const micLabel = micButton.querySelector<HTMLElement>('.mic-toggle__label')!

/** The line under the toggle: only for what the label can't say (blocked, waiting). */
function setHint(text: string) {
	status.textContent = text
	status.hidden = !text
}

// The toggle reflects four states: idle, waiting for a tap (the browser holds
// audio until a gesture when listening starts on load), listening, blocked.
let waitingShown = false

function syncMicUi() {
	const waiting = micActive && Microphone.isSuspended()
	waitingShown = waiting
	const listening = micActive && !waiting
	micLabel.textContent = micBlocked ? 'Blocked' : listening ? 'Listening' : waiting ? 'Tap to start' : 'Idle'
	micButton.setAttribute('aria-pressed', String(micActive))
	micButton.classList.toggle('mic-toggle--live', listening)
	micButton.title = listening ? 'Stop listening' : 'Start listening'
	setHint(
		micBlocked ? 'The browser is blocking the microphone. Allow it in the site settings to use this.' : waiting ? 'Tap anywhere to start the microphone.' : ''
	)
	for (const listener of listeners) listener()
}

async function startMic() {
	micActive = true
	micBlocked = false
	syncMicUi()

	await Microphone.start(
		(reading) => {
			try {
				current().view.onReading(reading)
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
	if (resetView) current().view.reset()
}

async function resumeMic() {
	await Microphone.resume()
	syncMicUi()
}

/** Wires the mic block; `active` returns the view on screen (it gets the readings). */
export function initMic(active: () => { view: View; section: HTMLElement }) {
	current = active
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

	initDebug(mic)
}

/** After the first tab is shown: listen by default. */
export function bootMic() {
	drawWaveform(waveform, false)
	// A tuner that is not listening just looks broken. (Not where the view has
	// no use for it: the mic starts when the user leaves.)
	if (current().view.wantsMic?.() === false) micResume = true
	else startMic()
}
