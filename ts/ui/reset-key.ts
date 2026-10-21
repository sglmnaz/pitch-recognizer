import { t } from '../core/i18n'

/**
 * A Reset key that needs two taps: the first arms it ("Sure?", lit red via
 * .is-armed) for ARM_MS, the second runs `onReset`. A stray tap never wipes
 * anything. `what` names the thing reset, for screen readers, in the app's language.
 */
const ARM_MS = 3000

export function resetKey(what: string, onReset: () => void): HTMLButtonElement {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = 'link-btn reset-key'
	let armed = 0
	const idle = () => {
		armed = 0
		button.textContent = t('Reset')
		button.setAttribute('aria-label', t('Reset {what} to the defaults', { what }))
		button.classList.remove('is-armed')
	}
	button.addEventListener('click', () => {
		if (armed) {
			clearTimeout(armed)
			idle()
			onReset()
			return
		}
		button.textContent = t('Sure?')
		button.setAttribute('aria-label', t('Tap again to reset {what}', { what }))
		button.classList.add('is-armed')
		armed = window.setTimeout(idle, ARM_MS)
	})
	idle()
	return button
}
