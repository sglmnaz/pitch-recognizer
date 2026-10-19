// Small DOM helpers shared by the views. Markup lives in index.html; these
// only find, wire and update it, so each one must leave the markup exactly as
// the hand-written code it replaced did.
import * as Settings from '../core/settings'

/** `$` (first match, asserted present) and `$$` (all matches) inside `root`. */
export function scoped(root: ParentNode) {
	return {
		$: <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!,
		$$: <T extends Element = HTMLElement>(selector: string) => Array.from(root.querySelectorAll<T>(selector)),
	}
}

export function byId<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id)
	if (!element) throw new Error(`Missing #${id} element`)
	return element as T
}

/** An SVG element with its attributes, set in the order given. */
export function svgEl(name: string, attrs: Record<string, string | number>) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', name)
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
	return el
}

/** aria-pressed on every button from `on(button, index)`. */
export function setPressed<T extends Element>(buttons: readonly T[], on: (button: T, index: number) => boolean) {
	buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(on(button, i))))
}

/**
 * A segmented control: every `[attr]` button inside `container` calls
 * `onPick(its attr value)` on click. Returns `show(value)`, which presses the
 * button whose value it is (numbers compare as their string).
 */
export function bindSegmented(container: ParentNode, attr: string, onPick: (value: string) => void) {
	const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(`[${attr}]`))
	for (const button of buttons) button.addEventListener('click', () => onPick(button.getAttribute(attr)!))
	return (value: string | number) => setPressed(buttons, (button) => button.getAttribute(attr) === String(value))
}

/**
 * Writes an aria-live region. `dedupe`: only when the text changes (screen
 * readers re-read an identical write). `throttleMs`: at most this often,
 * unless the call is `force`d (starts, ends, results).
 */
export function liveRegion(el: HTMLElement, { throttleMs = 0, dedupe = false } = {}) {
	let last = 0
	return (text: string, force = false) => {
		if (dedupe && el.textContent === text) return
		const now = performance.now()
		if (throttleMs && !force && now - last < throttleMs) return
		last = now
		el.textContent = text
	}
}

/**
 * A page-wide shortcut: `handler` runs (default prevented) for `keys` ('Space'
 * by code, any other by key) only while every element in `roots` is shown,
 * the focus is on the bare page (or a target `allow` accepts) and no
 * modifier or auto-repeat is involved: Space and Enter keep their own
 * meaning in buttons, fields and selects.
 */
export function onBareKey(roots: HTMLElement[], keys: string[], handler: (event: KeyboardEvent) => void, allow?: (target: EventTarget) => boolean) {
	document.addEventListener('keydown', (event) => {
		if (roots.some((root) => root.hidden) || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return
		if (!keys.includes(event.code === 'Space' ? 'Space' : event.key)) return
		const target = event.target
		if (target !== document.body && !(target && allow?.(target))) return
		event.preventDefault()
		handler(event)
	})
}

/** `fn`, skipped while `root` is hidden (the view catches up in onActivate). */
export const whenVisible = (root: HTMLElement, fn: () => void) => () => {
	if (!root.hidden) fn()
}

/** Settings.subscribe for a view that only redraws while it shows. */
export const subscribeVisible = (root: HTMLElement, fn: () => void) => Settings.subscribe(whenVisible(root, fn))
