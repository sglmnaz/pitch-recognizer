import * as Settings from '../settings'
import { INTERVALS, QUALITIES } from '../ear'

/**
 * Wires the settings popover: the switches and selects, the per-note target chips,
 * and the All/None shortcuts. Keeps the controls in sync with stored settings.
 */
export function createSettingsPanel(root: HTMLElement) {
	// Checkbox switches store booleans, sliders and number fields numbers,
	// selects their value (a number when marked data-type="number").
	const switches = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]'))
	const isNumeric = (input: HTMLInputElement | HTMLSelectElement) =>
		input.type === 'range' || input.type === 'number' || input.dataset.type === 'number'
	const valueOf = (input: HTMLInputElement | HTMLSelectElement) =>
		input.type === 'checkbox' ? (input as HTMLInputElement).checked : isNumeric(input) ? Number(input.value) : input.value
	const chips = root.querySelector<HTMLElement>('#noteChips')!

	for (const input of switches) {
		// Sliders apply live while dragging.
		input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
			let value = valueOf(input)
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
			for (const chip of container.children) chip.setAttribute('aria-pressed', String(enabled.includes(chip.textContent!)))
		}
	}

	function sync() {
		syncSwitches()
		renderChips()
		syncEarChips()
		syncA4Notes()
	}

	Settings.subscribe(sync)
	sync()
}
