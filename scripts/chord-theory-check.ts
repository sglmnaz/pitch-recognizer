// Self-check for ts/chord-theory.ts and ts/chord-shapes.ts: spelling, the
// identifier, diatonic chords and the voicing generator against chord-book
// shapes. Run with `npm run check:chord-theory` (`-- --verbose` lists the
// generated shapes).
import { CHORD_TYPES, chordsOfScale, chordType, identifyChords, spellChord } from '../ts/chord-theory.ts'
import { chordShapes, shapeString, type Voicing } from '../ts/chord-shapes.ts'
import { pitchClassOf, SCALE_TYPES } from '../ts/scales.ts'

const verbose = process.argv.includes('--verbose')
let failures = 0
function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures++
}

const type = (symbol: string) => chordType(symbol)!
const scale = (name: string) => SCALE_TYPES.find((t) => t.name === name)!
const pcs = (...names: string[]) => new Set(names.map(pitchClassOf))

/* Spelling --------------------------------------------------------------- */
check('Every chord type has a unique symbol', new Set(CHORD_TYPES.map((t) => t.symbol)).size === CHORD_TYPES.length)
const SPELLINGS: [string, string, string][] = [
	['C', '', 'C: C E G'],
	['C', 'm7', 'Cm7: C Eb G Bb'],
	['C', '13', 'C13: C E G Bb D A'],
	['C', '11', 'C11: C E G Bb D F'],
	['C', 'dim7', 'Cdim7: C Eb Gb Bbb'],
	['C', 'aug', 'Caug: C E G#'],
	['F', '7', 'F7: F A C Eb'],
	['Bb', 'maj9', 'Bbmaj9: Bb D F A C'],
	['C#', '', 'Db: Db F Ab'], // fewer accidentals than C# E# G#
	['G#', 'm', 'G#m: G# B D#'],
	['E', 'm7b5', 'Em7b5: E G Bb D'],
]
for (const [root, symbol, expected] of SPELLINGS) {
	const s = spellChord(root, type(symbol))
	const got = `${s.symbol}: ${s.notes.join(' ')}`
	check(`spell ${root}${symbol}`, got === expected, got)
}
check('C9 degrees', spellChord('C', type('9')).degrees.join(' ') === '1 3 5 b7 9')

/* Identifier ------------------------------------------------------------- */
const top = (set: Set<number>, bass?: string) => identifyChords(set, bass === undefined ? undefined : pitchClassOf(bass)).map((m) => m.symbol)
const IDENTIFY: [string[], string | undefined, string][] = [
	[['C', 'E', 'G'], 'C', 'C'],
	[['A', 'C', 'E'], 'A', 'Am'],
	[['G', 'B', 'D', 'F'], 'G', 'G7'],
	[['C', 'E', 'G', 'B'], 'C', 'Cmaj7'],
	[['C', 'E', 'G', 'A'], 'C', 'C6'], // same notes as Am7: the bass decides
	[['C', 'E', 'G', 'A'], 'A', 'Am7'],
	[['C', 'E', 'G'], 'E', 'C/E'],
	[['D', 'E', 'A'], 'D', 'Dsus2'],
	[['B', 'D', 'F', 'A'], 'B', 'Bm7b5'],
	[['C', 'G'], 'C', 'C5'],
	[['C', 'E', 'Bb'], 'C', 'C7'], // 5th dropped
	[['E', 'G#', 'B', 'D', 'F#'], 'E', 'E9'],
]
for (const [notes, bass, expected] of IDENTIFY) {
	const got = top(pcs(...notes), bass)
	check(`identify ${notes.join(' ')}${bass ? ` / ${bass}` : ''} → ${expected}`, got[0] === expected, got.slice(0, 4).join(', '))
}
check('C E G (no bass) → C first', top(pcs('C', 'E', 'G'))[0] === 'C')
check('A single note names no chord', identifyChords(pcs('C')).length === 0)
const cExact = identifyChords(pcs('C', 'E', 'G'), pitchClassOf('C'))[0]
check('C E G is exact', cExact.missing === 0 && cExact.extra === 0)

/* Diatonic chords -------------------------------------------------------- */
const numerals = (root: string, name: string, kind: 'triad' | 'seventh') =>
	chordsOfScale(pitchClassOf(root), scale(name))
		.map((c) => c[kind].numeral)
		.join(' ')
const symbols = (root: string, name: string, kind: 'triad' | 'seventh') =>
	chordsOfScale(pitchClassOf(root), scale(name))
		.map((c) => c[kind].symbol)
		.join(' ')
