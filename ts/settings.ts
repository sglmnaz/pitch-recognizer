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
}

const STORAGE_KEY = 'pitch-recognizer:settings'

const defaults: Settings = {
	includeAccidentals: false,
	matchAnyOctave: false,
	lightStaff: false,
	disabledNotes: [],
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
