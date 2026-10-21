// Metronome engine: own AudioContext, no DOM. Reusable by anything that needs a
// steady pulse (a chord-change trainer, say): configure(), setTempo(), start(),
// stop(), onBeat(), getState().
//
// Timing follows Chris Wilson's "A Tale of Two Clocks": a coarse JS timer wakes
// up every TICK_MS and schedules every click that falls inside the next
// LOOKAHEAD seconds on the sample-accurate audio clock. The timer may jitter
// (GC, a busy main thread) without moving a click; it only has to wake up
// before the lookahead runs dry. Nothing is ever started from a timer callback.

export type Accent = 0 | 1 | 2 // mute, normal, accent
export type Sound = 'click' | 'wood' | 'beep' | 'cowbell'

export interface Config {
	/** Beats per bar. */
	beats: number
	/** Per-beat level, index = beat; missing entries count as normal. */
	accents: Accent[]
	/** Clicks per beat: 1 none, 2 eighths, 3 triplets, 4 sixteenths. */
	subdivision: number
	sound: Sound
	/** 0–1. */
	volume: number
	/** Speed trainer: raise the tempo by `step` BPM every `bars` bars up to `target`. */
	trainer: { enabled: boolean; step: number; bars: number; target: number }
	/** Output delay the browser does not report (Bluetooth, some phones), in ms: beat events fire this much
	 * later. Negative fires them earlier, but never before the click is scheduled (LOOKAHEAD ahead of it). */
	outputDelayMs: number
}

export interface BeatEvent {
	/** AudioContext time the click sounds at. */
	time: number
	/** Bars since start, 0-based. */
	bar: number
	/** Beat in the bar, 0-based. */
	beat: number
	/** Subdivision click within the beat, 0 = on the beat. */
	sub: number
	accent: Accent
	/** Tempo this click was scheduled at (moves while the speed trainer runs). */
	bpm: number
	/** performance.now() time the click is heard at: the callback itself can run up to a frame later. */
	heardAt: number
	/** The same per AudioContext.getOutputTimestamp() (plus the user's delay), to check heardAt against; null where unsupported. */
	stampedAt: number | null
}

export interface State {
	running: boolean
	/** Current tempo, including speed-trainer increases. */
	bpm: number
	/** Position of the last click that was heard (0 until the first one). */
	bar: number
	beat: number
}

export const MIN_BPM = 30
export const MAX_BPM = 300

const TICK_MS = 25
const LOOKAHEAD = 0.12
// A step this far in the past was missed (stalled main thread): skip it, do not play it late.
const STALE = 0.05
// Browsers throttle timers in background tabs (to 1 s, sometimes 1 min), so
// while hidden schedule far enough ahead to survive a throttled wake-up. A
// worker's timer is not throttled in most browsers (startTimer), this is the
// net under it.
const LOOKAHEAD_HIDDEN = 1.6
// First click a hair after Start, so the audio graph is ready.
const START_DELAY = 0.06
// Loudness per kind of click; subdivisions sit well under the beats.
const LEVEL = { accent: 1, normal: 0.6, sub: 0.3 }

interface Voice {
	type: OscillatorType
	/** Pitch of a normal and an accented click. */
	hz: [number, number]
	/** The click starts this many times higher and falls to `hz` in 15 ms (a "tok"). */
	drop: number
	attack: number
	decay: number
	gain: number
	/** A second oscillator this many times higher: two clashing square waves
	 * are the drum machine's cowbell (TR-808: 540 and 800 Hz). */
	ratio?: number
}
const VOICES: Record<Sound, Voice> = {
	click: { type: 'square', hz: [1200, 1800], drop: 1, attack: 0.001, decay: 0.025, gain: 0.5 },
	wood: { type: 'triangle', hz: [650, 950], drop: 2, attack: 0.001, decay: 0.07, gain: 1 },
	beep: { type: 'sine', hz: [880, 1320], drop: 1, attack: 0.004, decay: 0.11, gain: 0.9 },
	cowbell: { type: 'square', hz: [540, 720], drop: 1, attack: 0.001, decay: 0.14, gain: 0.25, ratio: 1.48 },
}

