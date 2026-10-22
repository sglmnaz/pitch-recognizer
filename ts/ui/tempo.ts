import { flash } from './dom'

// Setting a tempo, the Metronome's way, shared by every view that has one:
// keys that act on pointer-down and repeat when held, and numbers on an LCD
// that can be typed (tap the number, the phone's number pad opens).

// Holding − / + repeats after HOLD_DELAY_MS, every REPEAT_MS; after SPEED_UP
// repeats ±1 jumps 5 at a time, so 30 → 300 does not take half a minute.
const HOLD_DELAY_MS = 400
const REPEAT_MS = 70
const SPEED_UP = 20

/** Pointer-down acts at once (no 300 ms touch delay, and timing taps matter);
 * `click` with detail 0 is the keyboard. Holding repeats. */
export function onPress(button: HTMLElement, action: (repeats: number) => void, repeat = false) {
	let delay = 0
	let ticker = 0
	const release = () => {
		clearTimeout(delay)
		clearInterval(ticker)
	}
	button.addEventListener('pointerdown', (event) => {
		if (event.button !== 0) return
		release()
		action(0)
		if (!repeat) return
		delay = setTimeout(() => {
			let repeats = 0
			ticker = setInterval(() => action(++repeats), REPEAT_MS) as unknown as number
		}, HOLD_DELAY_MS) as unknown as number
	})
	for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, release)
	button.addEventListener('click', (event) => {
		if (event.detail === 0) action(0)
	})
	// A long press must not open the context menu on touch screens.
	button.addEventListener('contextmenu', (event) => event.preventDefault())
}

/** −10 − + +10 keys (`data-tempo` = the step): ±1 speeds up when held, ±10 is already the big step. */
export function bindTempoKeys(buttons: Iterable<HTMLElement>, nudge: (by: number) => void) {
	for (const button of buttons) {
		const by = Number(button.dataset.tempo)
		onPress(button, (repeats) => nudge(Math.abs(by) === 1 && repeats > SPEED_UP ? by * 5 : by), true)
	}
}

/**
 * A number on an LCD that can be typed: committed on Enter or when focus
 * leaves, Escape puts the current value back. The field is as wide as its
 * digits, so a unit after it hangs right off the number. `show` never
 * overwrites what the user is typing unless forced.
 */
export function numberField(input: HTMLInputElement, get: () => number, set: (value: number) => void) {
	const fit = () => {
		const n = Math.max(2, input.value.length)
		input.style.width = `calc(${n}ch + ${n} * var(--field-spacing, 0px))`
	}
	function show(value: number, force = false) {
		if (!force && document.activeElement === input) return
		const next = String(value)
		if (input.value !== '' && input.value !== next) flash(input)
		input.value = next
		fit()
	}
	input.addEventListener('focus', () => input.select())
	input.addEventListener('input', () => {
		input.value = input.value.replace(/\D/g, '')
		fit()
	})
	input.addEventListener('change', () => {
		const typed = Number(input.value)
		if (input.value !== '' && typed > 0) set(typed)
		show(get(), true)
	})
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') input.blur()
		if (event.key === 'Escape') {
			show(get(), true)
			input.blur()
		}
	})
	return { show }
}
