// Self-check for ts/metronome.ts: drives the scheduler with a fake audio clock
// and a jittery timer, and checks click times, accents, subdivisions, mute and
// the speed trainer. Run with `npm run check:metronome`.
import * as Metronome from '../ts/core/metronome.ts'
import { check, finish } from './check.ts'

/* Fake Web Audio + browser bits ------------------------------------------- */
const clicks: { at: number; scheduledAt: number }[] = []
let now = 0
let tick: () => void = () => {}
let frame: () => void = () => {}
let disconnected = 0
const param = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} })
const node = (extra: object = {}) => ({ connect: (to: object) => to, disconnect: () => disconnected++, ...extra })
const g = globalThis as unknown as Record<string, unknown>
g.AudioContext = class {
	get currentTime() {
		return now
	}
	outputLatency = 0
	destination = node()
	resume = async () => {}
	suspend = async () => {}
	createGain = () => node({ gain: param() })
	createOscillator = () => ({
		type: 'sine',
		frequency: param(),
		connect: (to: object) => to,
		start: (at: number) => clicks.push({ at, scheduledAt: now }),
		stop() {},
	})
}
g.document = { hidden: false }
g.requestAnimationFrame = (fn: () => void) => ((frame = fn), 1)
g.cancelAnimationFrame = () => {}
g.setInterval = (fn: () => void) => ((tick = fn), 1)
g.clearInterval = () => {}
// No Worker in Node: the engine falls back to setInterval, captured above.

/** Runs `seconds` of fake time with a timer that wakes every 25-75 ms. */
function run(seconds: number) {
	const end = now + seconds
	let jitter = 0
	while (now < end) {
		now += 0.025 + (jitter++ % 3) * 0.025
		tick()
		frame()
	}
}

const heard: Metronome.BeatEvent[] = []
const late: number[] = []
Metronome.onBeat((event) => {
	heard.push(event)
	late.push(now - event.time)
})

function session(seconds: number, setup: () => void) {
	clicks.length = heard.length = late.length = 0
	setup()
	Metronome.start()
	run(seconds)
	Metronome.stop()
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
const noTrainer = { enabled: false, step: 5, bars: 4, target: 160 }

/* 4/4 at 120: a click every 0.5 s, accent on 1 --------------------------- */
session(4.2, () => {
	Metronome.configure({ beats: 4, accents: [2, 1, 1, 1], subdivision: 1, trainer: noTrainer })
	Metronome.setTempo(120)
})
check('120 BPM: a click every 0.5 s', clicks.length >= 8 && clicks.every((c, i) => i === 0 || near(c.at - clicks[i - 1].at, 0.5)))
check(
	'every click was scheduled before its time',
	clicks.every((c) => c.at > c.scheduledAt)
)
check(
	'accent pattern 2 1 1 1',
	heard
		.slice(0, 8)
		.map((e) => e.accent)
		.join('') === '21112111'
)
check('beats count 0-3, bar advances', heard[4].beat === 0 && heard[4].bar === 1 && heard[3].beat === 3)
check(
	'events fire within 75 ms of being heard',
	late.every((l) => l >= 0 && l < 0.075),
	`max ${Math.max(...late).toFixed(3)} s`
)
check('stop() cuts the scheduled clicks off', disconnected > 0 && !Metronome.getState().running)

/* Subdivisions: triplets at 60 BPM = a click every 1/3 s ------------------ */
session(3, () => {
	Metronome.configure({ subdivision: 3 })
	Metronome.setTempo(60)
})
check('triplets: 3 clicks per beat, 1/3 s apart', clicks.length >= 8 && clicks.slice(1, 8).every((c, i) => near(c.at - clicks[i].at, 1 / 3)))
check(
	'sub index runs 0 1 2',
	heard
		.slice(0, 6)
		.map((e) => e.sub)
		.join('') === '012012'
)

/* Mute: a muted beat is silent but still reported ------------------------- */
session(2.1, () => {
	Metronome.configure({ subdivision: 1, accents: [2, 0, 1, 1] })
	Metronome.setTempo(120)
})
check(
	'muted beat is reported',
	heard
		.slice(0, 4)
		.map((e) => e.accent)
		.join('') === '2011'
)
check('muted beat makes no click (1 s gap after beat 1)', near(clicks[1].at - clicks[0].at, 1))

/* Speed trainer: +5 BPM every 2 bars up to 110 -------------------------- */
session(30, () => {
	Metronome.configure({ beats: 2, accents: [2, 1], trainer: { enabled: true, step: 5, bars: 2, target: 110 } })
	Metronome.setTempo(100)
})
const perBar = heard
	.filter((e) => e.beat === 0)
	.slice(0, 8)
	.map((e) => e.bpm)
	.join(' ')
check('trainer: 100 100 105 105 110 110 110 110', perBar === '100 100 105 105 110 110 110 110', perBar)
check('stop() returns to the starting tempo', Metronome.getState().bpm === 100)

/* Beats shrinking mid-bar still wraps ------------------------------------- */
clicks.length = heard.length = late.length = 0
Metronome.configure({ beats: 8, trainer: noTrainer })
Metronome.setTempo(100)
Metronome.start()
run(0.3)
Metronome.configure({ beats: 2 })
run(2)
check(
	'shrinking the bar mid-run wraps at the new count',
	heard.slice(-3).every((e) => e.beat < 2),
	heard
		.slice(-3)
		.map((e) => e.beat)
		.join()
)
Metronome.stop()

/* Subdivision 16ths -> none, mid-beat: no stray click, same grid ---------- */
clicks.length = heard.length = late.length = 0
Metronome.configure({ beats: 4, accents: [2, 1, 1, 1], subdivision: 4 })
Metronome.setTempo(60)
Metronome.start()
run(1.3)
const switchedAt = now
Metronome.configure({ subdivision: 1 })
run(5)
Metronome.stop()
const first = clicks[0].at
const after = clicks.filter((c) => c.scheduledAt > switchedAt + 0.2)
check(
	'16ths -> none mid-beat: clicks stay on the beat grid, 1 s apart',
	after.length >= 4 && after.every((c, i) => near((c.at - first) % 1 || 1, 1) && (i === 0 || near(c.at - after[i - 1].at, 1))),
	after.map((c) => (c.at - first).toFixed(3)).join(' ')
)

/* A stalled main thread skips the backlog instead of bursting ------------- */
clicks.length = heard.length = late.length = 0
Metronome.configure({ subdivision: 1 })
Metronome.setTempo(120)
Metronome.start()
run(1)
const before = clicks.length
now += 5
tick()
const burst = clicks.slice(before)
check('after a 5 s stall no click is played late', burst.every((c) => c.at >= now - 0.05) && burst.length <= 2, `${burst.length} click(s)`)
check(
	'after the stall clicks are back on the 0.5 s grid',
	burst.every((c) => near(((c.at - clicks[0].at) / 0.5) % 1 || 1, 1))
)
Metronome.stop()

finish('All metronome checks passed')
