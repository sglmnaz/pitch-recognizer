// Self-check for the note naming systems (ts/music/note-names.ts): every
// system on single notes, pitches, chord symbols, slash pairs, double
// accidentals, glyphs, and the spoken form. Run with `npm run check:note-names`.
import { formatNote, noteName, noteSystemFor, spokenNote, useNoteSystem, type NoteSystem } from '../ts/music/note-names.ts'
import { deviceLanguage } from '../ts/core/locale.ts'
import { check, finish } from './check.ts'

const CASES: [string, Record<NoteSystem, string>][] = [
	['C', { letters: 'C', solfege: 'Do', french: 'Do', german: 'C' }],
	['D', { letters: 'D', solfege: 'Re', french: 'Ré', german: 'D' }],
	['G', { letters: 'G', solfege: 'Sol', french: 'Sol', german: 'G' }],
	['B', { letters: 'B', solfege: 'Si', french: 'Si', german: 'H' }],
	['Bb', { letters: 'Bb', solfege: 'Sib', french: 'Sib', german: 'B' }],
	['Bbb', { letters: 'Bbb', solfege: 'Sibb', french: 'Sibb', german: 'Bb' }],
	['B#', { letters: 'B#', solfege: 'Si#', french: 'Si#', german: 'H#' }],
	['F#', { letters: 'F#', solfege: 'Fa#', french: 'Fa#', german: 'F#' }],
	['Eb', { letters: 'Eb', solfege: 'Mib', french: 'Mib', german: 'Eb' }],
	['C#4', { letters: 'C#4', solfege: 'Do#4', french: 'Do#4', german: 'C#4' }],
	['B3', { letters: 'B3', solfege: 'Si3', french: 'Si3', german: 'H3' }],
	['C#4/Db4', { letters: 'C#4/Db4', solfege: 'Do#4/Reb4', french: 'Do#4/Réb4', german: 'C#4/Db4' }],
	['Am7', { letters: 'Am7', solfege: 'Lam7', french: 'Lam7', german: 'Am7' }],
	['Bm7b5', { letters: 'Bm7b5', solfege: 'Sim7b5', french: 'Sim7b5', german: 'Hm7b5' }],
	['Bbmaj7', { letters: 'Bbmaj7', solfege: 'Sibmaj7', french: 'Sibmaj7', german: 'Bmaj7' }],
	['B7', { letters: 'B7', solfege: 'Si7', french: 'Si7', german: 'H7' }],
	['C/E', { letters: 'C/E', solfege: 'Do/Mi', french: 'Do/Mi', german: 'C/E' }],
	['F♯/G♭', { letters: 'F♯/G♭', solfege: 'Fa♯/Sol♭', french: 'Fa♯/Sol♭', german: 'F♯/G♭' }],
	['B♭m', { letters: 'B♭m', solfege: 'Si♭m', french: 'Si♭m', german: 'Bm' }],
	['—', { letters: '—', solfege: '—', french: '—', german: '—' }],
]
for (const [name, want] of CASES) {
	for (const system of Object.keys(want) as NoteSystem[]) {
		const got = formatNote(name, system)
		check(`${system}: ${name} → ${want[system]}`, got === want[system], got)
	}
}

check('spoken: C#/Db', spokenNote('C#/Db', 'letters') === 'C sharp or D flat', spokenNote('C#/Db', 'letters'))
check('spoken: Bb in solfège', spokenNote('Bb', 'solfege') === 'Si flat', spokenNote('Bb', 'solfege'))
check('spoken: Bb in German', spokenNote('Bb', 'german') === 'B', spokenNote('Bb', 'german'))
check(
	'spoken: own words',
	spokenNote('F#/Gb', 'solfege', { sharp: 'diesis', flat: 'bemolle', or: 'o' }) === 'Fa diesis o Sol bemolle',
	spokenNote('F#/Gb', 'solfege', { sharp: 'diesis', flat: 'bemolle', or: 'o' })
)

check('letters until a system is set', noteName('Am') === 'Am')
useNoteSystem('solfege')
check('noteName uses the system set', noteName('Am') === 'Lam')
useNoteSystem('letters')

check('auto: Italian → Do Re Mi', noteSystemFor('auto', 'it') === 'solfege')
check('auto: English → letters', noteSystemFor('auto', 'en') === 'letters')
check('a choice beats the language', noteSystemFor('german', 'it') === 'german' && noteSystemFor('solfege', 'en') === 'solfege')

check('device: it-IT → it', deviceLanguage(['it-IT', 'en-US']) === 'it')
check('device: first supported wins', deviceLanguage(['de-DE', 'it-CH', 'en']) === 'it')
check('device: en-GB → en', deviceLanguage(['en-GB', 'it']) === 'en')
check('device: unsupported → en', deviceLanguage(['fr-FR', 'de']) === 'en' && deviceLanguage([]) === 'en')

finish('note names ok')
