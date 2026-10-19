// Extensions so `npm run check:settings` (plain Node) can import this too.
import { possibleFrequencies, possibleFrequenciesWithoutAccidentals, type NoteInfo } from './notes.ts'
import { clampA4, tuningById } from './tuning.ts'
import { DEFAULT_INTERVALS, DEFAULT_QUALITIES, pool } from './ear.ts'
import * as Changes from './changes.ts'

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
	/** Scales harmony: chords of the scale as triads or sevenths. */
	chordView: 'triads' | 'sevenths'
	/** Progression playback, 60–140 BPM (one bar per chord). */
	progressionBpm: number
	/** Start a progression over when it ends. */
	progressionLoop: boolean

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
	trainerExercise: 'notes' | 'intervals' | 'chords' | 'changes'
	/** Interval ids (ts/ear.ts INTERVALS) and chord quality ids (QUALITIES) asked. */
	earIntervals: string[]
	earChords: string[]
	/** How the two notes of an interval are played; mixed picks one per question. */
	earDirection: 'up' | 'down' | 'harmonic' | 'mixed'
	/** Seconds between the two notes of a melodic interval. */
	earGap: number
	/** Intervals: answer by singing or playing the second note (needs the mic; off by default). */
	earSing: boolean
	/** Move on by itself shortly after a right answer. */
	earAutoAdvance: boolean

	/* Trainer: chord changes (ts/changes.ts) */
	/** The chords changed between, in order: 2–4 of Changes.CHANGE_CHORDS (fewer only mid-selection). */
	changesChords: string[]
	/** One-minute changes (count them) or in time with the metronome. */
	changesMode: 'minute' | 'time'
	/** One-minute session length, s: 30, 60 or 120. */
	changesDuration: number
	/** In time: tempo 40–160 BPM and beats per chord 1, 2 or 4. */
	changesBpm: number
	changesBeats: number
	/** In time: +5 BPM after two clean passes. */
	changesSpeedUp: boolean
	/** 3-2-1 before a one-minute session, a bar of clicks before an in-time one. */
	changesCountIn: boolean
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
	chordView: 'triads',
	progressionBpm: 80,
	progressionLoop: false,
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
	earSing: false,
	earAutoAdvance: true,

	/* Trainer: chord changes */
	changesChords: Changes.DEFAULT_SEQUENCE,
	changesMode: 'minute',
	changesDuration: 60,
	changesBpm: 60,
	changesBeats: 4,
	changesSpeedUp: false,
	changesCountIn: true,
}

const listeners = new Set<() => void>()
let settings: Settings = load()

/** A stored choice, or the first (the default) when it is not one of them.
 * Declarations, not consts: `settings = load()` runs above them. */
function oneOf<T extends string | number>(value: unknown, options: T[]): T {
	return options.includes(value as T) ? (value as T) : options[0]
}

