// A guarded key for what cannot be undone (Settings: reset a section to its
// defaults). A smoked-glass shutter marked RESET covers a red CONFIRM key as
// wide as the frame: slide the shutter away (or tap it) and the key is there
// for GUARD_MS, then the shutter closes by itself. A stray tap never resets.

const GUARD_MS = 3000
// Dragged past this share of its width, a released shutter stays open.
const OPEN_AT = 0.35
const DONE_MS = 700

const ICON =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M4 3.5V8h4.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** `what` names the thing reset, for screen readers. */
export function guardKey(what: string, onConfirm: () => void): HTMLElement {
	const frame = document.createElement('span')
	frame.className = 'guard'
	const confirm = document.createElement('button')
	confirm.type = 'button'
	confirm.className = 'guard__confirm'
	confirm.textContent = 'Confirm'
	confirm.setAttribute('aria-label', `Reset ${what} to the defaults`)
	const shutter = document.createElement('button')
	shutter.type = 'button'
	shutter.className = 'guard__shutter'
	shutter.innerHTML = `${ICON}<span>Reset</span>`
	shutter.setAttribute('aria-label', `Reset ${what}: open the guard`)
	frame.append(confirm, shutter)

	let timer = 0
	const setOpen = (open: boolean) => {
		frame.classList.toggle('is-open', open)
		shutter.style.transform = ''
		confirm.tabIndex = open ? 0 : -1
		shutter.tabIndex = open ? -1 : 0
		clearTimeout(timer)
		if (open) timer = window.setTimeout(() => setOpen(false), GUARD_MS)
	}
	setOpen(false)

	// The shutter follows the finger to the right; released past OPEN_AT it opens, else it slides back. A tap opens it too.
	let startX: number | null = null
	let dx = 0
	shutter.addEventListener('pointerdown', (event) => {
		startX = event.clientX
		dx = 0
		shutter.setPointerCapture(event.pointerId)
		frame.classList.add('is-dragging')
	})
	shutter.addEventListener('pointermove', (event) => {
		if (startX === null) return
		dx = Math.max(0, event.clientX - startX)
		shutter.style.transform = `translateX(${dx}px)`
	})
	const release = () => {
		if (startX === null) return
		startX = null
		frame.classList.remove('is-dragging')
		if (dx <= 3 || dx > frame.clientWidth * OPEN_AT) setOpen(true)
		else shutter.style.transform = ''
	}
	shutter.addEventListener('pointerup', release)
	shutter.addEventListener('pointercancel', release)
	// Keyboard: Enter / Space on the shutter (no pointer events then).
	shutter.addEventListener('click', (event) => {
		if (event.detail === 0) {
			setOpen(true)
			confirm.focus()
		}
	})

	confirm.addEventListener('click', () => {
		if (!frame.classList.contains('is-open')) return
		onConfirm()
		clearTimeout(timer)
		confirm.textContent = 'Done'
		setTimeout(() => {
			setOpen(false)
			confirm.textContent = 'Confirm'
		}, DONE_MS)
	})
	return frame
}
