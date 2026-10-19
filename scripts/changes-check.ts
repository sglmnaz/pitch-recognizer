// Self-check for ts/changes.ts: stability, change counting, in-time judging,
// speed-up and records, on synthetic streams of recognized chord symbols.
// Run with `npm run check:changes`.
import {
	accuracy,
	afterMark,
	CLEAN_PASSES,
	createChangeCounter,
	createStabilizer,
	DEFAULT_SEQUENCE,
	HISTORY,
	judge,
	loadRecord,
	recordKey,
	saveSession,
	STABLE_MS,
	validSequence,
	type Onset,
} from '../ts/changes.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures++
}

const FRAME = 1000 / 60

/** A stream as [symbol, duration ms] segments, played at 60 fps. */
type Segments = [string | null, number][]

function frames(segments: Segments): [string | null, number][] {
	const out: [string | null, number][] = []
	let t = 0
	for (const [symbol, ms] of segments) {
		const end = t + ms
		for (; t < end; t += FRAME) out.push([symbol, t])
	}
	return out
}

function onsetsOf(segments: Segments): Onset[] {
	const stabilizer = createStabilizer()
	const out: Onset[] = []
	for (const [symbol, t] of frames(segments)) {
		const onset = stabilizer.feed(symbol, t)
		if (onset) out.push(onset)
	}
	return out
}

function countOf(sequence: string[], segments: Segments): number {
	const counter = createChangeCounter(sequence)
	for (const onset of onsetsOf(segments)) counter.onChord(onset.symbol)
	return counter.count
}

/* Stability ------------------------------------------------------------ */
{
	const held = onsetsOf([['G', 2000]])
	check('a held chord is one stable run', held.length === 1 && held[0].symbol === 'G', JSON.stringify(held))
	check('its onset is when it started ringing', held[0]?.at === 0)

	// Noise flicker: one wrong frame every 100 ms inside a held G.
	const flicker: Segments = []
	for (let i = 0; i < 20; i++) flicker.push(['G', 100], [i % 2 ? 'Em' : null, FRAME])
	const flickered = onsetsOf(flicker)
	check('single-frame flicker does not split a held chord', flickered.length === 1, JSON.stringify(flickered))

	// Stray names shorter than STABLE_MS (a strum's attack, a click) never count.
	const blips = onsetsOf([[null, 300], ['D', STABLE_MS - 40], [null, 300], ['Am', 60], [null, 300]])
	check('blips under the stability time are ignored', blips.length === 0, JSON.stringify(blips))

	// Alternating chord / no-chord frames (an unsteady recognizer) still holds the chord.
	const unsteady: Segments = []
	for (let i = 0; i < 30; i++) unsteady.push(['C', FRAME], [null, FRAME])
	check('chord on every other frame is still stable', onsetsOf(unsteady).length === 1)

	const stabilizer = createStabilizer()
	for (const [symbol, t] of frames([['A', 400]])) stabilizer.feed(symbol, t)
	check('current() names the steady chord', stabilizer.current() === 'A')
	for (const [, t] of frames([[null, 200]])) stabilizer.feed(null, 400 + t)
	check('current() clears after silence', stabilizer.current() === null)
}

/* Counting --------------------------------------------------------------- */
{
	const pair = ['G', 'C']
	const changes: Segments = []
	for (let i = 0; i < 11; i++) changes.push([i % 2 ? 'C' : 'G', 800], [null, 120])
	check('G C G C… with gaps: 10 changes', countOf(pair, changes) === 10, String(countOf(pair, changes)))

	// Starting on the second chord of a pair is fine.
	check('a pair can start on either chord', countOf(pair, [['C', 500], ['G', 500], ['C', 500]]) === 2)

	// Fast changes, no silence between: 250 ms per chord still counts.
	const fast: Segments = []
	for (let i = 0; i < 21; i++) fast.push([i % 2 ? 'C' : 'G', 250])
	check('fast changes (250 ms per chord) all count', countOf(pair, fast) === 20, String(countOf(pair, fast)))

	// Too fast to be stable (100 ms per chord) counts nothing.
	const blur: Segments = []
	for (let i = 0; i < 20; i++) blur.push([i % 2 ? 'C' : 'G', 100])
	check('a blur under the stability time counts nothing', countOf(pair, blur) === 0)

	// Re-strumming the same chord, wrong chords in between: not changes.
	check(
		're-strums and wrong chords do not count',
		countOf(pair, [['G', 500], [null, 200], ['G', 500], ['Em', 500], ['G', 500], ['C', 500]]) === 1
	)

	// Sequences go in order: C G Am F; F straight after C is not a change.
	const seq = ['C', 'G', 'Am', 'F']
	check('a sequence counts in order', countOf(seq, [['C', 400], ['G', 400], ['Am', 400], ['F', 400], ['C', 400]]) === 4)
	check('out of order is not counted', countOf(seq, [['C', 400], ['F', 400], ['Am', 400]]) === 0)

	const counter = createChangeCounter(seq)
	check('before starting, the target is the first chord', counter.target() === 'C' && counter.at === null)
	counter.onChord('Am')
	check('starting mid-sequence targets the next one', counter.target() === 'F' && counter.at === 'Am')
}