const config: Config = {
	beats: 4,
	accents: [2, 1, 1, 1],
	subdivision: 1,
	sound: 'click',
	volume: 0.8,
	trainer: { enabled: false, step: 5, bars: 4, target: 160 },
	outputDelayMs: 0,
}

let ctx: AudioContext | null = null
let master: GainNode | null = null
// One bus per run: stop() disconnects it, which also silences clicks that are
// already scheduled inside the lookahead.
let bus: GainNode | null = null

let running = false
let baseBpm = 100
let liveBpm = 100
// Time of the current beat and its length. Clicks sit at beatTime + sub * beatDur / subdivision,
// so changing the subdivision mid-beat cannot shift the grid, and a tempo change
// takes effect on the next beat line.
let beatTime = 0
let beatDur = 0.6
let bar = 0
let beat = 0
let sub = 0
let heard = { bar: 0, beat: 0 }

const pending: BeatEvent[] = []
const listeners = new Set<(event: BeatEvent) => void>()
let worker: Worker | null = null
let workerUrl = ''
let interval = 0
let frame = 0

export function configure(patch: Partial<Config>) {
	Object.assign(config, patch)
	if (master && ctx) master.gain.setValueAtTime(config.volume ** 2, ctx.currentTime)
}

/** Sets the tempo now and as the one the speed trainer restarts from. */
export function setTempo(bpm: number) {
	baseBpm = liveBpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)))
}

/** Called at the moment each click is heard (audio clock, output latency included). */
export function onBeat(callback: (event: BeatEvent) => void): () => void {
	listeners.add(callback)
	return () => listeners.delete(callback)
}

/** What the click's AudioContext reports of its latency, ms (null before the first start). */
export function latencies(): { outputMs: number | null; baseMs: number | null } {
	return { outputMs: ctx ? (ctx.outputLatency ?? 0) * 1000 : null, baseMs: ctx ? (ctx.baseLatency ?? 0) * 1000 : null }
}

export function getState(): State {
	return { running, bpm: liveBpm, ...heard }
}

export function start() {
	if (running) return
	if (!ctx) {
		ctx = new AudioContext({ latencyHint: 'interactive' })
		master = ctx.createGain()
		master.connect(ctx.destination)
	}
	// Must run inside the tap that called start(): browsers keep audio locked until a gesture.
	void ctx.resume()
	master!.gain.setValueAtTime(config.volume ** 2, ctx.currentTime)
	bus = ctx.createGain()
	bus.connect(master!)

	liveBpm = baseBpm
	bar = beat = sub = 0
	heard = { bar: 0, beat: 0 }
	pending.length = 0
	beatTime = ctx.currentTime + START_DELAY
	beatDur = 60 / liveBpm
	running = true
	startTimer()
	schedule()
	paint()
}

export function stop() {
	if (!running) return
	running = false
	stopTimer()
	cancelAnimationFrame(frame)
	bus?.disconnect()
	bus = null
	pending.length = 0
	liveBpm = baseBpm
	// Release the audio device (battery, iOS audio session) until the next start.
	void ctx?.suspend()
}

/* Scheduling ------------------------------------------------------------- */
function schedule() {
	if (!running || !ctx) return
	try {
		const horizon = ctx.currentTime + (document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD)
		// After a stall (busy main thread, throttled timer) skip the missed steps
		// instead of playing them all at once; bar and beat counters stay on the grid.
		// Subdivision shrunk mid-beat: the rest of that beat's clicks no longer exist.
		if (sub >= config.subdivision) nextBeat()
		while (stepTime() < ctx.currentTime - STALE) advance()
		while (stepTime() < horizon) {
			playStep(stepTime())
			advance()
		}
		flush()
	} catch (error) {
		// The timer must outlive a bad step; the next tick tries again.
		console.error('Metronome step failed:', error)
	}
}

