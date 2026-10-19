// Self-check for ts/music/ear.ts: tables, question generation, playback timing,
// sung answers, scoring. Run with `npm run check:ear`.
import {
	answer,
	CHORD_ROOT_HIGH,
	CHORD_ROOT_LOW,
	getSession,
	intervalOfAnswer,
	INTERVALS,
	makeQuestion,
	next,
	notesOf,
	playback,
	pool,
	QUALITIES,
	STRUM_S,
	weakest,
	type Question,
} from '../ts/music/ear.ts'
import { check, finish } from './check.ts'

// Deterministic generator (mulberry32) so a failure reproduces.
function rng(seed: number) {
	return () => {
		seed |= 0
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const E2 = 40
const A2 = 45
const C5 = 72
const E5 = 76
const pcs = (notes: number[]) => [...new Set(notes.map((n) => ((n % 12) + 12) % 12))].sort((a, b) => a - b).join(',')

// Tables.
check('12 intervals, m2..P8 in order', INTERVALS.map((i) => i.semitones).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12')
for (const q of QUALITIES) {
	check(`${q.id}: voicing has exactly the formula's pitch classes`, pcs(q.voicing) === pcs(q.formula), `${pcs(q.voicing)} vs ${pcs(q.formula)}`)
	check(`${q.id}: voicing rises, root in the bass`, q.voicing[0] === 0 && q.voicing.every((s, i) => i === 0 || s > q.voicing[i - 1]))
	check(
		`${q.id}: 4–6 strings, top within E5 from the highest root`,
		q.voicing.length >= 4 && q.voicing.length <= 6 && CHORD_ROOT_HIGH + q.voicing.at(-1)! <= E5
	)
}
check('chord roots start at E2', CHORD_ROOT_LOW === E2)

// Pool: unknown ids dropped, empty falls back to defaults.
check('pool keeps table order', pool('intervals', ['P5', 'm3', 'bogus']).join() === 'm3,P5')
check('empty pool falls back to defaults', pool('chords', []).join() === 'maj,m,7,maj7,m7')

// Generation: in range, no immediate repeats, direction honoured.
for (const direction of ['up', 'down', 'harmonic', 'mixed'] as const) {
	const random = rng(7)
	let previous: Question | null = null
	let ok = true
	let repeats = 0
	const dirs = new Set<string>()
	for (let i = 0; i < 500; i++) {
		const q = makeQuestion('intervals', ['m3', 'M3', 'P5'], direction, previous, random)
		const notes = notesOf(q)
		for (const id of ['m2', 'P8']) {
			const all = notesOf(q, id)
			if (Math.min(...all) < A2 || Math.max(...all) > C5) ok = false
		}
		if (direction !== 'mixed' && q.direction !== direction) ok = false
		if (q.direction === 'down' ? notes[1] >= notes[0] : notes[1] <= notes[0]) ok = false
		if (previous && (q.id === previous.id || q.root === previous.root)) repeats++
		dirs.add(q.direction)
		previous = q
	}
	check(`intervals ${direction}: every variant within A2–C5, right direction`, ok)
	check(`intervals ${direction}: no immediate repeat of answer or root`, repeats === 0, `${repeats} repeats`)
	if (direction === 'mixed') check('mixed uses all three directions', dirs.size === 3)
}

{
	const random = rng(3)
	let previous: Question | null = null
	let ok = true
	const seen = new Set<string>()
	for (let i = 0; i < 500; i++) {
		const q = makeQuestion('chords', ['maj', 'm', 'dim'], 'mixed', previous, random)
		for (const quality of QUALITIES) {
			const notes = notesOf(q, quality.id)
			if (notes[0] < E2 || notes.at(-1)! > E5) ok = false
		}
		if (previous && q.id === previous.id) ok = false
		seen.add(q.id)
		previous = q
	}
	check('chords: every quality voiced within E2–E5, no repeats', ok)
	check('chords: draws only from the enabled pool', [...seen].sort().join() === 'dim,m,maj')
}

check(
	'a pool of one repeats instead of hanging',
	makeQuestion('intervals', ['P5'], 'up', { exercise: 'intervals', id: 'P5', root: 50, direction: 'up' }).id === 'P5'
)

// Playback timing.
{
	const up: Question = { exercise: 'intervals', id: 'P5', root: 48, direction: 'up' }
	const p = playback(up, 'P5', 0.75)
	check('ascending P5 from C3: C3 then G3 after the gap', p.notes.map((n) => `${n.midi}@${n.at}`).join() === '48@0,55@0.75')
	const down = playback({ ...up, root: 60, direction: 'down' }, 'm3', 0.5)
	check('descending m3 from C4: C4 then A3', down.notes.map((n) => `${n.midi}@${n.at}`).join() === '60@0,57@0.5')
	const harmonic = playback({ ...up, direction: 'harmonic' }, 'M3', 0.75)
	check('harmonic: both at once, quieter', harmonic.notes.every((n) => n.at === 0) && harmonic.gain < 1)
	const chord = playback({ exercise: 'chords', id: 'maj', root: E2, direction: 'up' }, 'maj', 0.75)
	check(
		'E major strummed low to high, 30 ms apart',
		chord.notes.map((n) => n.midi).join() === '40,47,52,56,59,64' && chord.notes.every((n, i) => Math.abs(n.at - i * STRUM_S) < 1e-9)
	)
	check('six strings sum without clipping on average', chord.gain * Math.sqrt(chord.notes.length) <= 1 + 1e-9)
}

// Sung answers.
{
	const up: Question = { exercise: 'intervals', id: 'P5', root: 48, direction: 'up' }
	check('sung G3 over C3 ascending = P5', intervalOfAnswer(up, 55) === 'P5')
	check('sung C3 itself = no interval', intervalOfAnswer(up, 48) === null)
	check('sung C2 / C5 (the reference, octaves off) = no interval', intervalOfAnswer(up, 36) === null && intervalOfAnswer(up, 72) === null)
	check('sung G2 under C3 (low voice) folds to P5', intervalOfAnswer(up, 43) === 'P5')
	check('descending: sung A3 under C4 = m3', intervalOfAnswer({ ...up, root: 60, direction: 'down' }, 57) === 'm3')
	check('octave counts, a 9th folds to M2', intervalOfAnswer(up, 60) === 'P8' && intervalOfAnswer(up, 62) === 'M2')
	check('an interval outside the enabled pool is no answer', intervalOfAnswer(up, 55, ['m3', 'M3']) === null && intervalOfAnswer(up, 52, ['m3', 'M3']) === 'M3')
}

// Scoring: first answer counts, later ones audition; stats weakest first.
{
	const random = rng(11)
	const q1 = next('intervals', ['m3', 'P5'], 'up', random)
	const wrong = q1.id === 'm3' ? 'P5' : 'm3'
	const r1 = answer('intervals', wrong)
	const r2 = answer('intervals', q1.id)
	check('wrong first answer counts and breaks the streak', !r1.correct && r1.counted && getSession('intervals').streak === 0)
	check('tapping the right one afterwards does not score', r2.correct && !r2.counted && getSession('intervals').score === 0)
	const q2 = next('intervals', ['m3', 'P5'], 'up', random)
	answer('intervals', q2.id)
	const q3 = next('intervals', ['m3', 'P5'], 'up', random)
	answer('intervals', q3.id)
	const s = getSession('intervals')
	check('two right in a row: score 2, streak 2, best ≥ 2', s.score === 2 && s.streak === 2 && s.best >= 2)
	const stats = weakest('intervals')
	check('weakest first is the missed one', stats[0].id === q1.id && stats[0].right / stats[0].total < 1)
	check('chords session is separate', getSession('chords').score === 0)
}

finish('all ear checks passed')
