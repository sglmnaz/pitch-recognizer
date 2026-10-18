// Self-check for ts/scales.ts: spellings and identifier results. Run with
// `npm run check:scales`.
import {
	degreeMap,
	degreeNumber,
	degreesOf,
	identifyScales,
	pitchClassOf,
	positionRun,
	positionWindows,
	SCALE_TYPES,
	scaleRun,
	spellScale,
} from '../ts/scales.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures++
}

const type = (name: string) => SCALE_TYPES.find((t) => t.name === name)!
const spelled = (root: string, name: string) => {
	const s = spellScale(root, type(name))
	return `${s.root}: ${s.notes.join(' ')}`
}

const SPELLINGS: [string, string, string][] = [
	['C', 'Major', 'C: C D E F G A B'],
	['F', 'Major', 'F: F G A Bb C D E'],
	['A', 'Natural minor', 'A: A B C D E F G'],
	['Ab', 'Natural minor', 'G#: G# A# B C# D# E F#'], // not Ab Bb Cb Db Eb Fb Gb
	['A', 'Harmonic minor', 'A: A B C D E F G#'],
	['A', 'Minor pentatonic', 'A: A C D E G'],
	['E', 'Blues', 'E: E G A Bb B D'],
	['D', 'Dorian', 'D: D E F G A B C'],
	['C', 'Whole tone', 'C: C D E F# G# Bb'],
	['F#', 'Major', 'F#: F# G# A# B C# D# E#'],
]
for (const [root, name, expected] of SPELLINGS) {
	const got = spelled(root, name)
	check(`${root} ${name}`, got === expected, got)
}

const pcs = (...names: string[]) => new Set(names.map(pitchClassOf))
const titles = (matches: ReturnType<typeof identifyScales>) => matches.map((m) => `${m.root} ${m.type.name}`)

// C E G B, played from C: C major first (exact 7-note fit, root in the bass).
const cmaj7 = titles(identifyScales(pcs('C', 'E', 'G', 'B'), pitchClassOf('C')))
check('C E G B includes C Major, G Major, E Natural minor', ['C Major', 'G Major', 'E Natural minor'].every((t) => cmaj7.includes(t)))
check('C E G B ranks C Major above other 7-note scales', cmaj7.indexOf('C Major') < cmaj7.indexOf('G Major'), cmaj7.slice(0, 5).join(', '))
check('C E G B excludes C Natural minor', !cmaj7.includes('C Natural minor'))

// A C E G from A: A minor pentatonic is the best fit (one extra note: D).
const am7 = titles(identifyScales(pcs('A', 'C', 'E', 'G'), pitchClassOf('A')))
check('A C E G includes C Major and A Minor pentatonic', am7.includes('C Major') && am7.includes('A Minor pentatonic'))
check('A C E G puts A Minor pentatonic first', am7[0] === 'A Minor pentatonic', am7.slice(0, 5).join(', '))

// A full C major set: exact matches only at the top, Chromatic last.
const all = identifyScales(pcs('C', 'D', 'E', 'F', 'G', 'A', 'B'), pitchClassOf('C'))
check('Full C major set leads with C Major (0 extra)', all[0].root === 'C' && all[0].type.name === 'Major' && all[0].extra === 0)
check('Chromatic is last', all[all.length - 1].type.name === 'Chromatic')
check('Nothing marked, no results', identifyScales(new Set()).length === 0)

// Interval labels use the scale's own spelling.
const aMinor = degreeMap(pitchClassOf('A'), type('Natural minor'))
check('A minor degrees: C is b3, G is b7', aMinor.get(pitchClassOf('C')) === 'b3' && aMinor.get(pitchClassOf('G')) === 'b7')
const eBlues = degreeMap(pitchClassOf('E'), type('Blues'))
check('E blues: Bb is b5', eBlues.get(pitchClassOf('Bb')) === 'b5')

// Degree chips: b3 and 3 both belong to chip 3, b5 to chip 5.
check('degreeNumber b3 → 3, #4 → 4, 1 → 1', degreeNumber('b3') === 3 && degreeNumber('#4') === 4 && degreeNumber('1') === 1)
const highlighted = degreesOf(type('Chromatic')).filter((d) => [1, 3, 5].includes(degreeNumber(d)))
check('Chromatic, chips 1 3 5 → 1 b3 3 b5 5', highlighted.join(' ') === '1 b3 3 b5 5', highlighted.join(' '))

// Positions: the five classic A minor pentatonic boxes.
const boxes = positionWindows(pitchClassOf('A'), type('Minor pentatonic')).map(([lo, hi]) => `${lo}-${hi}`)
check('A minor pentatonic boxes', boxes.join(' ') === '4-8 7-11 9-13 11-15 2-6', boxes.join(' '))
const eBoxes = positionWindows(pitchClassOf('E'), type('Major')).map(([lo, hi]) => `${lo}-${hi}`)
check('E major box 1 is the open position', eBoxes[0] === '0-3', eBoxes.join(' '))

// Playback runs.
const box1 = positionRun(pitchClassOf('A'), type('Minor pentatonic'), [4, 8])
check('A minor pentatonic box 1 plays 12 notes from A2', box1.length === 12 && box1[0] === 45 && box1[11] === 72, box1.join(' '))
check('C major run: C3 up to C4', scaleRun(pitchClassOf('C'), type('Major')).join(' ') === '48 50 52 53 55 57 59 60')

if (failures) {
	console.error(`\n${failures} check(s) failed`)
	process.exit(1)
}
console.log('\nAll scale checks passed')
