// Trainer → Changes: one session's state machine, DOM-free. One-minute
// (count-in, countdown, counted changes) and In time (driven by the shared
// metronome: count-in beats, slots, judged downbeats, speed-up). The view
// feeds it frames and beats and draws what it reports through `SessionUi`;
// `npm run check:changes` drives it with a fake clock and metronome.
import * as Changes from '../../music/changes.ts'
import type * as Metronome from '../../core/metronome.ts'
import type { ProbeEntry } from './timing-probe.ts'

// In time dates a change by its strum: the level jump the mic hears at once,
// not the recognizer naming the chord, which comes 200 ms to over a second
// later depending on the chord, the room and the phone (bench median 283 ms;
// on a Xiaomi ~1 s, so changes dated by naming read ~650 ms late). The strum is
// the first one between the previous change and NAMING_MIN_MS before the
// naming (at most STRUM_SEARCH_MS back) that sounds like the new chord more
// than the old one: its pitch-class profile from CHROMA_FROM_MS to
// CHROMA_TO_MS after it. Re-strums of the old chord sound like the old chord;
// re-strums of the new one come after the change. That same strum also makes a
// chord the recognizer flipped to (no gap) a played change, however late it was
// named. Without a profile, the last strum within Changes.ATTACK_LEAD_MS.
const NAMING_MIN_MS = 150
const STRUM_SEARCH_MS = 1500
const CHROMA_FROM_MS = 40
const CHROMA_TO_MS = 200
// Profiles older than this are no use to any strum still to be matched.
const CHROMA_KEEP_MS = STRUM_SEARCH_MS + CHROMA_TO_MS
// The level detector fires a frame or so after the strum reaches the mic.
// Calibration knob, like Trainer → Tab's ATTACK_LATENCY_MS.
const STRUM_LATENCY_MS = 15
// No strum found for it (masked or too soft): the change is dated this long
// before its naming, or by the median naming delay of this session's changes
// that had a strum (the phone's own). 283 ms = the benchmark's median from a
// real chord change to its first naming (bench/README.md); check:chords'
// synthetic strums read 205 ms for a change after a pause, 372 ms from cold.
export const RECOGNITION_LATENCY_MS = 283
// From a chord's strum to the frame it is confirmed stable, at the latest.
const CONFIRM_MS = STRUM_SEARCH_MS + Changes.STABLE_MS + Changes.FLICKER_MS
const COUNT_IN_S = 3
// In time: one bar of 4 clicks, a whole number of chords at 1, 2 or 4 beats each.
const COUNT_IN_BEATS = 4
// Onsets older than this cannot fall in any slot still waiting to be judged.
const ONSET_KEEP_MS = 10_000
// In time: through a speaker the mic hears each click as an attack. One within
// this of the last click heard is the click, not a strum (a chord change on the
// beat still counts: another name came between). Calibration knob: widen it if
// clicks still read as strums on a phone with a slow input path.
const CLICK_MASK_MS = 40

type Phase = 'idle' | 'countin' | 'running' | 'done'

/** Frozen at Start: a session runs on the settings it started with. */
export interface SessionConfig {
	mode: 'minute' | 'time'
	sequence: string[]
	seconds: number
	beats: number
	bpm: number
	speedUp: boolean
	countIn: boolean
	/** In time: the click volume (the Metronome tab's). */
	volume: number
}

/** What the view draws while a session runs. */
export interface SessionUi {
	/** The chord the stabilizer is following (every frame, idle too). */
	heard(symbol: string | null): void
	/** Count-in: seconds (One-minute) or beats (In time) left before `first`. */
	countIn(left: number, first: string): void
	target(symbol: string, then: string): void
	clock(text: string): void
	/** One-minute: a change counted. */
	counted(count: number): void
	/** In time: a beat of the chord's slot heard (0 = the chord's first beat, where the change falls). */
	beat(index: number): void
	/**
	 * In time: a slot judged (the last of `marks`); `offsets` runs beside it,
	 * ms off the downbeat (negative = early, null = missed), `hitMs` = that
	 * slot's on-time window either side.
	 */
	marked(marks: Changes.Mark[], offsets: (number | null)[], hitMs: number): void
	announce(text: string, force?: boolean): void
	/** ?debug: the timing log (timing-probe.ts). */
	probe?(entry: ProbeEntry): void
}

