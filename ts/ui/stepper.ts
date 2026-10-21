import { t } from '../core/i18n'

/**
 * Puts ◀ ▶ stepper keys around a select (the LCD selector of the old-school
 * look): each steps to the previous / next enabled option and fires the
 * select's own `change`, so whatever listens to the select needs nothing new.
 * Tapping the select itself still opens the system list.
 */
export function withStepper(select: HTMLSelectElement, label = select.getAttribute('aria-label') ?? t('option')) {
	const wrap = document.createElement('div')
	wrap.className = 'stepper'
	select.replaceWith(wrap)

	const key = (text: string, name: string, step: 1 | -1) => {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'key key--step'
		button.textContent = text
		button.setAttribute('aria-label', name === 'Previous' ? t('Previous {thing}', { thing: label }) : t('Next {thing}', { thing: label }))
		button.addEventListener('click', () => {
			for (let i = select.selectedIndex + step; i >= 0 && i < select.options.length; i += step) {
				if (select.options[i].disabled) continue
				select.selectedIndex = i
				select.dispatchEvent(new Event('change', { bubbles: true }))
				return
			}
		})
		return button
	}

	wrap.append(key('◀', 'Previous', -1), select, key('▶', 'Next', 1))
	return wrap
}
