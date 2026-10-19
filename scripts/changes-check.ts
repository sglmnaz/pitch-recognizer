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
	REFRACTORY_MS,
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

/** A stream as [symbol, duration ms, strummed?] segments at 60 fps; a strummed one starts with an attack. */
type Segments = [string | null, number, boolean?][]

function frames(segments: Segments, frame = FRAME): [string | null, number, boolean][] {
	const out: [string | null, number, boolean][] = []
	let t = 0
	for (const [symbol, ms, strum = false] of segments) {
		const end = t + ms
		let first = true
		for (; t < end; t += frame, first = false) out.push([symbol, t, strum && first])
	}
	return out
}

function onsetsOf(segments: Segments, frame = FRAME): Onset[] {
	const stabilizer = createStabilizer()
	const out: Onset[] = []
	for (const [symbol, t, attack] of frames(segments, frame)) {
		const onset = stabilizer.feed(symbol, t, attack)
		if (onset) out.push(onset)
	}
	return out
}

function countOf(sequence: string[], segments: Segments, frame = FRAME): number {
	const counter = createChangeCounter(sequence)
	for (const onset of onsetsOf(segments, frame)) counter.onChord(onset)
	return counter.count
}

/** Strummed chords back to back, no silence between. */
const strums = (symbols: string[], ms: number): Segments => symbols.map((s) => [s, ms, true])

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
	const blips = onsetsOf([[null, 300], ['D', STABLE_MS - 40], [null, 300], ['Am', STABLE_MS - 15], [null, 300]])
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

	const flip = onsetsOf([['C', 600, true], ['Am', 600]])
	check('a direct flip of a held chord is not fresh', flip.length === 2 && !flip[1].fresh, JSON.stringify(flip))
	const gapped = onsetsOf([['C', 600, true], [null, 120], ['Am', 600]])
	check('a chord after a gap is fresh', gapped.length === 2 && gapped[1].fresh)
	const strummed = onsetsOf(strums(['C', 'Am'], 600))
	check('a strummed chord is fresh even straight after another', strummed[1]?.fresh === true)
}

/* Counting --------------------------------------------------------------- */
{
	const pair = ['G', 'C']
	const changes: Segments = []
	for (let i = 0; i < 11; i++) changes.push([i % 2 ? 'C' : 'G', 800], [null, 120])
	check('G C G C… with gaps: 10 changes', countOf(pair, changes) === 10, String(countOf(pair, changes)))

	// Starting on the second chord of a pair is fine.
	check('a pair can start on either chord', countOf(pair, strums(['C', 'G', 'C'], 500)) === 2)

	// Fast changes, no silence between: 450 ms per chord still counts.
	const fast = strums(Array.from({ length: 21 }, (_, i) => (i % 2 ? 'C' : 'G')), 450)
	check('fast changes (450 ms per chord) all count', countOf(pair, fast) === 20, String(countOf(pair, fast)))

	// Faster than the refractory time: never more than one change per REFRACTORY_MS.
	const frantic = strums(Array.from({ length: 41 }, (_, i) => (i % 2 ? 'C' : 'G')), 250)
	const franticCount = countOf(pair, frantic)
	check('changes faster than the refractory time are capped', franticCount <= (40 * 250) / REFRACTORY_MS && franticCount > 0, String(franticCount))

	// Too fast to be stable (under STABLE_MS per chord) counts nothing.
	const blur: Segments = []
	for (let i = 0; i < 20; i++) blur.push([i % 2 ? 'C' : 'G', STABLE_MS - 20, true])
	check('a blur under the stability time counts nothing', countOf(pair, blur) === 0)
	// The HMM tracker's names are steady: a chord named for a little over STABLE_MS is a chord.
	check('a chord named just past the stability time is stable', onsetsOf([[null, 200], ['D', STABLE_MS + 20], [null, 200]]).length === 1)

	// Re-strumming the same chord, wrong chords in between: not changes.
	check(
		're-strums and wrong chords do not count',
		countOf(pair, [['G', 500, true], [null, 200], ['G', 500, true], ['Em', 500, true], ['G', 500, true], ['C', 500, true]]) === 1
	)

	// Phantom changes: a held C the recognizer keeps flipping to Am and back.
	const phantom: Segments = [['C', 700, true]]
	for (let i = 0; i < 6; i++) phantom.push([i % 2 ? 'C' : 'Am', 500])
	check('a held chord flipping C <-> Am counts nothing', countOf(['C', 'Am'], phantom) === 0, String(countOf(['C', 'Am'], phantom)))
	// A phone drawing 30 fps (33 ms frames) or a 50 ms timer: still flips, not changes.
	for (const ms of [33, 50]) check(`flips at ${ms} ms frames count nothing`, countOf(['C', 'Am'], phantom, ms) === 0, String(countOf(['C', 'Am'], phantom, ms)))
	const strummed30 = strums(Array.from({ length: 11 }, (_, i) => (i % 2 ? 'Am' : 'C')), 600)
	check('strummed changes at 33 ms frames count', countOf(['C', 'Am'], strummed30, 33) === 10, String(countOf(['C', 'Am'], strummed30, 33)))
	// A real change, then the recognizer briefly flips back: one change, not three.
	const backFlip: Segments = [['C', 800, true], ['Am', 200, true], ['C', 200], ['Am', 800]]
	check('a flip back right after a change is not counted', countOf(['C', 'Am'], backFlip) === 1, String(countOf(['C', 'Am'], backFlip)))

	// Sequences go in order: C G Am F; F straight after C is not a change.
	const seq = ['C', 'G', 'Am', 'F']
	check('a sequence counts in order', countOf(seq, strums(['C', 'G', 'Am', 'F', 'C'], 450)) === 4)
	check('out of order is not counted', countOf(seq, strums(['C', 'F', 'Am'], 450)) === 0)

	const counter = createChangeCounter(seq)
	check('before starting, the target is the first chord', counter.target() === 'C' && counter.at === null)
	counter.onChord({ symbol: 'Am', at: 0, fresh: true })
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
	// At 160 BPM, 1 beat per chord (375 ms), a quarter slot is 94 ms: the window floors at 120.
	check('fast tempo: 100 ms off is still a hit', judge(10_000, 375, [10_100]) === 'hit')
	check('fast tempo: 150 ms off is late', judge(10_000, 375, [10_150]) === 'late')

	// Late-change stream: the player changes 450 ms after each downbeat.
	const downbeats = [2000, 4000, 6000, 8000]
	const lateStream: Segments = [['G', 2450, true]]
	for (let i = 1; i < downbeats.length + 1; i++) lateStream.push([i % 2 ? 'C' : 'G', 2000, true])
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
