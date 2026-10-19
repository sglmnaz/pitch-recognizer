import { possibleFrequencies, possibleFrequenciesWithoutAccidentals, type NoteInfo } from './notes'
import { clampA4, tuningById } from './tuning'
import { DEFAULT_INTERVALS, DEFAULT_QUALITIES, pool } from './ear'

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

	/* Tuner ---------------------------------------------------------------- */
	/** Tuning id (ts/tuning.ts). */
	tuning: string
	/** Chromatic: nearest note of any pitch. Guitar: cents off the nearest string of the tuning. */
	tunerMode: 'chromatic' | 'guitar'
	/** A4 reference in Hz, 415–466. Drives note naming and cents in the tuner and the trainer. */
	a4: number
	/** Cents either side of a note that count as in tune: 2, 5 or 10. */
	tolerance: number
	/** Loudness of the string reference tone, 0–1. */
	toneVolume: number

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

	/* Chords (ts/views/chord-library.ts) */
	/** Sub-view of the Chords tab: live recognizer, chord dictionary, identifier. */
	chordsMode: 'listen' | 'library' | 'identify'
	/** What the chord diagram dots say (fingers: the finger numbers move into the dots). */
	chordLabels: 'degrees' | 'notes' | 'fingers' | 'none'
	/** Tapping a chord: all strings at once, low to high, or one by one. */
	chordPlay: 'strum' | 'arpeggio'

	/* Fretboard (shared by every neck, ts/fretboard.ts) */
	/** Mirror the neck: nut on the right when horizontal, low string on the right when vertical. */
	leftHanded: boolean

	/* Trainer: ear training (ts/ear.ts) */
	/** Which exercise the Trainer shows. */
	trainerExercise: 'notes' | 'intervals' | 'chords'
	/** Interval ids (ts/ear.ts INTERVALS) and chord quality ids (QUALITIES) asked. */
	earIntervals: string[]
	earChords: string[]
	/** How the two notes of an interval are played; mixed picks one per question. */
	earDirection: 'up' | 'down' | 'harmonic' | 'mixed'
	/** Seconds between the two notes of a melodic interval. */
	earGap: number
	/** Move on by itself shortly after a right answer. */
	earAutoAdvance: boolean
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
	tuning: 'standard',
	tunerMode: 'guitar',
	a4: 440,
	tolerance: 5,
	toneVolume: 0.6,
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

	chordsMode: 'listen',
	chordLabels: 'degrees',
	chordPlay: 'strum',

	/* Fretboard */
	leftHanded: false,

	/* Trainer: ear training */
	trainerExercise: 'notes',
	earIntervals: DEFAULT_INTERVALS,
	earChords: DEFAULT_QUALITIES,
	earDirection: 'up',
	earGap: 0.75,
	earAutoAdvance: true,
}

const listeners = new Set<() => void>()
let settings: Settings = load()

/** A stored choice, or the first (the default) when it is not one of them.
 * A declaration, not a const: `settings = load()` runs above it. */
function oneOf<T extends string>(value: unknown, options: T[]): T {
	return options.includes(value as T) ? (value as T) : options[0]
}

function load(): Settings {
	try {
		const stored = localStorage.getItem(STORAGE_KEY)
		const merged: Settings = stored ? { ...defaults, ...JSON.parse(stored) } : { ...defaults }
		// Stored values can be stale or hand-edited: keep the tuner's and the
		// ear trainer's inputs valid (unknown ids dropped, nothing left = defaults).
		return {
			...merged,
			a4: clampA4(merged.a4),
			tuning: tuningById(merged.tuning).id,
			trainerExercise: ['notes', 'intervals', 'chords'].includes(merged.trainerExercise) ? merged.trainerExercise : 'notes',
			earIntervals: pool('intervals', Array.isArray(merged.earIntervals) ? merged.earIntervals : []),
			earChords: pool('chords', Array.isArray(merged.earChords) ? merged.earChords : []),
			chordsMode: oneOf(merged.chordsMode, ['listen', 'library', 'identify']),
			chordLabels: oneOf(merged.chordLabels, ['degrees', 'notes', 'fingers', 'none']),
			chordPlay: oneOf(merged.chordPlay, ['strum', 'arpeggio']),
		}
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