check('C major triads', symbols('C', 'Major', 'triad') === 'C Dm Em F G Am Bdim', symbols('C', 'Major', 'triad'))
check('C major numerals', numerals('C', 'Major', 'triad') === 'I ii iii IV V vi vii°', numerals('C', 'Major', 'triad'))
check('C major sevenths', symbols('C', 'Major', 'seventh') === 'Cmaj7 Dm7 Em7 Fmaj7 G7 Am7 Bm7b5', symbols('C', 'Major', 'seventh'))
check('C major seventh numerals', numerals('C', 'Major', 'seventh') === 'Imaj7 ii7 iii7 IVmaj7 V7 vi7 viiø7', numerals('C', 'Major', 'seventh'))
check('F major IV is Bb', symbols('F', 'Major', 'triad').split(' ')[3] === 'Bb', symbols('F', 'Major', 'triad'))
check('A minor numerals', numerals('A', 'Natural minor', 'triad') === 'i ii° bIII iv v bVI bVII', numerals('A', 'Natural minor', 'triad'))
check('A minor triads', symbols('A', 'Natural minor', 'triad') === 'Am Bdim C Dm Em F G', symbols('A', 'Natural minor', 'triad'))
check(
	'A harmonic minor sevenths',
	symbols('A', 'Harmonic minor', 'seventh') === 'AmMaj7 Bm7b5 Cmaj7#5 Dm7 E7 Fmaj7 G#dim7',
	symbols('A', 'Harmonic minor', 'seventh')
)
check('A harmonic minor V and vii°7', numerals('A', 'Harmonic minor', 'seventh').split(' ')[4] === 'V7' && numerals('A', 'Harmonic minor', 'seventh').endsWith('vii°7'))
check('D Dorian numerals', numerals('D', 'Dorian', 'triad') === 'i ii bIII IV v vi° bVII', numerals('D', 'Dorian', 'triad'))
check('G Mixolydian V is minor', numerals('G', 'Mixolydian', 'triad').split(' ')[4] === 'v')
check('Pentatonic has no diatonic chords', chordsOfScale(0, scale('Minor pentatonic')).length === 0)

/* Voicings --------------------------------------------------------------- */
// Chord-book open and barre shapes, low E first; each must be in the top 3.
const SHAPES: [string, string, string][] = [
	['C', '', 'x32010'],
	['G', '', '320003'],
	['D', '', 'xx0232'],
	['A', '', 'x02220'],
	['E', '', '022100'],
	['A', 'm', 'x02210'],
	['E', 'm', '022000'],
	['D', 'm', 'xx0231'],
	['F', '', '133211'],
	['B', 'm', 'x24432'],
	['E', '7', '020100'],
	['A', '7', 'x02020'],
	['D', '7', 'xx0212'],
	['C', '7', 'x32310'],
	['G', '7', '320001'],
	['C', 'maj7', 'x32000'],
	['A', 'm7', 'x02010'],
	['D', 'sus2', 'xx0230'],
	['A', 'sus4', 'x02230'],
]
const TOP = 3
const fingerString = (v: Voicing) => [...v.fingers].reverse().map((f, i) => (v.frets[v.frets.length - 1 - i] > 0 ? f : '-')).join('')
for (const [root, symbol, shape] of SHAPES) {
	const voicings = chordShapes(pitchClassOf(root), type(symbol), { limit: 8 })
	const rank = voicings.findIndex((v) => shapeString(v) === shape)
	if (verbose) console.log(`     ${root + symbol}: ${voicings.map((v) => `${shapeString(v)} ${fingerString(v)} ${v.score.toFixed(1)}`).join(' | ')}`)
	check(`${root}${symbol} ${shape} in the top ${TOP}`, rank >= 0 && rank < TOP, rank >= 0 ? `#${rank + 1}` : voicings.slice(0, 3).map(shapeString).join(' '))
}

const by = (root: string, symbol: string, shape: string) => chordShapes(pitchClassOf(root), type(symbol), { limit: 20 }).find((v) => shapeString(v) === shape)
const f = by('F', '', '133211')
check('F 133211: barre on fret 1 across all strings, fingers 134211', f?.barre?.fret === 1 && f.barre.from === 0 && f.barre.to === 5 && fingerString(f) === '134211', f ? fingerString(f) : 'missing')
const bm = by('B', 'm', 'x24432')
check('Bm x24432: barre on fret 2, fingers -13421', bm?.barre?.fret === 2 && fingerString(bm) === '-13421', bm ? fingerString(bm) : 'missing')
const c = by('C', '', 'x32010')
check('C x32010: fingers -32-1-, no barre', c?.barre === null && fingerString(c) === '-32-1-', c ? fingerString(c) : 'missing')
check('C major top shape has the root in the bass', !chordShapes(0, type(''))[0].inversion)
check('Inversions only when asked', chordShapes(0, type(''), { limit: 50 }).every((v) => !v.inversion) && chordShapes(0, type(''), { limit: 200, inversions: true }).some((v) => v.inversion))
const allFingers = CHORD_TYPES.flatMap((t) => chordShapes(0, t, { limit: 20 })).every((v) => new Set(v.fingers.filter((x) => x > 0)).size <= 4)
check('Every voicing uses at most 4 fingers', allFingers)
const spanOk = CHORD_TYPES.flatMap((t) => chordShapes(7, t, { limit: 20 })).every((v) => {
	const fretted = v.frets.filter((x) => x > 0)
	return fretted.length === 0 || Math.max(...fretted) - Math.min(...fretted) <= 3
})
check('Every voicing fits a 4-fret span', spanOk)
const c13 = chordShapes(0, type('13'))
check('C13 has a voicing (5th dropped)', c13.length > 0 && c13[0].omitted.includes('5'), c13.slice(0, 3).map(shapeString).join(' '))
// Drop D tuning: D on the low string, so D5 is the three open low strings.
const dropD = [64, 59, 55, 50, 45, 38]
const d5 = chordShapes(pitchClassOf('D'), type('5'), { tuning: dropD }).map(shapeString)
check('Drop D: D5 000xxx among the top shapes', d5.slice(0, 3).includes('000xxx'), d5.slice(0, 3).join(' '))

if (failures) {
	console.error(`\n${failures} check(s) failed`)
	process.exit(1)
}
console.log('\nAll chord theory checks passed')