const stepTime = () => beatTime + (sub * beatDur) / config.subdivision

function playStep(time: number) {
	const accent = config.accents[beat] ?? 1
	pending.push({ time, bar, beat, sub, accent, bpm: liveBpm, heardAt: 0, stampedAt: null })
	if (accent === 0) return
	click(time, accent === 2 && sub === 0, sub > 0 ? LEVEL.sub : accent === 2 ? LEVEL.accent : LEVEL.normal)
}

function advance() {
	if (++sub >= config.subdivision) nextBeat()
}

function nextBeat() {
	sub = 0
	beatTime += beatDur
	// `beats` may shrink mid-bar, hence >=.
	if (++beat >= config.beats) {
		beat = 0
		bar++
		const { enabled, step, bars, target } = config.trainer
		if (enabled && bar % bars === 0 && liveBpm < target) liveBpm = Math.min(target, liveBpm + step)
	}
	beatDur = 60 / liveBpm
}

function click(time: number, accented: boolean, level: number) {
	if (!ctx || !bus) return
	const voice = VOICES[config.sound]
	const hz = voice.hz[accented ? 1 : 0]
	const gain = ctx.createGain()
	gain.gain.setValueAtTime(0.0001, time)
	gain.gain.linearRampToValueAtTime(level * voice.gain, time + voice.attack)
	gain.gain.exponentialRampToValueAtTime(0.0001, time + voice.attack + voice.decay)
	gain.connect(bus)
	for (const f of voice.ratio ? [hz, hz * voice.ratio] : [hz]) {
		const osc = ctx.createOscillator()
		osc.type = voice.type
		osc.frequency.setValueAtTime(f * voice.drop, time)
		if (voice.drop !== 1) osc.frequency.exponentialRampToValueAtTime(f, time + 0.015)
		osc.connect(gain)
		osc.start(time)
		osc.stop(time + voice.attack + voice.decay + 0.02)
	}
}

/* Events: fired when the click is heard, not when it is scheduled ----------- */
function flush() {
	if (!ctx) return
	// A click scheduled for `time` reaches the ears outputLatency later, plus
	// what the device adds without telling the browser (the user's setting).
	const now = ctx.currentTime - (ctx.outputLatency || 0) - config.outputDelayMs / 1000
	const stamp = pending.length && pending[0].time <= now ? ctx.getOutputTimestamp?.() : undefined
	while (pending.length && pending[0].time <= now) {
		const event = pending.shift()!
		event.heardAt = performance.now() - (now - event.time) * 1000
		if (stamp?.performanceTime && stamp.contextTime !== undefined)
			event.stampedAt = stamp.performanceTime + (event.time - stamp.contextTime) * 1000 + config.outputDelayMs
		heard = { bar: event.bar, beat: event.beat }
		for (const listener of listeners) {
			try {
				listener(event)
			} catch (error) {
				console.error('Metronome listener failed:', error)
			}
		}
	}
}

// requestAnimationFrame gives the visuals frame-accurate dispatch while the
// tab is visible; the scheduler tick (which also flushes) covers hidden tabs,
// where rAF stops.
function paint() {
	flush()
	frame = requestAnimationFrame(paint)
}

function startTimer() {
	try {
		workerUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${TICK_MS})`], { type: 'text/javascript' }))
		worker = new Worker(workerUrl)
		worker.onmessage = schedule
	} catch {
		interval = setInterval(schedule, TICK_MS) as unknown as number
	}
}

function stopTimer() {
	worker?.terminate()
	worker = null
	// Revoked only now: some browsers load the worker script asynchronously.
	if (workerUrl) URL.revokeObjectURL(workerUrl)
	workerUrl = ''
	clearInterval(interval)
}
