import './style.css'
import * as Microphone from './microphone'
import { createTrainerView } from './views/trainer'
import { createTunerView } from './views/tuner'
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
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))

createSettingsPanel(settingsPanel)

const views: Record<string, { view: View; section: HTMLElement }> = {
	trainer: { view: createTrainerView(byId('view-trainer')), section: byId('view-trainer') },
	tuner: { view: createTunerView(byId('view-tuner')), section: byId('view-tuner') },
}

let currentName = 'trainer'
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
	if (!views[name]) name = 'trainer'
	views[currentName].view.reset()
	currentName = name

	for (const [key, { section }] of Object.entries(views)) {
		section.hidden = key !== name
	}
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

function startMic() {
	micActive = true
	micButton.textContent = 'Stop'
	micButton.classList.remove('btn--solid')
	setStatus('Listening', true)

	Microphone.start(
		(reading) => {
			try {
				views[currentName].view.onReading(reading)
			} catch (error) {
				console.error('View update failed:', error)
			}
		},
		() => {
			setStatus('Microphone unavailable', false)
			stopMic()
		}
	)
}

function stopMic() {
	micActive = false
	Microphone.stop()
	micButton.textContent = 'Listen'
	micButton.classList.add('btn--solid')
	setStatus('Idle', false)
	views[currentName].view.reset()
}

micButton.addEventListener('click', () => (micActive ? stopMic() : startMic()))

/* Boot ------------------------------------------------------------------- */
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
activate(location.hash.replace('#', ''))
setStatus('Idle', false)
