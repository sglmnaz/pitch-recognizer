// Self-check for ts/core/metronome.ts: drives the scheduler with a fake audio clock
// and a jittery timer, and checks click times, accents, subdivisions, mute and
// the speed trainer. Run with `npm run check:metronome`.
import * as Metronome from '../ts/core/metronome.ts'
import * as Latency from '../ts/core/latency.ts'
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

/* The user's output delay: beat events fire that much after the click's time - */
session(2.1, () => {
	Metronome.configure({ beats: 4, accents: [2, 1, 1, 1], subdivision: 1, trainer: noTrainer, outputDelayMs: 150 })
	Metronome.setTempo(120)
})
check(
	'150 ms output delay: each beat is reported 150 ms after its click',
	heard.length >= 3 && late.every((l) => l >= 0.15 && l < 0.15 + 0.075),
	`late ${late.map((l) => l.toFixed(3)).join(' ')}`
)
check(
	'the delay moves the events, not the clicks',
	clicks.every((c, i) => i === 0 || near(c.at - clicks[i - 1].at, 0.5))
)
// Negative: the browser over-reports its latency, so beats are reported ahead of the click time.
session(2.1, () => {
	Metronome.configure({ outputDelayMs: -60 })
	Metronome.setTempo(120)
})
check(
	'−60 ms output delay: each beat is reported 60 ms before its click',
	heard.length >= 3 && late.every((l) => l >= -0.0601 && l < -0.06 + 0.075),
	`late ${late.map((l) => l.toFixed(3)).join(' ')}`
)
Metronome.configure({ outputDelayMs: 0 })

/* Calibration: the delay read from taps along with the clicks ------------- */
const beatMs = 60000 / Latency.CALIBRATION_BPM
const clickTimes = Array.from({ length: Latency.CALIBRATION_CLICKS }, (_, i) => 1000 + i * beatMs)
// Taps 180 ms behind each click, ±12 ms of human jitter, none on the listening clicks.
const jitter = [5, -12, 8, 0, -6, 11, -3, 7, -9, 2, 12, -10, 4, -1]
const steady = clickTimes.slice(Latency.LISTEN_CLICKS).map((c, i) => c + 180 + jitter[i])
const read = Latency.estimateDelay(clickTimes, steady, beatMs)
check(
	'steady taps 180 ms behind: lag read as 180 ±5 ms',
	read !== null && Math.abs(read.lag - 180) <= 5 && read.spread < Latency.MAX_SPREAD_MS,
	JSON.stringify(read)
)
check('…and set as 180 ms', read !== null && Latency.delaySetting(read.lag) === 180)
const messy = [...steady.slice(0, 6), steady[6] + 250, steady[7], steady[7] + 60, ...steady.slice(8), clickTimes[0] + 30, clickTimes[1] + 40]
const robust = Latency.estimateDelay(clickTimes, messy, beatMs)
check('a stray tap, a double tap and taps on the listening clicks do not move it', robust !== null && Math.abs(robust.lag - 180) <= 6, JSON.stringify(robust))
check(
	'a 450 ms delay still pairs each tap with its own click',
	Latency.estimateDelay(
		clickTimes,
		clickTimes.slice(2).map((c) => c + 450),
		beatMs
	)?.lag === 450
)
check(
	'taps 30 ms ahead of the click set −30 ms',
	Latency.delaySetting(
		Latency.estimateDelay(
			clickTimes,
			clickTimes.slice(2).map((c) => c - 30),
			beatMs
		)!.lag
	) === -30
)
check('the setting stays within −200…400 ms', Latency.delaySetting(-260) === -200 && Latency.delaySetting(520) === 400)
{
	// Mic delay: a phone that hears its own clicks 640 ms late. At 75 BPM that
	// paired with the next click (-160 ms); the slow mic run keeps it whole.
	const micBeat = 60000 / Latency.MIC_CALIBRATION_BPM
	const micClicks = Array.from({ length: Latency.MIC_CALIBRATION_CLICKS }, (_, i) => 1000 + i * micBeat)
	const heard = micClicks.map((c, i) => c + 640 + jitter[i % jitter.length])
	const mic = Latency.estimateDelay(micClicks, heard, micBeat, Latency.MIC_AHEAD_MS)
	check(
		'mic delay: clicks heard 640 ms late read 640, not the next click',
		mic !== null && Math.abs(mic.lag - 640) <= 5 && Latency.delaySetting(mic.lag, Latency.MAX_MIC_DELAY_MS) === 640,
		JSON.stringify(mic)
	)
	const fast = Latency.estimateDelay(
		clickTimes,
		clickTimes.map((c) => c + 640),
		beatMs
	)
	check('…which the tap run at 75 BPM would alias to -160', fast !== null && Math.round(fast.lag) === -160, JSON.stringify(fast))
}
check('too few taps: no answer', Latency.estimateDelay(clickTimes, steady.slice(0, 5), beatMs) === null)
const uneven = Latency.estimateDelay(
	clickTimes,
	clickTimes.slice(2).map((c, i) => c + (i % 2 ? 40 : 260)),
	beatMs
)
check('uneven taps report a spread above the limit', uneven !== null && uneven.spread > Latency.MAX_SPREAD_MS, JSON.stringify(uneven))

finish('All metronome checks passed')
