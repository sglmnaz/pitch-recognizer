import { possibleFrequencies, possibleFrequenciesWithoutAccidentals, type NoteInfo } from './notes'

export interface Settings {
	/** Add sharps/flats to the pool of possible target notes. */
	includeAccidentals: boolean
	/** Accept the right note in any octave, not just the one shown. */
	matchAnyOctave: boolean
	/** Keep the staff on a light background even when the app is in dark mode. */
	lightStaff: boolean
	/** Notes (by scientific name) the user has switched off as targets. */
	disabledNotes: string[]
	/** Scales fretboard palette: follow the app theme, or force one. */
	fretboardTheme: 'auto' | 'light' | 'dark'
	/** Run the neck top to bottom like a chord diagram (any screen width). */
	fretboardVertical: boolean
	/** What the fretboard dots say. */
	scaleLabels: 'notes' | 'intervals' | 'none'
	/** Degree numbers (1–7) drawn in colour; b3 counts as 3. */
	scaleDegrees: number[]
	/** Fret size multiplier, 0.5–1.5: height when vertical, width when horizontal. */
	fretSize: number

	/* Metronome */
	/** Tempo, 30–300 BPM. */
	metroBpm: number
	/** Beats per bar (1–12) and the note value that gets the beat (4 or 8). */
	metroBeats: number
	metroUnit: number
	/** Level per beat, 12 slots (a shorter bar uses the first ones): 0 mute, 1 normal, 2 accent. */
	metroAccents: number[]
	/** Clicks per beat: 1 none, 2 eighths, 3 triplets, 4 sixteenths. */
	metroSubdivision: number
	metroSound: 'click' | 'wood' | 'beep'
	/** 0–1. */
	metroVolume: number
	/** Flash the screen on beat 1. */
	metroFlash: boolean
	/** Speed trainer: +step BPM every `bars` bars until `target`. */
	metroTrainerOn: boolean
	metroTrainerStep: number
	metroTrainerBars: number
	metroTrainerTarget: number
}

const STORAGE_KEY = 'pitch-recognizer:settings'

const defaults: Settings = {
	includeAccidentals: false,
	matchAnyOctave: false,
	lightStaff: false,
	disabledNotes: [],
	fretboardTheme: 'auto',
	fretboardVertical: false,
	scaleLabels: 'notes',
	scaleDegrees: [1, 3, 5],
	fretSize: 1,
	metroBpm: 100,
	metroBeats: 4,
	metroUnit: 4,
	metroAccents: [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
	metroSubdivision: 1,
	metroSound: 'click',
	metroVolume: 0.8,
	metroFlash: false,
	metroTrainerOn: false,
	metroTrainerStep: 5,
	metroTrainerBars: 4,
	metroTrainerTarget: 160,
}

const listeners = new Set<() => void>()
let settings: Settings = load()

function load(): Settings {
	try {
		const stored = localStorage.getItem(STORAGE_KEY)
		return stored ? { ...defaults, ...JSON.parse(stored) } : { ...defaults }
	} catch {
		return { ...defaults }
	}
}

function persist() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
	} catch {
		// Storage may be unavailable (private mode); settings stay in memory.
	}
}

export function get(): Readonly<Settings> {
	return settings
}

export function update(patch: Partial<Settings>) {
	settings = { ...settings, ...patch }
	persist()
	listeners.forEach((fn) => fn())
}

export function subscribe(fn: () => void): () => void {
	listeners.add(fn)
	return () => listeners.delete(fn)
}

/** Every note that could appear given the accidentals setting. */
export function rangeNotes(): NoteInfo[] {
	return settings.includeAccidentals ? possibleFrequencies : possibleFrequenciesWithoutAccidentals
}

/**
 * The notes actually used as targets: the range minus the user's disabled ones.
 * Falls back to the full range if everything has been switched off.
 */
export function activePool(): NoteInfo[] {
	const disabled = new Set(settings.disabledNotes)
	const pool = rangeNotes().filter((note) => !disabled.has(note.note))
	return pool.length > 0 ? pool : rangeNotes()
}

export function isNoteEnabled(note: string): boolean {
	return !settings.disabledNotes.includes(note)
}

export function setNoteEnabled(note: string, enabled: boolean) {
	const disabled = new Set(settings.disabledNotes)
	if (enabled) {
		disabled.delete(note)
	} else {
		disabled.add(note)
	}
	update({ disabledNotes: [...disabled] })
}

/** Enables every note in the current range (clears the disabled list). */
export function enableAllNotes() {
	update({ disabledNotes: [] })
}

/** Disables every note in the current range. */
export function disableAllNotes() {
	update({ disabledNotes: rangeNotes().map((note) => note.note) })
}