/** A finite number within min…max (rounded when `whole`), else `fallback`. */
function clamp(value: unknown, min: number, max: number, fallback: number, whole = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
	return Math.min(max, Math.max(min, whole ? Math.round(value) : value))
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Stored values can be stale, from an older version or hand-edited: every key
 * is rebuilt from the defaults and validated (enums by oneOf, default first;
 * numbers clamped), so an unknown or old key is dropped and a corrupt value
 * falls back instead of reaching a view. Exported for `npm run check:settings`.
 */
export function load(): Settings {
	let s: Record<string, unknown> = {}
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) s = parsed as Record<string, unknown>
	} catch {
		// Unavailable storage (private mode) or broken JSON: defaults.
	}
	const d = defaults
	const accents = Array.isArray(s.metroAccents) ? s.metroAccents : []
	return {
		includeAccidentals: bool(s.includeAccidentals, d.includeAccidentals),
		matchAnyOctave: bool(s.matchAnyOctave, d.matchAnyOctave),
		lightStaff: bool(s.lightStaff, d.lightStaff),
		disabledNotes: strings(s.disabledNotes),
		fretboardTheme: oneOf(s.fretboardTheme, ['auto', 'light', 'dark']),
		fretboardVertical: bool(s.fretboardVertical, d.fretboardVertical),
		scaleLabels: oneOf(s.scaleLabels, ['notes', 'intervals', 'none']),
		// Degrees 1–7, once each. An empty list is a choice (nothing coloured), not corruption.
		scaleDegrees: Array.isArray(s.scaleDegrees)
			? [...new Set(s.scaleDegrees.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 7))].sort()
			: d.scaleDegrees,
		fretSize: clamp(s.fretSize, 0.5, 1.5, d.fretSize),
		chordView: oneOf(s.chordView, ['triads', 'sevenths']),
		progressionBpm: clamp(s.progressionBpm, 60, 140, d.progressionBpm, true),
		progressionLoop: bool(s.progressionLoop, d.progressionLoop),

		tuning: tuningById(typeof s.tuning === 'string' ? s.tuning : d.tuning).id,
		tunerMode: oneOf(s.tunerMode, ['guitar', 'chromatic']),
		a4: clampA4(typeof s.a4 === 'number' ? s.a4 : d.a4),
		tolerance: oneOf(s.tolerance, [5, 2, 10]),
		toneVolume: clamp(s.toneVolume, 0, 1, d.toneVolume),

		metroBpm: clamp(s.metroBpm, 30, 300, d.metroBpm, true),
		metroBeats: clamp(s.metroBeats, 1, 12, d.metroBeats, true),
		metroUnit: oneOf(s.metroUnit, [4, 8]),
		// Always 12 slots of 0 / 1 / 2; a missing or broken slot takes the default's.
		metroAccents: d.metroAccents.map((fallback, i) => oneOf(accents[i], [fallback, 0, 1, 2])),
		metroSubdivision: clamp(s.metroSubdivision, 1, 4, d.metroSubdivision, true),
		metroSound: oneOf(s.metroSound, ['click', 'wood', 'beep']),
		metroVolume: clamp(s.metroVolume, 0, 1, d.metroVolume),
		metroFlash: bool(s.metroFlash, d.metroFlash),
		metroTrainerOn: bool(s.metroTrainerOn, d.metroTrainerOn),
		// The ranges of the steppers in ts/views/metronome.ts.
		metroTrainerStep: clamp(s.metroTrainerStep, 1, 20, d.metroTrainerStep, true),
		metroTrainerBars: clamp(s.metroTrainerBars, 1, 16, d.metroTrainerBars, true),
		metroTrainerTarget: clamp(s.metroTrainerTarget, 30, 300, d.metroTrainerTarget, true),

		chordsMode: oneOf(s.chordsMode, ['listen', 'library', 'identify']),
		chordLabels: oneOf(s.chordLabels, ['degrees', 'notes', 'fingers', 'none']),
		chordPlay: oneOf(s.chordPlay, ['strum', 'arpeggio']),

		leftHanded: bool(s.leftHanded, d.leftHanded),

		trainerExercise: oneOf(s.trainerExercise, ['notes', 'intervals', 'chords', 'changes']),
		// Unknown ids dropped, nothing left = defaults.
		earIntervals: pool('intervals', strings(s.earIntervals)),
		earChords: pool('chords', strings(s.earChords)),
		earDirection: oneOf(s.earDirection, ['up', 'down', 'harmonic', 'mixed']),
		// The Note gap select's three values (Normal, Fast, Slow).
		earGap: oneOf(s.earGap, [0.75, 0.45, 1.1]),
		earSing: bool(s.earSing, d.earSing),
		earAutoAdvance: bool(s.earAutoAdvance, d.earAutoAdvance),

		changesChords: Changes.validSequence(s.changesChords),
		changesMode: oneOf(s.changesMode, ['minute', 'time']),
		changesDuration: oneOf(s.changesDuration, [d.changesDuration, ...Changes.DURATIONS]),
		changesBpm: clamp(s.changesBpm, Changes.MIN_BPM, Changes.MAX_BPM, d.changesBpm, true),
		changesBeats: oneOf(s.changesBeats, [d.changesBeats, ...Changes.BEATS_PER_CHORD]),
		changesSpeedUp: bool(s.changesSpeedUp, d.changesSpeedUp),
		changesCountIn: bool(s.changesCountIn, d.changesCountIn),
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
