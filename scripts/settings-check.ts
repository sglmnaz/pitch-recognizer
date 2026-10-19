// Self-check for the settings loader: corrupt, stale or hand-edited stored
// values must come back valid. Run with `npm run check:settings`.
// localStorage is stubbed before the store is imported (it loads on import).
import { check, finish } from './check.ts'
let stored: string | null = null
;(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: () => stored,
	setItem: () => {},
}
const Settings = await import('../ts/settings.ts')

function loadFrom(value: unknown) {
	stored = typeof value === 'string' ? value : JSON.stringify(value)
	return Settings.load()
}

const defaults = loadFrom(null)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

check('nothing stored = defaults', same(Settings.get(), defaults))
check('broken JSON = defaults', same(loadFrom('{"metroBpm": 12'), defaults))
check('a JSON array or number = defaults', same(loadFrom([1, 2]), defaults) && same(loadFrom(42), defaults))
check('unknown and old keys are dropped', !('oldKey' in loadFrom({ oldKey: 1, theme: 'dark' })) && !('theme' in loadFrom({ theme: 'dark' })))

const corrupt = loadFrom({
	tunerMode: 'bass',
	fretboardTheme: 7,
	scaleLabels: null,
	earDirection: 'sideways',
	tolerance: 3,
	toneVolume: 4,
	fretSize: -2,
	earGap: '0.45',
	metroBpm: 999,
	metroBeats: 0,
	metroUnit: 16,
	metroSubdivision: 2.6,
	metroSound: 'cowbell',
	metroVolume: Number.NaN,
	metroAccents: [5, 0, 'x', 2],
	scaleDegrees: [3, 3, 9, 'b', 1],
	includeAccidentals: 'yes',
	a4: 1000,
	tuning: 'nope',
	progressionBpm: '90',
	changesBpm: 500,
	changesBeats: 3,
	changesDuration: 45,
	trainerExercise: 'rhythm',
	chordsMode: 'piano',
	earIntervals: ['P5', 'zz', 3],
	disabledNotes: ['C4', 5],
})
check(
	'bad enums fall back to the default',
	corrupt.tunerMode === 'guitar' &&
		corrupt.fretboardTheme === 'auto' &&
		corrupt.scaleLabels === 'notes' &&
		corrupt.earDirection === 'up' &&
		corrupt.metroSound === 'click' &&
		corrupt.trainerExercise === 'notes' &&
		corrupt.chordsMode === 'listen'
)
check('tolerance outside {2, 5, 10} = 5', corrupt.tolerance === 5)
check(
	'volumes and fret size are clamped',
	corrupt.toneVolume === 1 && corrupt.fretSize === 0.5 && corrupt.metroVolume === defaults.metroVolume,
	`${corrupt.toneVolume} ${corrupt.fretSize} ${corrupt.metroVolume}`
)
check('earGap must be one of the select values (a string is not)', corrupt.earGap === 0.75)
check(
	'metronome numbers clamped and whole',
	corrupt.metroBpm === 300 && corrupt.metroBeats === 1 && corrupt.metroUnit === 4 && corrupt.metroSubdivision === 3,
	`${corrupt.metroBpm} ${corrupt.metroBeats} ${corrupt.metroUnit} ${corrupt.metroSubdivision}`
)
check(
	'metroAccents: 12 slots of 0–2, broken slots take the default',
	same(corrupt.metroAccents, [2, 0, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1]),
	corrupt.metroAccents.join('')
)
check('scaleDegrees: 1–7, once each', same(corrupt.scaleDegrees, [1, 3]), corrupt.scaleDegrees.join(' '))
check('scaleDegrees: an empty choice is kept', same(loadFrom({ scaleDegrees: [] }).scaleDegrees, []))
check('booleans must be booleans', corrupt.includeAccidentals === false)
check('A4 clamped, unknown tuning = Standard', corrupt.a4 === 466 && corrupt.tuning === 'standard', `${corrupt.a4} ${corrupt.tuning}`)
check('progressionBpm as a string = default', corrupt.progressionBpm === defaults.progressionBpm)
check(
	'changes: bpm clamped, beats and duration from their lists',
	corrupt.changesBpm === 160 && corrupt.changesBeats === defaults.changesBeats && corrupt.changesDuration === defaults.changesDuration
)
check('ear ids: unknown dropped', same(corrupt.earIntervals, ['P5']))
check('disabledNotes: strings only', same(corrupt.disabledNotes, ['C4']))

const good = loadFrom({
	tunerMode: 'chromatic',
	tolerance: 2,
	metroBpm: 72,
	metroUnit: 8,
	earGap: 1.1,
	fretSize: 1.25,
	metroAccents: [2, 0, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1],
})
check(
	'valid values are kept',
	good.tunerMode === 'chromatic' &&
		good.tolerance === 2 &&
		good.metroBpm === 72 &&
		good.metroUnit === 8 &&
		good.earGap === 1.1 &&
		good.fretSize === 1.25 &&
		good.metroAccents[1] === 0
)

finish('all settings checks passed')
