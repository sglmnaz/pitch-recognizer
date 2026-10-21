import { currentLanguage } from '../core/i18n'

/**
 * The guide: every tab has a Guide key (data-help="<tab>") that opens one shared
 * <dialog>, filled from that tab's <template id="help-<tab>"> in index.html.
 * The native modal dialog handles focus trapping, Escape and returning focus.
 */
export function initHelp() {
	const dialog = document.getElementById('help') as HTMLDialogElement
	const title = dialog.querySelector<HTMLElement>('.help__title')!
	const body = dialog.querySelector<HTMLElement>('.help__body')!

	document.addEventListener('click', (event) => {
		const button = (event.target as Element).closest<HTMLElement>('[data-help]')
		if (!button) return
		// The page in the app's language (help-tuner-it), else the English one.
		const template = (document.getElementById(`help-${button.dataset.help}-${currentLanguage()}`) ??
			document.getElementById(`help-${button.dataset.help}`)) as HTMLTemplateElement | null
		if (!template) return
		title.textContent = template.dataset.title ?? ''
		body.replaceChildren(template.content.cloneNode(true))
		body.scrollTop = 0
		dialog.showModal()
	})

	dialog.querySelector('.help__close')!.addEventListener('click', () => dialog.close())
	// A tap on the backdrop (outside the box) closes it too.
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) dialog.close()
	})
}
