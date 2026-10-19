import * as Settings from '../../core/settings'
import { INTERVALS, QUALITIES } from '../../music/ear'
import type { View } from '../../ui/view'
import { subscribeVisible } from '../../ui/dom'

/* Theme: System (nothing stored: the inline script in index.html and this
   follow the device, live), or Light / Dark stored under 'theme', which that
   script reads before first paint so a reload never flashes. */
type ThemeChoice = 'system' | 'light' | 'dark'
const THEME_KEY = 'theme'
const systemDark = matchMedia('(prefers-color-scheme: dark)')

function loadTheme(): ThemeChoice {
	try {
		const saved = localStorage.getItem(THEME_KEY)
		return saved === 'light' || saved === 'dark' ? saved : 'system'
	} catch {
		return 'system'
	}
}

function saveTheme(choice: ThemeChoice) {
	try {
		if (choice === 'system') localStorage.removeItem(THEME_KEY)
		else localStorage.setItem(THEME_KEY, choice)
	} catch {
		// Storage may be unavailable (private mode): the choice lasts this visit.
	}
}

/**
 * The Settings tab: the switches and selects of every tab, the per-note target
 * chips, the All/None shortcuts and the theme. Keeps the controls in sync with
 * stored settings. On entry it scrolls to the group of the tab the user came
 * from (`from`, null when the app opened on Settings).
 */
export function createSettingsView(root: HTMLElement, from: () => string | null): View {
	let theme = loadTheme()
	const themeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-theme-choice]'))
	function applyTheme() {
		document.documentElement.dataset.theme = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme
		for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme))
	}
	for (const button of themeButtons) {
		button.addEventListener('click', () => {
			theme = button.dataset.themeChoice as ThemeChoice
			saveTheme(theme)
			applyTheme()
		})
	}
	systemDark.addEventListener('change', applyTheme)
	applyTheme()

	// Checkbox switches store booleans, sliders and number fields numbers,
	// selects their value (a number when marked data-type="number").
	const switches = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]'))
	const isNumeric = (input: HTMLInputElement | HTMLSelectElement) => input.type === 'range' || input.type === 'number' || input.dataset.type === 'number'
	const inputValue = (input: HTMLInputElement | HTMLSelectElement) =>
		input.type === 'checkbox' ? (input as HTMLInputElement).checked : isNumeric(input) ? Number(input.value) : input.value
	const chips = root.querySelector<HTMLElement>('#noteChips')!

	for (const input of switches) {
		// Sliders apply live while dragging.
		input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
			let value = inputValue(input)
			if (typeof value === 'number' && input instanceof HTMLInputElement && input.min) {
				// A typed number can be empty or out of range: clamp it, or put the
				// stored value back.
				if (Number.isNaN(value) || input.value === '') return sync()
				value = Math.min(Number(input.max), Math.max(Number(input.min), value))
			}
			Settings.update({ [input.dataset.setting!]: value } as Partial<Settings.Settings>)
		})
	}

	// Preset buttons: data-set="setting:value" (the A4 shortcuts).
	for (const button of root.querySelectorAll<HTMLElement>('[data-set]')) {
		button.addEventListener('click', () => {
			const [key, value] = button.dataset.set!.split(':')
			Settings.update({ [key]: Number(value) } as Partial<Settings.Settings>)
		})
	}

	root.querySelector('[data-notes="all"]')!.addEventListener('click', () => Settings.enableAllNotes())
	root.querySelector('[data-notes="none"]')!.addEventListener('click', () => Settings.disableAllNotes())

	function makeChip(note: string, label: string): HTMLButtonElement {
		const chip = document.createElement('button')
		chip.type = 'button'
		chip.className = 'chip'
		chip.textContent = label
		chip.dataset.note = note
		chip.setAttribute('aria-pressed', String(Settings.isNoteEnabled(note)))
		chip.addEventListener('click', () => {
			Settings.setNoteEnabled(note, !Settings.isNoteEnabled(note))
		})
		return chip
	}

	function syncSwitches() {
		const current = Settings.get() as unknown as Record<string, boolean | string | number>
		for (const input of switches) {
			const value = current[input.dataset.setting!]
			if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value)
			else input.value = String(value)
		}
	}

	function renderChips() {
		const notes = Settings.rangeNotes()
		// Rebuild only when the set of notes changed (i.e. accidentals toggled);
		// otherwise just refresh the pressed state so focus is preserved.
		if (chips.childElementCount !== notes.length) {
			chips.replaceChildren(...notes.map((note) => makeChip(note.note, note.note.split('/')[0])))
		} else {
			for (let i = 0; i < notes.length; i++) {
				const chip = chips.children[i] as HTMLButtonElement
				chip.setAttribute('aria-pressed', String(Settings.isNoteEnabled(notes[i].note)))
			}
		}
	}

	// A4 is set in the Tuner's settings but moves the Trainer and Scales too:
	// say so where they show notes, so a stray 432 is never a mystery.
	const a4Notes = Array.from(document.querySelectorAll<HTMLElement>('.a4-note'))
	function syncA4Notes() {
		const { a4 } = Settings.get()
		for (const note of a4Notes) {
			note.hidden = a4 === 440
			note.textContent = `A4 = ${a4} Hz`
		}
	}

	// Ear-training chips (data-chips="earIntervals" / "earChords"): one per
	// table entry, pressed = asked. The last one cannot be switched off, so a
	// round always has something to ask.
	const earChips = Array.from(root.querySelectorAll<HTMLElement>('[data-chips]'))
	for (const container of earChips) {
		const key = container.dataset.chips as 'earIntervals' | 'earChords'
		const items = key === 'earIntervals' ? INTERVALS : QUALITIES
		container.replaceChildren(
			...items.map((item) => {
				const chip = document.createElement('button')
				chip.type = 'button'
				chip.className = 'chip'
				chip.textContent = item.id
				chip.title = item.name
				chip.setAttribute('aria-label', item.name)
				chip.addEventListener('click', () => {
					const enabled = Settings.get()[key]
					const next = enabled.includes(item.id) ? enabled.filter((id) => id !== item.id) : [...enabled, item.id]
					if (next.length > 0) Settings.update({ [key]: next })
				})
				return chip
			})
		)
	}

	function syncEarChips() {
		for (const container of earChips) {
			const enabled = Settings.get()[container.dataset.chips as 'earIntervals' | 'earChords']
			for (const chip of container.children) {
				const on = enabled.includes(chip.textContent!)
				chip.setAttribute('aria-pressed', String(on))
				// The last one on stays on (see the click handler): say so.
				chip.setAttribute('aria-disabled', String(on && enabled.length === 1))
			}
		}
	}

	function sync() {
		syncSwitches()
		renderChips()
		syncEarChips()
		syncA4Notes()
	}

	// Hidden, onActivate syncs on the way back.
	subscribeVisible(root, sync)
	sync()

	return {
		onActivate() {
			sync()
			const tab = from()
			if (tab) root.querySelector(`[data-group="${tab}"]`)?.scrollIntoView({ block: 'start' })
		},
		onReading() {},
		reset() {},
		// Nothing here listens; an open mic would only cost battery.
		wantsMic: () => false,
	}
}
