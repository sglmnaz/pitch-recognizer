/**
 * A Reset key that needs two taps: the first arms it ("Sure?", lit red via
 * .is-armed) for ARM_MS, the second runs `onReset`. A stray tap never wipes
 * anything. `what` names the thing reset, for screen readers.
 */
const ARM_MS = 3000

export function resetKey(what: string, onReset: () => void): HTMLButtonElement {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = 'link-btn reset-key'
	let armed = 0
	const idle = () => {
		armed = 0
		button.textContent = 'Reset'
		button.setAttribute('aria-label', `Reset ${what} to the defaults`)
		button.classList.remove('is-armed')
	}
	button.addEventListener('click', () => {
		if (armed) {
			clearTimeout(armed)
			idle()
			onReset()
			return
		}
		button.textContent = 'Sure?'
		button.setAttribute('aria-label', `Tap again to reset ${what}`)
		button.classList.add('is-armed')
		armed = window.setTimeout(idle, ARM_MS)
	})
	idle()
	return button
}
