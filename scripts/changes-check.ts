// Self-check for ts/music/changes.ts: stability, change counting, in-time judging,
// speed-up and records, on synthetic streams of recognized chord symbols.
// Run with `npm run check:changes`.
import {
	accuracy,
	afterMark,
	CLEAN_PASSES,
	createChangeCounter,
	createStabilizer,
	createStrumDetector,
	DEFAULT_SEQUENCE,
	HISTORY,
	hitWindow,
	judge,
	loadRecord,
	offset,
	recordKey,
	REFRACTORY_MS,
	sequenceChord,
	saveSession,
	STABLE_MS,
	validSequence,
	type Onset,
} from '../ts/music/changes.ts'
import { createChangesSession, type MetronomeControl, type SessionUi, verdict } from '../ts/features/trainer/changes.session.ts'
import { check, finish } from './check.ts'

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
	const blips = onsetsOf([
		[null, 300],
		['D', STABLE_MS - 40],
		[null, 300],
		['Am', STABLE_MS - 15],
		[null, 300],
	])
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

	const flip = onsetsOf([
		['C', 600, true],
		['Am', 600],
	])
	check('a direct flip of a held chord is not fresh', flip.length === 2 && !flip[1].fresh, JSON.stringify(flip))
	const gapped = onsetsOf([
		['C', 600, true],
		[null, 120],
		['Am', 600],
	])
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
	const fast = strums(
		Array.from({ length: 21 }, (_, i) => (i % 2 ? 'C' : 'G')),
		450
	)
	check('fast changes (450 ms per chord) all count', countOf(pair, fast) === 20, String(countOf(pair, fast)))

	// Faster than the refractory time: never more than one change per REFRACTORY_MS.
	const frantic = strums(
		Array.from({ length: 41 }, (_, i) => (i % 2 ? 'C' : 'G')),
		250
	)
	const franticCount = countOf(pair, frantic)
	check('changes faster than the refractory time are capped', franticCount <= (40 * 250) / REFRACTORY_MS && franticCount > 0, String(franticCount))

	// Too fast to be stable (under STABLE_MS per chord) counts nothing.
	const blur: Segments = []
	for (let i = 0; i < 20; i++) blur.push([i % 2 ? 'C' : 'G', STABLE_MS - 20, true])
	check('a blur under the stability time counts nothing', countOf(pair, blur) === 0)
	// The HMM tracker's names are steady: a chord named for a little over STABLE_MS is a chord.
	check(
		'a chord named just past the stability time is stable',
		onsetsOf([
			[null, 200],
			['D', STABLE_MS + 20],
			[null, 200],
		]).length === 1
	)

	// Re-strumming the same chord, wrong chords in between: not changes.
	check(
		're-strums and wrong chords do not count',
		countOf(pair, [
			['G', 500, true],
			[null, 200],
			['G', 500, true],
			['Em', 500, true],
			['G', 500, true],
			['C', 500, true],
		]) === 1
	)

	// Phantom changes: a held C the recognizer keeps flipping to Am and back.
	const phantom: Segments = [['C', 700, true]]
	for (let i = 0; i < 6; i++) phantom.push([i % 2 ? 'C' : 'Am', 500])
	check('a held chord flipping C <-> Am counts nothing', countOf(['C', 'Am'], phantom) === 0, String(countOf(['C', 'Am'], phantom)))
	// A phone drawing 30 fps (33 ms frames) or a 50 ms timer: still flips, not changes.
	for (const ms of [33, 50]) check(`flips at ${ms} ms frames count nothing`, countOf(['C', 'Am'], phantom, ms) === 0, String(countOf(['C', 'Am'], phantom, ms)))
	const strummed30 = strums(
		Array.from({ length: 11 }, (_, i) => (i % 2 ? 'Am' : 'C')),
		600
	)
	check('strummed changes at 33 ms frames count', countOf(['C', 'Am'], strummed30, 33) === 10, String(countOf(['C', 'Am'], strummed30, 33)))
	// A real change, then the recognizer briefly flips back: one change, not three.
	const backFlip: Segments = [
		['C', 800, true],
		['Am', 200, true],
		['C', 200],
		['Am', 800],
	]
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
	check('offset: the deciding onset off the downbeat, null for a miss', offset(10_000, slot, [10_900, 9_700]) === -300 && offset(10_000, slot, []) === null)
	check('hit window: a quarter slot, between 120 and 200 ms', hitWindow(4000) === 200 && hitWindow(600) === 150 && hitWindow(375) === 120)
	// At 160 BPM, 1 beat per chord (375 ms), a quarter slot is 94 ms: the window floors at 120.
	check('fast tempo: 100 ms off is still a hit', judge(10_000, 375, [10_100]) === 'hit')
	check('fast tempo: 150 ms off is late', judge(10_000, 375, [10_150]) === 'late')

	// Late-change stream: the player changes 450 ms after each downbeat.
	const downbeats = [2000, 4000, 6000, 8000]
	const lateStream: Segments = [['G', 2450, true]]
	for (let i = 1; i < downbeats.length + 1; i++) lateStream.push([i % 2 ? 'C' : 'G', 2000, true])
	const onsets = onsetsOf(lateStream)
	const marks = downbeats.map((d, i) =>
		judge(
			d,
			2000,
			onsets.filter((o) => o.symbol === (i % 2 ? 'G' : 'C')).map((o) => o.at)
		)
	)
	check(
		'a stream of late changes is marked late',
		marks.every((m) => m === 'late'),
		marks.join(' ')
	)
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

