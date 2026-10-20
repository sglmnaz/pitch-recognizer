import { clamp } from '../core/math'

// A finger moving further than this is scrolling, not pressing (CSS px; a
// little tighter than the browser's own tap slop).
const SLOP = 10
// A touch this soon after the page scrolled is stopping a fling, not a press.
const AFTER_SCROLL_MS = 250
// The fader cap's width (.range thumb, settings.css): its centre travels
// between half a cap from each end.
const THUMB = 14
// How far around a fader a touch still grabs it.
const REACH = 8

/**
 * Keeps a finger scrolling a page of controls (the Settings tab) from changing
 * them by brushing past:
 * - faders ignore the touch itself (pointer-events: none on coarse pointers,
 *   settings.css) and move only once the finger travels sideways, so a tap or
 *   a vertical swipe over one scrolls the page and leaves the value alone;
 * - a tap whose finger slid, or that stops the page scrolling, is dropped
 *   before it reaches a key, a chip or a switch.
 * The keyboard and a fine pointer are untouched.
 */
export function guardTouches(root: HTMLElement) {
	let lastScroll = 0
	addEventListener('scroll', () => (lastScroll = performance.now()), { capture: true, passive: true })

	let start: { id: number; x: number; y: number; moved: boolean; scrolling: boolean } | null = null
	let fader: HTMLInputElement | null = null
	let dragging = false
	let dropClick = false

	const faderAt = (x: number, y: number) =>
		Array.from(root.querySelectorAll<HTMLInputElement>('input[type="range"]')).find((input) => {
			const r = input.getBoundingClientRect()
			return r.width > 0 && x >= r.left - REACH && x <= r.right + REACH && y >= r.top - REACH && y <= r.bottom + REACH
		}) ?? null

	function slide(input: HTMLInputElement, x: number) {
		const r = input.getBoundingClientRect()
		const min = Number(input.min)
		const max = Number(input.max)
		const before = input.value
		// The input snaps the value to its step.
		input.value = String(min + clamp((x - r.left - THUMB / 2) / (r.width - THUMB), 0, 1) * (max - min))
		if (input.value !== before) input.dispatchEvent(new Event('input', { bubbles: true }))
	}

	root.addEventListener('pointerdown', (event) => {
		dropClick = false
		// A fine pointer that reaches the fader itself drives it natively.
		fader = event.target instanceof HTMLInputElement && event.target.type === 'range' ? null : faderAt(event.clientX, event.clientY)
		if (event.pointerType !== 'touch') {
			start = null
			// A mouse on a touch device (faders ignore it too): no scrolling to tell apart.
			dragging = fader !== null
			if (fader) slide(fader, event.clientX)
			return
		}
		start = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, scrolling: performance.now() - lastScroll < AFTER_SCROLL_MS }
		dragging = false
	})

	root.addEventListener('pointermove', (event) => {
		if (start && event.pointerId === start.id) {
			const dx = Math.abs(event.clientX - start.x)
			const dy = Math.abs(event.clientY - start.y)
			start.moved ||= Math.max(dx, dy) > SLOP
			// Sideways first: the finger means the fader (a vertical swipe makes the
			// browser scroll, which cancels the pointer).
			if (fader && !dragging && dx > SLOP && dx > dy) dragging = true
		}
		if (fader && dragging) slide(fader, event.clientX)
	})

	const end = (event: PointerEvent) => {
		if (start && event.pointerId === start.id) dropClick = start.moved || start.scrolling
		start = null
		fader = null
		dragging = false
	}
	root.addEventListener('pointerup', end)
	root.addEventListener('pointercancel', end)

	// detail 0 is the keyboard (Enter, Space): always let it through.
	root.addEventListener(
		'click',
		(event) => {
			if (!dropClick || event.detail === 0) return
			dropClick = false
			event.preventDefault()
			event.stopPropagation()
		},
		true
	)
}
