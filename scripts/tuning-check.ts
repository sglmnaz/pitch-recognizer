// Self-check for the tuner's pure logic: tuning tables, nearest-string
// selection and A4 calibration. Run with `npm run check:tunings`.
import { centsBetween, frequencyOfMidi, getClosestNote, midiOfFrequency } from '../ts/notes.ts'
import { A4_MAX, A4_MIN, clampA4, midiOfName, nearestString, STANDARD, TUNINGS, tuningById, tuningStrings } from '../ts/tuning.ts'
import { check, finish } from './check.ts'

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps

/* Tables ------------------------------------------------------------------- */
const NAMES: Record<string, string> = {
	standard: 'E A D G B E',
	'drop-d': 'D A D G B E',
	'half-down': 'Eb Ab Db Gb Bb Eb',
	'whole-down': 'D G C F A D',
	'drop-c': 'C G C F A D',
	dadgad: 'D A D G A D',
	'open-g': 'D G D G B D',
	'open-d': 'D A D F# A D',
	'open-e': 'E B E G# B E',
	'open-c': 'C G C G C E',
}
check('ten presets', TUNINGS.length === 10 && TUNINGS[0] === STANDARD)
for (const tuning of TUNINGS) {
	const strings = tuningStrings(tuning, 440)
	check(`${tuning.name}: ${NAMES[tuning.id]}`, strings.map((s) => s.name).join(' ') === NAMES[tuning.id])
	check(
		`${tuning.name}: six strings, low to high`,
		strings.length === 6 && strings.every((s, i) => i === 0 || s.midi > strings[i - 1].midi || s.midi === strings[i - 1].midi),
		strings.map((s) => s.midi).join(' ')
	)
}
check('unknown id falls back to Standard', tuningById('nope') === STANDARD)

const standard = tuningStrings(STANDARD, 440).map((s) => s.frequency.toFixed(2))
check('Standard at 440: 82.41 110.00 146.83 196.00 246.94 329.63', standard.join(' ') === '82.41 110.00 146.83 196.00 246.94 329.63', standard.join(' '))
check('midiOfName', midiOfName('E2') === 40 && midiOfName('A4') === 69 && midiOfName('Eb2') === 39 && midiOfName('F#3') === 54 && midiOfName('C-1') === 0)

/* A4 calibration ---------------------------------------------------------- */
check('A4 is A4', near(frequencyOfMidi(69), 440) && near(frequencyOfMidi(69, 432), 432) && near(frequencyOfMidi(69, 415), 415))
check('midiOfFrequency inverts frequencyOfMidi', near(midiOfFrequency(frequencyOfMidi(52, 442), 442), 52, 1e-9))
const low432 = tuningStrings(STANDARD, 432)[0].frequency
check('Standard low E at 432 = 80.91 Hz (82.41 x 432/440)', near(low432, 80.909, 0.01), low432.toFixed(3))

const at440 = getClosestNote(440)
check('getClosestNote default is 440-based', at440.note === 'A4' && near(at440.frequency, 440))
const at432 = getClosestNote(432, 432)
check('432 Hz is exactly A4 when A4 = 432', at432.note === 'A4' && near(centsBetween(432, at432.frequency), 0, 1e-9))
const stale = getClosestNote(432)
check('432 Hz against A4 = 440 is A4, -31.8 cents', stale.note === 'A4' && near(centsBetween(432, stale.frequency), -31.77, 0.05), centsBetween(432, stale.frequency).toFixed(2))
const b415 = getClosestNote(415, 415)
check('Baroque 415: 415 Hz is A4, 0 cents', b415.note === 'A4' && near(centsBetween(415, b415.frequency), 0, 1e-9))
const flat = getClosestNote(415)
check('415 Hz at A4 = 440 is G#4, -1.27 cents', flat.note === 'G#4/Ab4' && near(centsBetween(415, flat.frequency), -1.27, 0.05), centsBetween(415, flat.frequency).toFixed(2))
// The table's own frequencies still name themselves at 440.
const sameNames = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4', 'C5'].every((n) => {
	const f = frequencyOfMidi(midiOfName(n), 440)
	return getClosestNote(f).note.split('/')[0] === n
})
check('note names stable at 440', sameNames)
check('out-of-table frequencies clamp, not crash', getClosestNote(1).note === 'C0' && getClosestNote(1e6).note === 'C8')
check('clampA4', clampA4(300) === A4_MIN && clampA4(500) === A4_MAX && clampA4(432) === 432 && clampA4('x') === 440 && clampA4(NaN) === 440)

/* Nearest string ----------------------------------------------------------- */
const std = tuningStrings(STANDARD, 440)
const pick = (hz: number, strings = std) => nearestString(hz, strings)
check('exact A2 -> string 1, 0 cents', pick(110).index === 1 && near(pick(110).cents, 0, 1e-9))
check('slightly flat low E picks E2, negative cents', pick(81.5).index === 0 && pick(81.5).cents < 0)
check('slightly sharp B picks B3, positive cents', pick(250).index === 4 && pick(250).cents > 0)
check('E4 is the high string, not the low one', pick(329.63).index === 5)
// 123.5 Hz is B2: 200 cents above A, 300 below D3 → nearest string is A.
check('B2 sits nearer A2 than D3 (cents, not Hz)', pick(123.47).index === 1 && near(pick(123.47).cents, 200, 0.1), pick(123.47).cents.toFixed(1))
// Drop D: a low E (82.41) is two semitones sharp of the low D target.
const dropD = tuningStrings(tuningById('drop-d'), 440)
check('Drop D: a standard low E reads +200 cents on string 6', pick(82.41, dropD).index === 0 && near(pick(82.41, dropD).cents, 200, 0.2), pick(82.41, dropD).cents.toFixed(1))
check('Drop D: D2 (73.42) is in tune on string 6', pick(73.42, dropD).index === 0 && Math.abs(pick(73.42, dropD).cents) < 0.1)
// Duplicate pitch classes: Open C has C2 and C3; an octave error must not be hidden.
const openC = tuningStrings(tuningById('open-c'), 440)
check('Open C: 130.81 Hz is the C3 string, not C2', pick(130.81, openC).index === 2)
check('Calibrated strings follow A4: A2 at A4=432 is 108', near(tuningStrings(STANDARD, 432)[1].frequency, 108, 0.01))
check('tuning at A4=432 reads its own pitch as 0 cents', Math.abs(pick(tuningStrings(STANDARD, 432)[3].frequency, tuningStrings(STANDARD, 432)).cents) < 1e-9)

finish('all tuning checks passed')
