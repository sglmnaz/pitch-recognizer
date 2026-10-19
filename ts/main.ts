import './styles/main.css'
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
import { bootMic, initMic, micNeedChanged } from './ui/mic-block'

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))

// The Scales tab has its own mic toggle instead of the shared #mic block
// (ts/ui/mic-block.ts). Built first, as it always was.
const scalesView = createScalesView(byId('view-scales'))

const tabs = {
	// Switching between its exercises changes whether it needs the mic.
	trainer: { view: createTrainerView(byId('view-trainer')), section: byId('view-trainer') },
	tuner: { view: createTunerView(byId('view-tuner')), section: byId('view-tuner') },
	// Only its Listen sub-view uses the mic (Library and Identify play sounds).
	chords: { view: createChordsView(byId('view-chords')), section: byId('view-chords') },
	scales: { view: scalesView, section: byId('view-scales') },
	// No microphone use (wantsMic false, no .readout for the #mic block).
	metronome: { view: createMetronomeView(byId('view-metronome')), section: byId('view-metronome') },
	// Opens at the group of the tab the user came from. No mic (wantsMic false).
	settings: { view: createSettingsView(byId('view-settings'), () => lastTab), section: byId('view-settings') },
} satisfies Record<string, { view: View; section: HTMLElement }>
const views: Record<string, { view: View; section: HTMLElement }> = tabs

let currentName = 'tuner'
// The last tab shown other than Settings: the group Settings scrolls to on
// entry. Null while the app has shown nothing else (it opened on #settings).
let lastTab: string | null = null

/* View routing ----------------------------------------------------------- */
function activate(name: string) {
	if (!views[name]) name = 'tuner'
	// Opening another tab stops the metronome's clicks: nothing else on screen
	// could stop them, and the tuner's microphone would hear them. Settings is
	// the exception: it has no mic, and a sound or volume change there must be heard.
	if (name !== 'metronome' && name !== 'settings') tabs.metronome.view.stop()
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

	micNeedChanged()
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
// The mic block feeds and resets whichever view is on screen.
initMic(() => views[currentName])

/* Boot ------------------------------------------------------------------- */
initHelp()
activate(location.hash.replace('#', ''))
bootMic()