/* The drill's own chords (Changes.sequenceChord) ------------------------------ */
check(
	"recognized relatives count as the drill's chord (field report: G read Em7, C read A7)",
	sequenceChord('Em7', ['G', 'C']) === 'G' && sequenceChord('A7', ['G', 'C']) === 'C' && sequenceChord('C', ['G', 'C']) === 'C'
)
check(
	'a chord sharing too little, or as much with two of them, is none of them',
	sequenceChord('D', ['G', 'C']) === null && sequenceChord('Am', ['C', 'F']) === null && sequenceChord(null, ['G', 'C']) === null
)

/* Strum detector (Changes.createStrumDetector) ------------------------------- */
{
	// Frames every 16.7 ms: room noise wobbling up to 2x, a click (x4 for a frame), a strum
	// (x60, ringing down), its second peak 80 ms on (inside the refractory), a strum 500 ms later.
	const fired: number[] = []
	const detector = createStrumDetector()
	let seed = 3
	const noise = () => {
		seed = (seed * 16807) % 2147483647
		return 1e-6 * (1 + seed / 2147483647)
	}
	const events: [number, number][] = [
		[300, 4e-6],
		[600, 6e-5],
		[680, 8e-5],
		[1100, 6e-5],
	]
	for (let t = 0; t < 1500; t += FRAME) {
		const hit = events.filter(([at]) => t >= at && t - at < FRAME).map(([, e]) => e)[0]
		const ringing = Math.max(0, ...events.filter(([at, e]) => t > at && e > 1e-5).map(([at, e]) => e * Math.exp(-(t - at) / 120)))
		if (detector.feed(t, (hit ?? 0) + ringing + noise())) fired.push(Math.round(t))
	}
	check(
		'strums: fired once per strum, not on noise, a click or a second peak',
		fired.length === 2 && Math.abs(fired[0] - 600) < 20 && Math.abs(fired[1] - 1100) < 20,
		fired.join(' ')
	)
}
{
	// The mic starting: digital silence, then the room's noise 100 ms on. Nothing is a strum.
	const detector = createStrumDetector()
	let fired = 0
	for (let t = 0; t < 1000; t += FRAME) if (detector.feed(t, t < 100 ? 0 : 1e-6)) fired++
	check('strums: none from the mic starting up', fired === 0, String(fired))
}