/** The metronome calls a session makes (ts/core/metronome.ts). */
export type MetronomeControl = Pick<typeof Metronome, 'configure' | 'setTempo' | 'start' | 'stop' | 'getState'>

/** How a session ended: the result to show, or null (stopped, nothing to show). */
export type SessionResult = { mode: 'minute'; count: number; before: Changes.ChangeRecord } | { mode: 'time'; marks: Changes.Mark[]; bpm: number } | null

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]

export const clockText = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One-minute: the line under the count, against the record before this session. */
export function verdict(count: number, before: Changes.ChangeRecord): string {
	const delta = count - before.best
	return !count
		? 'No changes heard, not saved'
		: !before.history.length
			? 'First session'
			: delta > 0
				? `New best, +${delta}`
				: delta === 0
					? 'Ties your best'
					: `${delta} from your best`
}

export function createChangesSession(ui: SessionUi, metronome: MetronomeControl) {
	let phase: Phase = 'idle'
	let config: SessionConfig = { mode: 'minute', sequence: [], seconds: 60, beats: 4, bpm: 60, speedUp: false, countIn: true, volume: 0 }
	let stabilizer = Changes.createStabilizer()
	let counter = Changes.createChangeCounter([])
	let goAt = 0
	let endsAt = 0
	// In time.
	let slot = -1
	let marks: Changes.Mark[] = []
	let offsets: (number | null)[] = []
	let pending: { downbeat: number; slotMs: number; target: string }[] = []
	let onsets: Changes.Onset[] = []
	// In time: every strum heard (clicks included) and the frames' pitch-class
	// profiles, for dating changes; this session's naming delays; when the last
	// change was dated (the next one's strum comes after it).
	let strums: number[] = []
	let chromas: { at: number; chroma: Float32Array }[] = []
	let namingDelays: number[] = []
	let lastDated = -Infinity
	let clean = 0
	// A speed-up waits for the next chord's first beat, so a slot never changes tempo halfway.
	let pendingBpm = 0
	let clicking = false
	// performance.now() of the last click heard (Metronome.onBeat fires then).
	let lastClickAt = -Infinity

	const running = () => phase === 'countin' || phase === 'running'

	function start(next: SessionConfig, now: number) {
		config = next
		counter = Changes.createChangeCounter(config.sequence)
		marks = []
		offsets = []
		pending = []
		onsets = []
		strums = []
		chromas = []
		namingDelays = []
		lastDated = -Infinity
		clean = 0
		pendingBpm = 0
		slot = -1
		if (config.mode === 'minute') {
			goAt = now + (config.countIn ? COUNT_IN_S * 1000 : 0)
			phase = config.countIn ? 'countin' : 'running'
			if (phase === 'running') begin(now)
			else ui.announce(`Get ready on ${config.sequence[0]}`, true)
			return
		}
		// Accent each chord's first beat; nothing else of the Metronome tab's setup applies.
		metronome.configure({
			beats: config.beats,
			accents: [2, 1, 1, 1],
			subdivision: 1,
			sound: 'click',
			volume: config.volume,
			trainer: { enabled: false, step: 0, bars: 1, target: 0 },
		})
		metronome.setTempo(config.bpm)
		metronome.start()
		clicking = true
		phase = config.countIn ? 'countin' : 'running'
		ui.target(config.sequence[0], `then ${config.sequence[1]}`)
		ui.announce(`Play ${config.sequence[0]} on the first beat`, true)
	}

	/** One-minute: the clock starts; whatever is already ringing is the starting chord. */
	function begin(now: number) {
		phase = 'running'
		endsAt = now + config.seconds * 1000
		const ringing = stabilizer.current()
		if (ringing) counter.onChord({ symbol: ringing, at: now, fresh: true })
		showCounterTarget()
		ui.announce('Go', true)
	}

	function showCounterTarget() {
		const from = counter.at
		ui.target(counter.target(), from ? `from ${from}` : `Strum ${config.sequence[0]} to start`)
	}

	/** Ends the session; `finished` = ran its course (a One-minute result is stored). */
	function end(finished: boolean): SessionResult {
		if (clicking) metronome.stop()
		clicking = false
		phase = 'idle'
		if (config.mode === 'minute' && finished) {
			const count = counter.count
			// Nothing heard (mic too far, wrong chords) is not a session worth a place in the history.
			const before = count ? Changes.saveSession(config.sequence, config.seconds, count) : Changes.loadRecord(config.sequence, config.seconds)
			phase = 'done'
			return { mode: 'minute', count, before }
		}
		if (config.mode === 'time' && marks.length) {
			phase = 'done'
			return { mode: 'time', marks, bpm: metronome.getState().bpm || config.bpm }
		}
		return null
	}

	/** In time: a click heard (Metronome.onBeat); downbeats open the slots to judge. */
	function beat(event: Metronome.BeatEvent, now: number) {
		if (!clicking) return
		lastClickAt = now
		if (event.sub !== 0) return
		const lead = config.countIn ? COUNT_IN_BEATS : 0
		const index = event.bar * config.beats + event.beat
		if (index < lead) return ui.countIn(lead - index, config.sequence[0])
		ui.probe?.({ kind: 'beat', heardAt: event.heardAt, stampedAt: event.stampedAt })
		phase = 'running'
		ui.beat((index - lead) % config.beats)
		if ((index - lead) % config.beats) return
		if (pendingBpm) {
			// Takes effect from the next beat line: this chord's first beat is already scheduled.
			metronome.setTempo(pendingBpm)
			ui.announce(`Two clean passes. Up to ${pendingBpm} BPM.`, true)
			pendingBpm = 0
		}
		slot = (index - lead) / config.beats
		const seq = config.sequence
		const current = seq[slot % seq.length]
		ui.target(current, `then ${seq[(slot + 1) % seq.length]}`)
		ui.clock(`${event.bpm} BPM`)
		// The first chord is where the player starts, not a change.
		if (slot > 0) {
			pending.push({ downbeat: now, slotMs: (config.beats * 60000) / event.bpm, target: current })
			ui.probe?.({ kind: 'slot', downbeat: now, target: current })
		}
	}

	function judgeDue(now: number) {
		// A slot's window closes half a slot after its downbeat, but a chord that
		// started inside it is only confirmed (and backdated) up to
		// CONFIRM_MS later: wait for it.
		while (pending.length && now >= pending[0].downbeat + pending[0].slotMs / 2 + CONFIRM_MS) {
			const due = pending.shift()!
			const times = onsets.filter((o) => o.symbol === due.target).map((o) => o.at)
			const mark = Changes.judge(due.downbeat, due.slotMs, times)
			marks.push(mark)
			offsets.push(Changes.offset(due.downbeat, due.slotMs, times))
			ui.probe?.({ kind: 'judged', dt: offsets[offsets.length - 1], mark })
			ui.marked(marks, offsets, Changes.hitWindow(due.slotMs))
			if (!config.speedUp) continue
			const step = Changes.afterMark(clean, mark, config.sequence.length)
			clean = step.clean
			const bpm = pendingBpm || metronome.getState().bpm
			if (step.speedUp && bpm < Changes.MAX_BPM) pendingBpm = Math.min(Changes.MAX_BPM, bpm + Changes.SPEED_STEP)
		}
	}

	/** Mean pitch-class profile of the frames from CHROMA_FROM_MS to CHROMA_TO_MS after `at`; null if none. */
	function profileAfter(at: number): Float32Array | null {
		const frames = chromas.filter((c) => c.at >= at + CHROMA_FROM_MS && c.at <= at + CHROMA_TO_MS)
		if (!frames.length) return null
		const mean = new Float32Array(12)
		for (const { chroma } of frames) for (let i = 0; i < 12; i++) mean[i] += chroma[i] / frames.length
		return mean
	}

	/** In time: the strum that played `symbol`, named at `named`, or null (see STRUM_SEARCH_MS). */
	function strumOf(symbol: string, named: number): { at: number; matched: boolean } | null {
		const seq = config.sequence
		const before = seq[(seq.indexOf(symbol) - 1 + seq.length) % seq.length]
		const candidates = strums.filter((t) => t > lastDated && t >= named - STRUM_SEARCH_MS && t <= named - NAMING_MIN_MS)
		for (const t of candidates) {
			const profile = profileAfter(t)
			if (profile && Changes.chordShare(profile, symbol) > Changes.chordShare(profile, before)) return { at: t, matched: true }
		}
		const recent = candidates.filter((t) => t >= named - Changes.ATTACK_LEAD_MS).pop()
		return recent === undefined ? null : { at: recent, matched: false }
	}

	/**
	 * One mic frame: whether it was strummed, the chord heard (null = none) and
	 * the frame's pitch-class profile (null = too quiet or not given).
	 * True when a One-minute session's time just ran out (the view ends it).
	 */
	function frame(now: number, strum: boolean, symbol: string | null, chroma: Float32Array | null = null): boolean {
		const attack = strum && !(clicking && Math.abs(now - lastClickAt) <= CLICK_MASK_MS)
		const onset = stabilizer.feed(symbol, now, attack)
		ui.heard(stabilizer.current())
		if (config.mode === 'minute' && phase === 'countin') {
			if (now >= goAt) begin(now)
			else ui.countIn(Math.ceil((goAt - now) / 1000), config.sequence[0])
		} else if (config.mode === 'minute' && phase === 'running') {
			if (onset) {
				const outcome = counter.onChord(onset)
				if (outcome) showCounterTarget()
				if (outcome === 'change') ui.counted(counter.count)
			}
			const left = endsAt - now
			ui.clock(clockText(left))
			return left <= 0
		} else if (config.mode === 'time' && running()) {
			if (strum) {
				strums.push(now)
				ui.probe?.({ kind: 'strum', at: now })
			}
			if (chroma) chromas.push({ at: now, chroma })
			strums = strums.filter((t) => now - t < CONFIRM_MS + STRUM_SEARCH_MS)
			chromas = chromas.filter((c) => now - c.at < CHROMA_KEEP_MS)
			if (onset) {
				// Unmasked strums: one right on the click is masked above as the click, yet it is when the change was played.
				const struck = strumOf(onset.symbol, onset.at)
				// Flips of a ringing chord are not changes here either, unless a strum that sounds like the new chord played it.
				if (onset.fresh || struck?.matched) {
					if (struck) namingDelays.push(onset.at - struck.at)
					const naming = namingDelays.length >= 3 ? median(namingDelays) : RECOGNITION_LATENCY_MS
					const at = struck ? struck.at - STRUM_LATENCY_MS : onset.at - naming
					onsets.push({ ...onset, at })
					lastDated = at
					ui.probe?.({ kind: 'named', at: onset.at, symbol: onset.symbol, struck: struck?.at ?? null })
				}
			}
			onsets = onsets.filter((o) => now - o.at < ONSET_KEEP_MS)
			judgeDue(now)
		}
		return false
	}

	return {
		start,
		end,
		beat,
		frame,
		phase: () => phase,
		running,
		config: () => config,
		/** A finished session's result was dismissed (the setup changed). */
		dismiss() {
			phase = 'idle'
		},
		/** The mic stopped: forget the chord being followed. */
		resetHearing() {
			stabilizer = Changes.createStabilizer()
		},
	}
}