/* In time ---------------------------------------------------------------- */
{
	const slot = 2000 // 60 BPM, 2 beats per chord
	check('on the downbeat is a hit', judge(10_000, slot, [10_050]) === 'hit')
	check('just before the downbeat is a hit', judge(10_000, slot, [9_850]) === 'hit')
	check('late change is late', judge(10_000, slot, [10_400]) === 'late')
	check('early change is early', judge(10_000, slot, [9_500]) === 'early')
	check('no onset is a miss', judge(10_000, slot, []) === 'miss')
	check('an onset past half the slot belongs to the next downbeat: miss', judge(10_000, slot, [11_100]) === 'miss')
	check('the first onset decides (a later re-strum does not rescue it)', judge(10_000, slot, [10_900, 10_500]) === 'late')
	// At 160 BPM, 1 beat per chord (375 ms), the hit window shrinks to a quarter slot.
	check('fast tempo: 120 ms off is late', judge(10_000, 375, [10_120]) === 'late')
	check('fast tempo: 60 ms off is a hit', judge(10_000, 375, [10_060]) === 'hit')

	// Late-change stream: the player changes 450 ms after each downbeat.
	const downbeats = [2000, 4000, 6000, 8000]
	const lateStream: Segments = [['G', 2450]]
	for (let i = 1; i < downbeats.length + 1; i++) lateStream.push([i % 2 ? 'C' : 'G', 2000])
	const onsets = onsetsOf(lateStream)
	const marks = downbeats.map((d, i) => judge(d, 2000, onsets.filter((o) => o.symbol === (i % 2 ? 'G' : 'C')).map((o) => o.at)))
	check('a stream of late changes is marked late', marks.every((m) => m === 'late'), marks.join(' '))
	check('accuracy of all-late is 0 %', accuracy(marks) === 0)
	check('accuracy counts hits', accuracy(['hit', 'late', 'hit', 'miss']) === 50)

	// Speed-up after CLEAN_PASSES clean passes of a pair.
	let clean = 0
	let bumps = 0
	for (let i = 0; i < CLEAN_PASSES * 2; i++) {
		const next = afterMark(clean, 'hit', 2)
		clean = next.clean
		if (next.speedUp) bumps++
	}
	check('speeds up after the clean passes', bumps === 1 && clean === 0)
	check('a miss restarts the clean run', afterMark(3, 'late', 2).clean === 0 && !afterMark(3, 'miss', 2).speedUp)
}

/* Validation & records ----------------------------------------------------- */
{
	check('valid sequence kept', validSequence(['Am', 'E']).join() === 'Am,E')
	check('unknown and repeated chords dropped, at most four', validSequence(['C', 'X', 'C', 'G', 'D', 'A', 'E']).join() === 'C,G,D,A')
	check('under two falls back to the default pair', validSequence(['C']).join() === DEFAULT_SEQUENCE.join() && validSequence('junk').length === 2)
	check('a pair shares its record either way round', recordKey(['G', 'C']) === recordKey(['C', 'G']))
	check('a sequence keeps its order in the key', recordKey(['C', 'G', 'Am', 'F']) !== recordKey(['G', 'C', 'Am', 'F']))

	check('no storage: empty record, no throw', loadRecord(['G', 'C'], 60).best === 0)

	const store = new Map<string, string>()
	;(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
	}
	const first = saveSession(['G', 'C'], 60, 20)
	check('first session: no previous best', first.best === 0 && first.history.length === 0)
	saveSession(['C', 'G'], 60, 25)
	const third = saveSession(['G', 'C'], 60, 22)
	check('previous best returned for the delta', third.best === 25, JSON.stringify(third))
	check('history grows oldest first', loadRecord(['G', 'C'], 60).history.join() === '20,25,22')
	check('durations are separate records', loadRecord(['G', 'C'], 30).best === 0)
	for (let i = 0; i < 15; i++) saveSession(['G', 'C'], 60, i)
	const long = loadRecord(['G', 'C'], 60)
	check('history keeps the last few sessions', long.history.length === HISTORY && long.best === 25)
	store.set(recordKey(['A', 'D']), '{oops')
	check('corrupt storage reads as no record', loadRecord(['A', 'D'], 60).best === 0)
}

if (failures) {
	console.error(`\n${failures} check(s) failed`)
	process.exit(1)
}
console.log('\nAll changes checks passed')
