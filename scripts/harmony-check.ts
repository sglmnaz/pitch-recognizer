// Self-check for ts/harmony.ts: scale families, chord sources, progressions
// spelled in every key, the circle of fifths and scales-for-a-chord. Run with
// `npm run check:harmony`.
import { chordsOfScale } from '../ts/chord-theory.ts'
import {
	chordSource,
	CIRCLE,
	circleIndex,
	familyOf,
	keyName,
	keyOf,
	parseNumeral,
	PROGRESSIONS,
	progressionsFor,
	resolveProgression,
	scalesForChord,
	signatureName,
} from '../ts/harmony.ts'
import { pitchClassesOf, pitchClassOf, SCALE_TYPES, scaleTitle, semitonesOf } from '../ts/scales.ts'
import { check, finish } from './check.ts'

const scale = (name: string) => SCALE_TYPES.find((t) => t.name === name)!
const mod12 = (n: number) => ((n % 12) + 12) % 12

/* Families and chord sources --------------------------------------------- */
const FAMILIES: [string, string | null][] = [
	['Major', 'major'],
	['Mixolydian', 'major'],
	['Lydian', 'major'],
	['Major pentatonic', 'major'],
	['Natural minor', 'minor'],
	['Dorian', 'minor'],
	['Harmonic minor', 'minor'],
	['Minor pentatonic', 'minor'],
	['Blues', 'minor'],
	['Locrian', null],
	['Whole tone', null],
	['Diminished (whole-half)', null],
	['Chromatic', null],
]
for (const [name, family] of FAMILIES) check(`family of ${name}`, familyOf(scale(name)) === family, String(familyOf(scale(name))))

check('minor pentatonic chords come from natural minor', chordSource(scale('Minor pentatonic'))?.name === 'Natural minor')
check('blues chords come from natural minor', chordSource(scale('Blues'))?.name === 'Natural minor')
check('major pentatonic chords come from major', chordSource(scale('Major pentatonic'))?.name === 'Major')
check('whole tone has no chord source', chordSource(scale('Whole tone')) === null)
// Every chord source must have nameable diatonic chords in every key, or the
// Chords pane would show nothing for it.
const sourceless = SCALE_TYPES.flatMap((t) => {
	const source = chordSource(t)
	if (!source) return []
	return Array.from({ length: 12 }, (_, pc) => pc)
		.filter((pc) => chordsOfScale(pc, source).length !== 7)
		.map((pc) => `${pc} ${t.name}`)
})
check('every chord source has 7 diatonic chords in every key', sourceless.length === 0, sourceless.join(', '))

/* Numerals ---------------------------------------------------------------- */
const NUMERALS: [string, string, string][] = [
	['I', '1', ''],
	['vi', '6', 'm'],
	['ii7', '2', 'm7'],
	['V7', '5', '7'],
	['Imaj7', '1', 'maj7'],
	['ii°', '2', 'dim'],
	['bVII', 'b7', ''],
	['viiø7', '7', 'm7b5'],
]
for (const [numeral, degree, symbol] of NUMERALS) {
	const parsed = parseNumeral(numeral)
	check(`parse ${numeral}`, parsed.degree === degree && parsed.type.symbol === symbol, `${parsed.degree} ${parsed.type.symbol}`)
}
let threw = false
try {
	parseNumeral('IX')
} catch {
	threw = true
}
check('unknown numeral throws', threw)

/* Progressions ------------------------------------------------------------ */
const symbols = (name: string, root: string) =>
	resolveProgression(PROGRESSIONS.find((p) => p.name === name)!, pitchClassOf(root))
		.map((c) => c.symbol)
		.join(' ')
const RESOLVED: [string, string, string][] = [
	['Pop', 'C', 'C G Am F'],
	['Three-chord', 'F', 'F Bb C F'], // Bb, not A#
	['Jazz ii–V–I', 'Bb', 'Cm7 F7 Bbmaj7'],
	['Doo-wop', 'G', 'G Em C D'],
	['Andalusian', 'A', 'Am G F E'],
	['Minor pop', 'E', 'Em C G D'],
	['Minor ii–V–i', 'D', 'Edim A Dm'],
	['Minor three-chord', 'C', 'Cm Fm Gm Cm'],
	['12-bar blues', 'E', 'E7 E7 E7 E7 A7 A7 E7 E7 B7 A7 E7 B7'],
	['12-bar blues', 'Db', 'Db7 Db7 Db7 Db7 Gb7 Gb7 Db7 Db7 Ab7 Gb7 Db7 Ab7'], // Gb7, not F#7
]
for (const [name, root, expected] of RESOLVED) {
	const got = symbols(name, root)
	check(`${name} in ${root}`, got === expected, got)
}
check(
	'Andalusian E chord is E G# B',
	resolveProgression(PROGRESSIONS.find((p) => p.name === 'Andalusian')!, 9)
		.at(-1)!
		.notes.join(' ') === 'E G# B'
)

// Every numeral in every key lands on the pitch class its degree says (the
// resolver takes the key's own note, so a chromatic numeral would fail here).
const offKey: string[] = []
for (const p of PROGRESSIONS)
	for (let pc = 0; pc < 12; pc++)
		resolveProgression(p, pc).forEach((chord) => {
			const want = mod12(pc + semitonesOf({ name: '', formula: parseNumeral(chord.numeral).degree })[0])
			if (chord.rootPc !== want || chord.notes.length !== semitonesOf(chord.type).length) offKey.push(`${p.name} ${pc} ${chord.numeral}`)
		})
