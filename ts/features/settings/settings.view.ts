import * as Settings from '../../core/settings'
import { clamp } from '../../core/math'
import * as Ear from '../../music/ear'
import type { View } from '../../ui/view'
import { subscribeVisible, svgEl } from '../../ui/dom'
import { withStepper } from '../../ui/stepper'
import * as Theme from '../../ui/theme'
import { guardKey } from '../../ui/guard-key'
import { guardTouches } from '../../ui/touch-guard'
import { noteName } from '../../music/note-names'
import { showCalibrationState } from '../calibration/calibration-state'
import { t } from '../../core/i18n'

/**
 * The Settings tab: the switches and selects of every tab, the per-note target
 * chips, the All/None shortcuts and the theme. Keeps the controls in sync with
 * stored settings. On entry it scrolls to the group of the tab the user came
 * from (`from`, null when the app opened on Settings).
 */
export function createSettingsView(root: HTMLElement, from: () => string | null): View {
	// Theme and LCD colour (ts/ui/theme.ts): two dropdowns.
	const themeSelect = root.querySelector<HTMLSelectElement>('select[data-theme-choice]')!
	themeSelect.replaceChildren(...Theme.THEMES.map((theme) => new Option(t(theme.label), theme.id, false, theme.id === Theme.getTheme())))
	themeSelect.addEventListener('change', () => Theme.setTheme(themeSelect.value))
	const displaySelect = root.querySelector<HTMLSelectElement>('[data-display-choice]')!
	displaySelect.replaceChildren(...Theme.DISPLAYS.map((d) => new Option(t(d.label), d.id, false, d.id === Theme.getDisplay())))
	displaySelect.addEventListener('change', () => Theme.setDisplay(displaySelect.value))
	// ◀ ▶ beside each: run through the themes, displays and fonts without opening the list.
	withStepper(themeSelect, t('Theme'))
	withStepper(displaySelect, t('Display'))
	// UI and display font (ts/styles/typefaces.css).
	const fontSelects = (['ui', 'display'] as const).map((slot) => {
		const select = root.querySelector<HTMLSelectElement>(`[data-font-choice="${slot}"]`)!
		const fonts = slot === 'ui' ? Theme.UI_FONTS : Theme.DISPLAY_FONTS
		select.replaceChildren(...fonts.map((f) => new Option(t(f.label), f.id, false, f.id === Theme.getFont(slot))))
		select.addEventListener('change', () => Theme.setFont(slot, select.value))
		withStepper(select, slot === 'ui' ? t('UI font') : t('Display font'))
		return { slot, select }
	})

	// A long page scrolled with the thumb: brushing a control must not change it.
	guardTouches(root)

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
				value = clamp(value, Number(input.min), Number(input.max))
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

	// Each section's first row: Reset to defaults, back to the defaults of what
	// that section shows (read from its controls, so a new control is covered
	// by itself), behind a guarded key (ts/ui/guard-key.ts).
	for (const group of root.querySelectorAll<HTMLElement>('.settings-group[data-group]')) {
		const keys = new Set<keyof Settings.Settings>()
		for (const el of group.querySelectorAll<HTMLElement>('[data-setting], [data-chips]'))
			keys.add((el.dataset.setting ?? el.dataset.chips) as keyof Settings.Settings)
		for (const el of group.querySelectorAll<HTMLElement>('[data-set]')) keys.add(el.dataset.set!.split(':')[0] as keyof Settings.Settings)
		if (group.querySelector('#noteChips')) keys.add('disabledNotes')
		const appearance = group.dataset.group === 'appearance'
		if (!keys.size && !appearance) continue

		const title = group.querySelector('.settings-group__title')?.textContent ?? t('section')
		const guard = guardKey(t('the {section} settings', { section: title }), () => {
			if (appearance) {
				Theme.setTheme('system')
				Theme.setDisplay('auto')
				themeSelect.value = Theme.getTheme()
				displaySelect.value = Theme.getDisplay()
				for (const { slot, select } of fontSelects) {
					Theme.setFont(slot, 'auto')
					select.value = 'auto'
				}
			}
			Settings.reset([...keys])
		})
		// A card of its own before the section's first card or sub-heading (Trainer starts with Notes).
		const card = document.createElement('div')
		card.className = 'panel settings-card settings-reset'
		card.innerHTML = `<div class="settings__section"><div class="switch"><span class="switch__text"><span class="switch__title">${t('Reset to defaults')}</span><span class="switch__desc">${t('Every setting of this section')}</span></span></div></div>`
		card.querySelector('.switch')!.append(guard)
		group.querySelector(':scope > :is(.settings-card, .settings-group__sub)')?.before(card)
	}

	/* Sections fold (accordion) ------------------------------------------- */
	// Each band becomes a toggle (a bare chevron, then the name); everything
	// under it goes into a body that folds. All start folded but the one of
	// the tab you came from (onActivate).
	const groups = Array.from(root.querySelectorAll<HTMLElement>('.settings-group[data-group]')).map((group) => {
		const title = group.querySelector<HTMLElement>('.settings-group__title')!
		const name = group.dataset.group!
		const toggle = document.createElement('button')
		toggle.type = 'button'
		toggle.className = 'settings-group__toggle'
		toggle.setAttribute('aria-controls', `settings-${name}`)
		const chevron = svgEl('svg', { class: 'settings-group__chev', viewBox: '0 0 24 24', 'aria-hidden': 'true' })
		chevron.append(
			svgEl('path', { d: 'M9 5l7 7-7 7', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
		)
		const label = document.createElement('span')
		label.className = 'settings-group__name'
		label.append(...title.childNodes)
		toggle.append(chevron, label)
		title.append(toggle)
		const body = document.createElement('div')
		body.className = 'settings-group__body'
		body.id = `settings-${name}`
		body.append(...Array.from(group.children).filter((child) => child !== title))
		group.append(body)
		const entry = { group, title, toggle, chevron, body, open: false }
		toggle.addEventListener('click', () => setOpen(entry, !entry.open))
		return entry
	})
	type Group = (typeof groups)[number]

	function setOpen(entry: Group, open: boolean) {
		entry.open = open
		entry.toggle.setAttribute('aria-expanded', String(open))
		entry.body.hidden = !open
		entry.group.classList.toggle('is-open', open)
	}
	for (const entry of groups) setOpen(entry, false)

	/* Search ------------------------------------------------------------------ */
	// Filters rows (a switch row, or a block without one: chips, presets) by
	// their text; a match on a section's name keeps the whole section. While a
	// query is in, every section with a match is shown open; clearing it puts
	// the folds back as they were.
	const search = root.querySelector<HTMLInputElement>('.settings-search')!
	const empty = root.querySelector<HTMLElement>('.settings-search__empty')!
	const words = (el: Element) => (el.textContent ?? '').toLowerCase()
	function filter() {
		const query = search.value.trim().toLowerCase()
		for (const { group, title, body, open } of groups) {
			const units = Array.from(group.querySelectorAll<HTMLElement>('.switch, .settings__section:not(:has(.switch))'))
			const extras = group.querySelectorAll<HTMLElement>('.settings-group__desc, .settings-group__sub')
			if (!query) {
				for (const el of [...units, ...extras, ...group.querySelectorAll<HTMLElement>('.settings__section')]) el.hidden = false
				group.hidden = false
				body.hidden = !open
				continue
			}
			const named = words(title).includes(query)
			let any = false
			for (const unit of units) {
				unit.hidden = !named && !words(unit).includes(query)
				any ||= !unit.hidden
			}
			// A section whose rows all went is a hole with a rule: hide it too.
			for (const section of group.querySelectorAll<HTMLElement>('.settings__section:has(.switch)'))
				section.hidden = !Array.from(section.querySelectorAll<HTMLElement>('.switch')).some((row) => !row.hidden)
			for (const el of extras) el.hidden = !named
			group.hidden = !any
			body.hidden = !any
		}
		empty.hidden = !query || groups.some(({ group }) => !group.hidden)
	}
	search.addEventListener('input', filter)

	// Vibration that never comes is hard to place: say whether the browser took
	// the call (then the phone's own settings silence it) or refused it. A
	// click comes after the finger lifts, so the page has user activation.
	const vibrationResult = root.querySelector<HTMLElement>('[data-vibration-result]')!
	root.querySelector('[data-action="test-vibration"]')!.addEventListener('click', () => {
		const sent = 'vibrate' in navigator ? navigator.vibrate(300) : null
		vibrationResult.textContent =
			sent === null
				? t('This browser has no vibration')
				: sent
					? t('Sent. Felt nothing? The phone mutes it: check its vibration and touch feedback settings')
					: t('The browser refused it')
	})

	// Update and reload: ask the service worker for a new version first. The PWA
	// auto-updates (skipWaiting + clientsClaim), so a new worker takes over by
	// itself; reload once it has (or after 5 s), else straight away.
	root.querySelector('[data-action="reload-app"]')!.addEventListener('click', async () => {
		const registration = await navigator.serviceWorker?.getRegistration()
		if (registration) {
			await registration.update().catch(() => {})
			if (registration.installing || registration.waiting) {
				await new Promise((resolve) => {
					navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
					setTimeout(resolve, 5000)
				})
			}
		}
		location.reload()
	})

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
			chips.replaceChildren(...notes.map((note) => makeChip(note.note, noteName(note.note.split('/')[0]))))
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
		const items = key === 'earIntervals' ? Ear.INTERVALS : Ear.QUALITIES
		container.replaceChildren(
			...items.map((item) => {
				const chip = document.createElement('button')
				chip.type = 'button'
				chip.className = 'chip'
				chip.textContent = item.id
				const name = Ear.nameOf(key === 'earIntervals' ? 'intervals' : 'chords', item.id)
				chip.title = name
				chip.setAttribute('aria-label', name)
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

	// A4 is locked behind its Change key: a brush while scrolling once moved it to 451 Hz unseen.
	const lockValue = root.querySelector<HTMLElement>('[data-lock-value]')!
	const lockPanel = root.querySelector<HTMLElement>('[data-lock-panel]')!
	const unlock = root.querySelector<HTMLButtonElement>('[data-unlock]')!
	function setLocked(locked: boolean) {
		lockPanel.hidden = locked
		unlock.textContent = locked ? t('Change') : t('Done')
		unlock.setAttribute('aria-expanded', String(!locked))
	}
	unlock.addEventListener('click', () => setLocked(!lockPanel.hidden))

	function sync() {
		lockValue.textContent = `${Settings.get().a4} Hz`
		syncSwitches()
		renderChips()
		syncEarChips()
		syncA4Notes()
		// The Calibration section on top (the page itself is #calibration).
		showCalibrationState(root)
	}

	// Hidden, onActivate syncs on the way back.
	subscribeVisible(root, sync)
	sync()

	return {
		onActivate() {
			setLocked(true)
			sync()
			// Only the section of the tab you came from opens (Appearance when the
			// app started here) and comes to the top; the ones left open close.
			const target = groups.find(({ group }) => group.dataset.group === (from() ?? 'appearance'))
			if (target && !search.value) {
				for (const entry of groups) setOpen(entry, entry === target)
				target.group.scrollIntoView({ block: 'start' })
			}
		},
		onReading() {},
		reset() {},
		// Nothing here listens; an open mic would only cost battery.
		wantsMic: () => false,
	}
}
