import * as Settings from '../settings'

/**
 * Wires the settings popover: the switches and selects, the per-note target chips,
 * and the All/None shortcuts. Keeps the controls in sync with stored settings.
 */
export function createSettingsPanel(root: HTMLElement) {
	// Checkbox switches store booleans, sliders numbers, selects their value
	// (a number when marked data-number).
	const switches = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]'))
	const valueOf = (input: HTMLInputElement | HTMLSelectElement) =>
		input.type === 'checkbox' ? (input as HTMLInputElement).checked : input.type === 'range' || 'number' in input.dataset ? Number(input.value) : input.value
	const chips = root.querySelector<HTMLElement>('#noteChips')!

	for (const input of switches) {
		// Sliders apply live while dragging.
		input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
			Settings.update({ [input.dataset.setting!]: valueOf(input) } as Partial<Settings.Settings>)
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

	function sync() {
		syncSwitches()
		renderChips()
	}

	Settings.subscribe(sync)
	sync()
}