check('every progression resolves on its degrees in all 12 keys', offKey.length === 0, offKey.slice(0, 5).join(', '))

const names = (scaleName: string) => progressionsFor(scale(scaleName)).map((p) => p.name)
check('major gets the major progressions', names('Major').includes('Pop') && !names('Major').includes('Andalusian'))
check('natural minor gets the minor progressions', names('Natural minor').includes('Andalusian') && !names('Natural minor').includes('Pop'))
check('blues scale gets the 12-bar blues', names('Blues').includes('12-bar blues'))
check('whole tone gets none', names('Whole tone').length === 0)
check('Dorian gets no minor progressions', names('Dorian').length === 0, names('Dorian').join(', '))
check('harmonic minor gets the minor progressions', names('Harmonic minor').includes('Andalusian'))
check('Mixolydian gets only the 12-bar blues', names('Mixolydian').join(', ') === '12-bar blues', names('Mixolydian').join(', '))

/* Circle of fifths -------------------------------------------------------- */
check('12 keys', CIRCLE.length === 12)
check(
	'a fifth apart',
	CIRCLE.every((k, i) => k.majorPc === mod12(i * 7))
)
check(
	'relative minors a minor third below',
	CIRCLE.every((k) => k.minorPc === mod12(k.majorPc - 3))
)
check('C has no accidentals', CIRCLE[0].accidentals === 0)
check('A major has 3 sharps', CIRCLE.find((k) => k.major === 'A')!.accidentals === 3)
check('Eb major has 3 flats', CIRCLE.find((k) => k.major === 'Eb')!.accidentals === -3)
check('F# is also Gb', CIRCLE[6].major === 'F#' && CIRCLE[6].majorAlt === 'Gb' && CIRCLE[6].minorAlt === 'Eb')
check('G major index', circleIndex(pitchClassOf('G'), 'major') === 1)
check('E minor sits with G', circleIndex(pitchClassOf('E'), 'minor') === 1)
check('D minor sits with F', circleIndex(pitchClassOf('D'), 'minor') === 11)
// Modes sit on the circle where their parent major does.
const at = (root: string, name: string) => {
	const key = keyOf(pitchClassOf(root), scale(name))
	return key && circleIndex(key.pc, key.family)
}
for (const [root, name] of [
	['D', 'Dorian'],
	['E', 'Phrygian'],
	['F', 'Lydian'],
	['G', 'Mixolydian'],
	['B', 'Locrian'],
	['C', 'Major'],
	['A', 'Natural minor'],
	['A', 'Harmonic minor'],
])
	check(`${root} ${name} sits at C / Am`, at(root, name) === 0, String(at(root, name)))
check('A Dorian sits at G', at('A', 'Dorian') === 1)
check('whole tone has no key', keyOf(0, scale('Whole tone')) === null)
check(
	'key name of D Dorian',
	keyName(pitchClassOf('D'), scale('Dorian')) === 'D Dorian · parent C major, no sharps or flats',
	keyName(pitchClassOf('D'), scale('Dorian'))
)
check('key name of E minor', keyName(pitchClassOf('E'), scale('Natural minor')) === 'E minor, 1 sharp', keyName(pitchClassOf('E'), scale('Natural minor')))
check(
	'key name of Eb Mixolydian',
	keyName(pitchClassOf('Eb'), scale('Mixolydian')) === 'Eb Mixolydian · parent Ab major, 4 flats',
	keyName(pitchClassOf('Eb'), scale('Mixolydian'))
)
check('signature names', [signatureName(0), signatureName(1), signatureName(-3)].join(', ') === 'no sharps or flats, 1 sharp, 3 flats')

/* Scales for a chord ------------------------------------------------------ */
const fits = (...notes: string[]) => scalesForChord(new Set(notes.map(pitchClassOf)), pitchClassOf(notes[0])).map((m) => scaleTitle(m.root, m.type))
const cMajor = fits('C', 'E', 'G')
check('C major fits C major first', cMajor[0] === 'C Major · Ionian', cMajor.join(', '))
check(
	'C major fits its modes, then G, F, the minors',
	cMajor.slice(0, 7).join(', ') ===
		'C Major · Ionian, C Mixolydian, C Lydian, G Major · Ionian, F Major · Ionian, E Natural minor · Aeolian, D Natural minor · Aeolian',
	cMajor.join(', ')
)
check('only seven-note scales', !cMajor.some((t) => t.includes('pentatonic')))
check('at most 8', cMajor.length === 8)
const e7 = fits('E', 'G#', 'B', 'D')
check(
	'E7 fits A harmonic minor',
	e7.some((t) => t === 'A Harmonic minor'),
	e7.join(', ')
)
const e7Pcs = new Set(['E', 'G#', 'B', 'D'].map(pitchClassOf))
const holds = scalesForChord(e7Pcs, pitchClassOf('E')).every((m) => [...e7Pcs].every((pc) => pitchClassesOf(m.rootPc, m.type).has(pc)))
check('every fit holds every chord tone', holds)

finish('All harmony checks passed')
