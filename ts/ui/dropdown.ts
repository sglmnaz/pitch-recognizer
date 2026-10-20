/**
 * The old-school dropdown (docs/design/oldschool-components.html, "Dropdown"):
 * the closed control is an LCD window, the open list a dark card with engraved
 * group names and the chosen item in LCD negative with its lamp.
 *
 * Progressive enhancement of a native <select>, which stays in the DOM (hidden)
 * as the single source of truth: its value, its `change` events and every
 * binding on it (data-setting, the steppers) keep working untouched. Code that
 * sets `select.value` / `selectedIndex` or replaces its options is picked up
 * (instance setters + a MutationObserver), so callers need nothing new.
 *
 * ARIA: a button with role combobox owning a listbox (aria-activedescendant).
 * Keyboard: ↓ ↑ Enter Space open; ↓ ↑ Home End move; Enter / Space pick;
 * Escape / Tab close; typing a letter jumps to the next option starting with it.
 */

let uid = 0

/** Enhances every `select.select` under root that isn't already. Call once the views are built. */
export function enhanceSelects(root: ParentNode = document) {
	for (const select of root.querySelectorAll<HTMLSelectElement>('select.select')) {
		if (!select.dataset.enhanced) dropdown(select)
	}
}

export function dropdown(select: HTMLSelectElement) {
	const id = `dd${++uid}`
	select.dataset.enhanced = ''

	const button = document.createElement('button')
	button.type = 'button'
	// Same look as before: the LCD window classes stay on the visible control.
	button.className = `${select.className} dropdown`
	button.setAttribute('role', 'combobox')
	button.setAttribute('aria-haspopup', 'listbox')
	button.setAttribute('aria-expanded', 'false')
	button.setAttribute('aria-controls', `${id}-list`)
	const name = select.getAttribute('aria-label')
	if (name) button.setAttribute('aria-label', name)
	else {
		// Inside a settings row: named by the row's title.
		const title = select.closest('label, .switch')?.querySelector<HTMLElement>('.switch__title')
		if (title) {
			title.id ||= `${id}-label`
			button.setAttribute('aria-labelledby', title.id)
		}
	}
	// The button comes first, so a wrapping <label> activates it, not the hidden select.
	select.before(button)
	select.hidden = true
	select.tabIndex = -1

	const list = document.createElement('div')
	list.className = 'dropdown__list'
	list.id = `${id}-list`
	list.setAttribute('role', 'listbox')
	list.tabIndex = -1
	list.hidden = true
	document.body.append(list)

	let active = -1
	const options = () => Array.from(select.options).filter((o) => !o.hidden)
	const enabled = () => options().filter((o) => !o.disabled)

	function sync() {
		button.textContent = select.selectedOptions[0]?.textContent ?? ''
		button.disabled = select.disabled
	}

	function build() {
		const rows: HTMLElement[] = []
		let group: HTMLOptGroupElement | null = null
		for (const option of options()) {
			const parent = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null
			if (parent && parent !== group) {
				const label = document.createElement('div')
				label.className = 'dropdown__group'
				label.textContent = parent.label
				label.setAttribute('role', 'presentation')
				rows.push(label)
			}
			group = parent
			const row = document.createElement('div')
			row.className = 'dropdown__option'
			row.id = `${id}-${option.index}`
			row.dataset.index = String(option.index)
			row.setAttribute('role', 'option')
			row.setAttribute('aria-selected', String(option.selected))
			if (option.disabled) row.setAttribute('aria-disabled', 'true')
			row.textContent = option.textContent
			rows.push(row)
		}
		list.replaceChildren(...rows)
	}

	function highlight(index: number) {
		active = index
		for (const row of list.querySelectorAll<HTMLElement>('.dropdown__option')) row.classList.toggle('is-active', Number(row.dataset.index) === index)
		const row = list.querySelector<HTMLElement>(`[data-index="${index}"]`)
		if (row) {
			list.setAttribute('aria-activedescendant', row.id)
			row.scrollIntoView({ block: 'nearest' })
		}
	}

	function place() {
		const box = button.getBoundingClientRect()
		const below = innerHeight - box.bottom - 8
		const above = box.top - 8
		const up = below < 220 && above > below
		list.style.left = `${Math.max(8, Math.min(box.left, innerWidth - Math.max(box.width, 180) - 8))}px`
		list.style.minWidth = `${box.width}px`
		list.style.maxHeight = `${Math.min(360, up ? above : below)}px`
		list.style.top = up ? '' : `${box.bottom + 4}px`
		list.style.bottom = up ? `${innerHeight - box.top + 4}px` : ''
	}

	function open() {
		if (!list.hidden || select.disabled) return
		build()
		list.hidden = false
		place()
		button.setAttribute('aria-expanded', 'true')
		highlight(select.selectedIndex)
		list.focus({ preventScroll: true })
		addEventListener('pointerdown', outside, true)
		addEventListener('resize', onResize)
		addEventListener('scroll', onScroll, true)
	}

	function close(refocus = true) {
		if (list.hidden) return
		list.hidden = true
		button.setAttribute('aria-expanded', 'false')
		removeEventListener('pointerdown', outside, true)
		removeEventListener('resize', onResize)
		removeEventListener('scroll', onScroll, true)
		if (refocus) button.focus({ preventScroll: true })
	}

	function pick(index: number) {
		const option = select.options[index]
		if (!option || option.disabled) return
		const changed = select.selectedIndex !== index
		select.selectedIndex = index
		close()
		if (changed) select.dispatchEvent(new Event('change', { bubbles: true }))
	}

	function step(delta: 1 | -1) {
		const all = enabled()
		const at = all.findIndex((o) => o.index === active)
		const next = all[Math.max(0, Math.min(all.length - 1, at + delta))]
		if (next) highlight(next.index)
	}

	const onResize = () => close(false)
	const outside = (event: Event) => {
		const target = event.target as Node
		if (!list.contains(target) && !button.contains(target)) close(false)
	}
	// Scrolling the page moves the button away from the list; scrolling the list itself is fine.
	const onScroll = (event: Event) => {
		if (event.target !== list) close(false)
	}

	button.addEventListener('click', () => (list.hidden ? open() : close()))
	button.addEventListener('keydown', (event) => {
		if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
			event.preventDefault()
			open()
		}
	})
	list.addEventListener('click', (event) => {
		const row = (event.target as Element).closest<HTMLElement>('.dropdown__option')
		if (row) pick(Number(row.dataset.index))
	})
	list.addEventListener('pointermove', (event) => {
		const row = (event.target as Element).closest<HTMLElement>('.dropdown__option')
		if (row && !row.hasAttribute('aria-disabled')) highlight(Number(row.dataset.index))
	})
	list.addEventListener('keydown', (event) => {
		const all = enabled()
		switch (event.key) {
			case 'ArrowDown':
				step(1)
				break
			case 'ArrowUp':
				step(-1)
				break
			case 'Home':
				if (all[0]) highlight(all[0].index)
				break
			case 'End':
				if (all.length) highlight(all[all.length - 1].index)
				break
			case 'Enter':
			case ' ':
				pick(active)
				break
			case 'Escape':
				close()
				break
			case 'Tab':
				close()
				return
			default: {
				if (event.key.length !== 1) return
				// Type-ahead: the next option after the active one starting with that letter.
				const letter = event.key.toLowerCase()
				const at = all.findIndex((o) => o.index === active)
				const next = [...all.slice(at + 1), ...all.slice(0, at + 1)].find((o) => o.text.trim().toLowerCase().startsWith(letter))
				if (next) highlight(next.index)
			}
		}
		event.preventDefault()
	})

	// Programmatic changes: value / selectedIndex setters on this instance, and
	// options replaced or edited (labels, disabled, the selected attribute).
	for (const prop of ['value', 'selectedIndex'] as const) {
		const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop)!
		Object.defineProperty(select, prop, {
			configurable: true,
			get() {
				return native.get!.call(this)
			},
			set(value) {
				native.set!.call(this, value)
				sync()
			},
		})
	}
	select.addEventListener('change', sync)
	new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, characterData: true })
	sync()
}