/* Session state machine (ts/features/trainer/changes.session.ts) ------------- */
{
	// Pitch-class profiles of the two chords as the strings sound them.
	const CHROMA: Record<string, Float32Array> = {
		G: Float32Array.from({ length: 12 }, (_, pc) => ([7, 11, 2].includes(pc) ? 1 / 3 : 0)),
		C: Float32Array.from({ length: 12 }, (_, pc) => ([0, 4, 7].includes(pc) ? 1 / 3 : 0)),
		// The six open strings, E A D G B E: to the drill G–C they sound like G.
		open: Float32Array.from({ length: 12 }, (_, pc) => ([4, 9, 2, 7, 11].includes(pc) ? 1 / 5 : 0)),
	}

	/** A session with a recording UI and a fake metronome (tempo, running). */
	function harness() {
		const events: [string, unknown][] = []
		const metro = { bpm: 0, running: false }
		const ui: SessionUi = {
			heard() {},
			countIn: (left) => void events.push(['countIn', left]),
			target: (symbol) => void events.push(['target', symbol]),
			clock() {},
			counted: (count) => void events.push(['counted', count]),
			beat: (index) => void events.push(['beat', index]),
			marked(marks, offsets, hitMs) {
				events.push(['marked', marks[marks.length - 1]])
				events.push(['offset', offsets[offsets.length - 1]])
				events.push(['hitMs', hitMs])
			},
			announce: (text) => void events.push(['announce', text]),
		}
		const metronome: MetronomeControl = {
			configure() {},
			setTempo(bpm) {
				metro.bpm = bpm
			},
			start() {
				metro.running = true
			},
			stop() {
				metro.running = false
			},
			getState: () => ({ running: metro.running, bpm: metro.bpm, bar: 0, beat: 0 }),
		}
		const of = (kind: string) => events.filter((e) => e[0] === kind).map((e) => e[1])
		return { session: createChangesSession(ui, metronome), metro, of }
	}

	// One-minute, 30 s on D–A: D rings through the 3 s count-in, then A, D, A strummed a second apart.
	{
		const { session, metro, of } = harness()
		session.start({ mode: 'minute', sequence: ['D', 'A'], seconds: 30, beats: 4, bpm: 60, speedUp: false, countIn: true, volume: 1 }, 0)
		let endedAt = -1
		for (const [symbol, t, strum] of frames([
			['D', 4000, true],
			['A', 1000, true],
			['D', 1000, true],
			['A', 1000, true],
			[null, 27000],
		])) {
			if (endedAt < 0 && session.frame(t, strum, symbol)) endedAt = t
		}
		check('one-minute: count-in shows 3, 2, 1', [...new Set(of('countIn'))].join() === '3,2,1', [...new Set(of('countIn'))].join())
		check('one-minute: "Get ready", then "Go"', of('announce').slice(0, 2).join() === 'Get ready on D,Go', of('announce').join(' | '))
		check('one-minute: the ringing D starts it, three changes counted', of('counted').join() === '1,2,3', of('counted').join())
		check('one-minute: time is up 30 s after the count-in', endedAt >= 33_000 && endedAt < 33_000 + FRAME + 1, String(endedAt))
		const result = session.end(true)
		check(
			'one-minute: the result is the count, the metronome untouched',
			result?.mode === 'minute' && result.count === 3 && session.phase() === 'done' && metro.bpm === 0
		)
	}

	check('verdict: nothing heard', verdict(0, { best: 4, history: [4] }) === 'No changes heard, not saved')
	check('verdict: first session', verdict(3, { best: 0, history: [] }) === 'First session')
	check(
		'verdict: best, tie, behind',
		verdict(7, { best: 5, history: [5] }) === 'New best, +2' &&
			verdict(5, { best: 5, history: [5] }) === 'Ties your best' &&
			verdict(3, { best: 5, history: [5] }) === '-2 from your best'
	)

	/**
	 * In time, G–C at 120 BPM, 2 beats a chord, 4 count-in clicks: the player
	 * changes on every downbeat, strumming `strumOffset` ms after it; the frames
	 * carry the profile of what the strings sound like (the chord changes at its
	 * strum) and a level. Field cases (scripts/replay.ts) on request: a strum on
	 * every beat, the clicks heard as strums, the open strings of the lifted
	 * fingers liftMs before each change (quiet), the strum's own second peak
	 * secondPeakMs after it (louder).
	 */
	function inTime(strumOffset: number, { ms = 12_000, profiles = true, everyBeat = false, clicks = false, liftMs = 0, secondPeakMs = 0 } = {}) {
		const h = harness()
		h.session.start({ mode: 'time', sequence: ['G', 'C'], seconds: 60, beats: 2, bpm: 120, speedUp: true, countIn: true, volume: 1 }, 0)
		const downbeats: number[] = []
		const beats: number[] = []
		const clicked: number[] = []
		let nextClick = 0
		let index = 0
		for (let t = 0; t < ms; t += FRAME) {
			for (; nextClick <= t; index++, nextClick += 60_000 / h.metro.bpm) {
				h.session.beat(
					{ time: 0, bar: Math.floor(index / 2), beat: index % 2, sub: 0, accent: 1, bpm: h.metro.bpm, heardAt: nextClick, stampedAt: null },
					nextClick
				)
				clicked.push(nextClick)
				if (index >= 4 && index % 2 === 0) downbeats.push(nextClick)
				if (index >= 4) beats.push(nextClick)
			}
			// The downbeat to come too (not clicked yet): the lifted fingers sound before it.
			const coming = [...downbeats, (downbeats.at(-1) ?? 2000) + (2 * 60_000) / h.metro.bpm]
			const struck = (everyBeat ? beats : downbeats).map((d) => d + strumOffset)
			const lifts = liftMs ? coming.map((d) => d + strumOffset - liftMs) : []
			const seconds = secondPeakMs ? downbeats.map((d) => d + strumOffset + secondPeakMs) : []
			const heardClicks = clicks ? clicked : []
			const strum = [...struck, ...lifts, ...seconds, ...heardClicks].some((at) => at > t - FRAME && at <= t)
			const played = downbeats.filter((d) => d + strumOffset <= t).length
			const lifting = lifts.some((l) => t >= l && t < l + liftMs)
			const sounding = lifting ? 'open' : played ? ['G', 'C'][(played - 1) % 2] : 'G'
			const ring = (events: number[], level: number) => Math.max(0, ...events.filter((at) => at <= t).map((at) => level * Math.exp(-(t - at) / 150)))
			const volume = Math.max(ring(struck, 1), ring(lifts, 0.08), ring(seconds, 1.4), ring(heardClicks, 0.05))
			// The recognizer's name only shows as Hearing now; it names the chord 283 ms on.
			const named = downbeats.filter((d) => d + 283 <= t).length
			h.session.frame(t, strum, named ? ['G', 'C'][(named - 1) % 2] : 'G', profiles ? CHROMA[sounding] : null, volume)
		}
		return h
	}
	const offsetsOf = (h: ReturnType<typeof inTime>) => h.of('offset') as (number | null)[]
	const near = (offsets: (number | null)[], dt: number) => offsets.length >= 5 && offsets.every((o) => o !== null && Math.abs(o - dt) <= 20)
	const show = (offsets: (number | null)[]) => offsets.map((o) => (o === null ? '-' : o.toFixed(0))).join(' ')

	{
		const { session, metro, of } = inTime(100)
		const marks = of('marked')
		check('in time: started the metronome at the session tempo', metro.running && of('countIn').join() === '4,3,2,1', of('countIn').join())
		check('in time: strummed changes on the downbeat are hits', marks.length >= 6 && marks.every((m) => m === 'hit'), marks.join(' '))
		const offsets = offsetsOf({ of } as ReturnType<typeof inTime>)
		const hitMs = of('hitMs') as number[]
		check(
			'in time: each mark comes with its offset, inside the window it was judged by',
			offsets.length === marks.length && offsets.every((dt, i) => dt !== null && Math.abs(dt) <= hitMs[i]),
			show(offsets)
		)
		const beats = of('beat').join('')
		check('in time: the beats of each chord after the count-in, 0 on its first', beats.startsWith('010101'), beats)
		check(
			'in time: two clean passes speed it up on a downbeat',
			metro.bpm > 120 && of('announce').includes('Two clean passes. Up to 125 BPM.'),
			String(metro.bpm)
		)
		const result = session.end(false)
		check('in time: ending stops the clicks and reports the tempo', !metro.running && result?.mode === 'time' && result.bpm === metro.bpm)
	}
	{
		const offsets = offsetsOf(inTime(100))
		check("in time: a change is dated by its strum (minus the detector's 15 ms)", near(offsets, 85), show(offsets))
	}
	{
		const offsets = offsetsOf(inTime(100, { everyBeat: true }))
		check('in time: re-strums of the chord ringing are not changes', near(offsets, 85), show(offsets))
	}
	{
		const offsets = offsetsOf(inTime(100, { clicks: true }))
		check('in time: clicks heard as strums sound like the chord ringing: not changes', near(offsets, 85), show(offsets))
	}
	{
		const offsets = offsetsOf(inTime(100, { everyBeat: true, liftMs: 180, secondPeakMs: 130 }))
		check('in time: not the lifted fingers (a louder strum follows), not the second peak (the same chord): the strum', near(offsets, 85), show(offsets))
	}
	{
		const offsets = offsetsOf(inTime(0))
		check('in time: a strum right on the click counts (the change is in its sound, not in a name)', near(offsets, -15), show(offsets))
	}
	{
		const h = inTime(100, { profiles: false })
		check(
			'in time: without a profile (too quiet, or as flat as a breath) nothing is a change',
			h.of('marked').every((m) => m === 'miss') && h.of('offset').every((dt) => dt === null),
			h.of('marked').join(' ')
		)
	}
}

finish('All changes checks passed')
