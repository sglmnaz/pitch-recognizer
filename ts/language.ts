// The language and the note names, set before any other module of the app is
// evaluated (ts/main.ts imports this first): views and their module-level
// strings speak them from the start. index.html, written in English, is
// translated here too, so the first view built reads the right words. A
// change of either setting reloads the app: nothing built before keeps the old
// words. The head script in index.html picks the same language (<html lang>)
// and keeps the page hidden until this has run (data-i18n="pending").
import * as Settings from './core/settings'
import { languageFor } from './core/locale'
import { useLanguage } from './core/i18n'
import { noteSystemFor, useNoteSystem } from './music/note-names'
import { translate } from './ui/translate'
import { it } from './i18n/it'

const { language: languageChoice, noteNames } = Settings.get()
const language = languageFor(languageChoice)

useLanguage(language, language === 'it' ? it : {})
useNoteSystem(noteSystemFor(noteNames, language))
document.documentElement.lang = language
if (language !== 'en') {
	translate(document)
	// Tab labels longer than the English ones (IMPOSTAZIONI) get a tighter cut on phones (layout.css).
	for (const label of document.querySelectorAll('.tab__label')) label.classList.toggle('tab__label--long', (label.textContent ?? '').length > 9)
}
document.documentElement.removeAttribute('data-i18n')

Settings.subscribe(() => {
	const now = Settings.get()
	if (now.language !== languageChoice || now.noteNames !== noteNames) location.reload()
})
