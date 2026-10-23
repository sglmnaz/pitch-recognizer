// Trainer → Songs: the songs that come with Pluck. Public domain only (the
// composer died over 70 years ago, L. 633/1941 art. 25) and transcribed here
// from the melody, not copied from anyone's arrangement or tab; positions chosen
// for an open-position guitar, an octave under the written pitch as guitar music
// is read. Imported files (licensed songs) never come in here: they stay on the
// user's device (ts/features/songs/songs.store.ts).
import { barQuarters, parseBars, type Song, type SongBar } from './song.ts'

interface Entry {
	id: string
	/** English, translated by the view (t(title)). */
	title: string
	artist: string
	/** Bars of `beats`/`unit` at `tempo` quarters per minute unless a bar says otherwise. */
	beats: number
	unit: number
	tempo: number
	text: string
	/** Per bar index, what that bar adds (a pickup's meter, repeats, endings, a section). */
	marks?: Record<number, Partial<SongBar>>
}

const ENTRIES: Entry[] = [
	{
		// Symphony No. 9, finale (1824): the theme, as everyone learns it first.
		id: 'builtin:ode-to-joy',
		title: 'Ode to Joy',
		artist: 'L. van Beethoven',
		beats: 4,
		unit: 4,
		tempo: 100,
		text: [
			'4:1/0 4:1/0 4:1/1 4:1/3 | 4:1/3 4:1/1 4:1/0 4:2/3 | 4:2/1 4:2/1 4:2/3 4:1/0 | 4.:1/0 8:2/3 2:2/3',
			'4:1/0 4:1/0 4:1/1 4:1/3 | 4:1/3 4:1/1 4:1/0 4:2/3 | 4:2/1 4:2/1 4:2/3 4:1/0 | 4.:2/3 8:2/1 2:2/1',
			'4:2/3 4:2/3 4:1/0 4:2/1 | 4:2/3 8:1/0 8:1/1 4:1/0 4:2/1 | 4:2/3 8:1/0 8:1/1 4:1/0 4:2/3 | 4:2/1 4:2/3 2:3/0',
			'4:1/0 4:1/0 4:1/1 4:1/3 | 4:1/3 4:1/1 4:1/0 4:2/3 | 4:2/1 4:2/1 4:2/3 4:1/0 | 4.:2/3 8:2/1 2:2/1',
		].join(' | '),
		marks: { 0: { section: 'A' }, 8: { section: 'B' }, 12: { section: 'A' } },
	},
	{
		// Bagatelle WoO 59 (1810), the opening theme: a pickup, eight bars played twice.
		id: 'builtin:fur-elise',
		title: 'Für Elise',
		artist: 'L. van Beethoven',
		beats: 3,
		unit: 8,
		tempo: 60,
		text: [
			'16:1/0 16:2/4',
			'16:1/0 16:2/4 16:1/0 16:2/0 16:2/3 16:2/1 | 8:3/2 16:r 16:5/3 16:4/2 16:3/2 | 8:2/0 16:r 16:4/2 16:3/1 16:2/0',
			'8:2/1 16:r 16:4/2 16:1/0 16:2/4 | 16:1/0 16:2/4 16:1/0 16:2/0 16:2/3 16:2/1 | 8:3/2 16:r 16:5/3 16:4/2 16:3/2',
			'8:2/0 16:r 16:4/2 16:2/1 16:2/0 | 8:3/2 8:r 16:1/0 16:2/4 | 4.:3/2',
		].join(' | '),
		marks: { 0: { beats: 2, unit: 16 }, 1: { repeatStart: true }, 8: { endings: 1, repeatEnd: 2 }, 9: { endings: 2 } },
	},
]

function build(entry: Entry): Song {
	const bar = (i: number): SongBar => ({ beats: entry.beats, unit: entry.unit, tempo: entry.tempo, ...entry.marks?.[i] })
	const notes = parseBars(entry.text, (i) => barQuarters(bar(i)))
	const bars = notes.map((_, i) => bar(i))
	return { id: entry.id, title: entry.title, artist: entry.artist, bars, tracks: [{ name: 'Guitar', tuning: [64, 59, 55, 50, 45, 40], bars: notes }] }
}

export const BUILTIN: Song[] = ENTRIES.map(build)

export const builtinById = (id: string) => BUILTIN.find((song) => song.id === id)
