// Trainer → Tab: one session's state machine, DOM-free. Tempo: the shared
// metronome counts in one bar, then every note is due at its place in the
// beat and judged from what the mic heard around it. Wait: no clock, the
// session waits on each note until the mic hears it. The view feeds it beats
// and frames, asks where the tab stands and draws what it reports through
// `TabSessionUi`; `npm run check:tab` drives it with a fake clock and metronome.
import * as Tab from '../../music/tab.ts'
import type * as Metronome from '../../core/metronome.ts'

const COUNT_IN_BEATS = Tab.BEATS_PER_BAR
// Through a speaker the mic hears each click as an attack. One within this of
// the last click heard is the click, not a pick, or the note still ringing
// would count again on every beat (as in Changes) - unless the tab has the
// same note again right there: then it is the pick.
const CLICK_MASK_MS = 40
// A note is judged once nothing heard later can still be dated inside its
// window: the follower confirms a note STABLE_FRAMES frames after it starts,
// and backdates a legato one by LEGATO_LATENCY_MS.
const CONFIRM_MS = Tab.LEGATO_LATENCY_MS + 3 * 17
// Wait: a bend counts once its note has held this long.
const BEND_HOLD_MS = 120
// Readings and note starts older than this cannot matter to a note still due.
const KEEP_MS = 8000
// The tab keeps moving after the last beat for at most this many beats (a
// stalled timer must not run the strip ahead of the clicks).
const MAX_COAST_BEATS = 1.5

export type Follow = 'tempo' | 'wait'

/** Frozen at Start: a session runs on the settings it started with. */
export interface TabSessionConfig {
	exercise: Tab.TabExercise
	follow: Follow
	bpm: number
	loop: boolean
	speedUp: boolean
	/** The click volume (the Metronome tab's). */
	volume: number
	a4: number
}

export interface TabSessionUi {
	/** Tempo: count-in beats left. */
	countIn(left: number): void
	/** A note judged: its index in the exercise and every mark so far. */
	marked(index: number, mark: Tab.Mark, marks: Tab.Mark[]): void
	/** A loop through the exercise finished: how many so far, whether every note was on time. */
	looped(loops: number, clean: boolean): void
	/** Tempo: the tempo changed (speed up). */
	tempo(bpm: number): void
	/** Wait: the note waited on, and the last wrong note heard (null = none). */
	waiting(index: number, wrong: number | null): void
	announce(text: string, force?: boolean): void
}

export type MetronomeControl = Pick<typeof Metronome, 'configure' | 'setTempo' | 'start' | 'stop' | 'getState'>

export interface TabResult {
	follow: Follow
	marks: Tab.Mark[]
	loops: number
	/** Tempo: where the session ended and the fastest clean loop in it (0 = none). */
	bpm: number
	cleanBpm: number
}

type Phase = 'idle' | 'countin' | 'running' | 'done'

interface Due {
	index: number
	loop: number
	at: number
	midi: number
	stepMs: number
	/** Bends: when the time to reach the pitch runs out. */
	until?: number
	/** The same pitch as the note before: only its attack tells it apart. */
	repeat: boolean
}

const midiOfFrequency = (frequency: number, a4: number) => Math.round(69 + 12 * Math.log2(frequency / a4))

export function createTabSession(ui: TabSessionUi, metronome: MetronomeControl) {
	let phase: Phase = 'idle'
	let config: TabSessionConfig | null = null
	let follower = Tab.createNoteFollower()
	let events: Tab.NoteEvent[] = []
	let used = new Set<number>()
	let readings: { at: number; frequency: number }[] = []
	let marks: Tab.Mark[] = []
	let loops = 0
	let cleanLoops = 0
	let cleanBpm = 0
	// Tempo.
	let clicking = false
	let lastClickAt = -Infinity
	let clock: { index: number; at: number; beatMs: number } | null = null
	let due: Due[] = []
	// Per loop: notes still to judge and whether all so far were on time.
	let loopState = new Map<number, { left: number; clean: boolean; bpm: number }>()
	let pendingBpm = 0
	let lastLoop = Infinity
	// Wait.
	let target = 0
	let wrong: number | null = null
	let wrongCount = 0
	let bendSince: number | null = null

	const exercise = () => config!.exercise
	const loopBeats = () => exercise().steps / exercise().perBeat
	const running = () => phase === 'countin' || phase === 'running'

	function start(next: TabSessionConfig) {
		config = next
		follower = Tab.createNoteFollower()
		events = []
		used = new Set()
		readings = []
		marks = []
		loops = 0
		cleanLoops = 0
		cleanBpm = 0
		due = []
		loopState = new Map()
		pendingBpm = 0
		lastLoop = next.loop ? Infinity : 0
		clock = null
		target = 0
		wrong = null
		wrongCount = 0
		bendSince = null
		if (next.follow === 'wait') {
			phase = 'running'
			ui.waiting(0, null)
			ui.announce('Play the circled note', true)
			return
		}
		// Each bar's first beat accented; nothing else of the Metronome tab's setup applies.
		metronome.configure({
			beats: Tab.BEATS_PER_BAR,
			accents: [2, 1, 1, 1],
			subdivision: 1,
			sound: 'click',
			volume: next.volume,
			trainer: { enabled: false, step: 0, bars: 1, target: 0 },
		})
		metronome.setTempo(next.bpm)
		metronome.start()
		clicking = true
		phase = 'countin'
		ui.countIn(COUNT_IN_BEATS)
		ui.announce('One bar to count in', true)
	}

	function end(): TabResult | null {
		if (clicking) metronome.stop()
		clicking = false
		const had = config && marks.length
		phase = had ? 'done' : 'idle'
		if (!config || !had) return null
		return { follow: config.follow, marks, loops, bpm: config.follow === 'tempo' ? metronome.getState().bpm || config.bpm : 0, cleanBpm }
	}

	/** Tempo: a click heard (Metronome.onBeat). Opens the notes of that beat. */
	function beat(event: Metronome.BeatEvent, now: number) {
		if (!clicking || !config) return
		lastClickAt = now
		if (event.sub !== 0) return
		const index = event.bar * Tab.BEATS_PER_BAR + event.beat
		const beatMs = 60000 / event.bpm
		clock = { index, at: now, beatMs }
		if (index < COUNT_IN_BEATS) return ui.countIn(COUNT_IN_BEATS - index)
		phase = 'running'
		const b = index - COUNT_IN_BEATS
		const loop = Math.floor(b / loopBeats())
		if (loop > lastLoop) return
		const inLoop = b % loopBeats()
		if (inLoop === 0 && pendingBpm) {
			// Lands on the next beat: this one is already scheduled at the old tempo.
			metronome.setTempo(pendingBpm)
			ui.tempo(pendingBpm)
			ui.announce(`Two clean loops. Up to ${pendingBpm} BPM.`, true)
			pendingBpm = 0
		}
		const { perBeat, notes } = exercise()
		const stepMs = beatMs / perBeat
		if (inLoop === 0) loopState.set(loop, { left: notes.length, clean: true, bpm: event.bpm })
		notes.forEach((note, i) => {
			if (Math.floor(note.step / perBeat) !== inLoop) return
			const at = now + (note.step % perBeat) * stepMs
			const before = notes[(i || notes.length) - 1]
			const repeat = (i > 0 || loop > 0) && Tab.midiOf(before) === Tab.midiOf(note)
			due.push({ index: i, loop, at, midi: Tab.targetMidi(note), stepMs, repeat, ...(note.bend ? { until: at + (note.length ?? 1) * stepMs } : {}) })
		})
	}

	function settle(item: Due, mark: Tab.Mark) {
		marks.push(mark)
		ui.marked(item.index, mark, marks)
		const state = loopState.get(item.loop)
		if (!state) return
		state.left--
		if (mark !== 'hit') state.clean = false
		if (state.left > 0) return
		loopState.delete(item.loop)
		loops++
		ui.looped(loops, state.clean)
		if (!state.clean) {
			cleanLoops = 0
			return
		}
		cleanBpm = Math.max(cleanBpm, state.bpm)
		if (!config!.speedUp) return
		if (++cleanLoops < Tab.CLEAN_LOOPS) return
		cleanLoops = 0
		const bpm = pendingBpm || metronome.getState().bpm
		if (bpm < Tab.MAX_BPM) pendingBpm = Math.min(Tab.MAX_BPM, bpm + Tab.SPEED_STEP)
	}

	function judgeDue(now: number) {
		const a4 = config!.a4
		due.sort((x, y) => x.at - y.at)
		while (due.length) {
			const item = due[0]
			const { reach } = Tab.noteWindow(item.stepMs)
			if (item.until !== undefined) {
				if (now < item.until + CONFIRM_MS) break
				const reached = readings.some(
					(r) => r.at >= item.at - reach && r.at <= item.until! && Math.abs(Tab.centsTo(r.frequency, item.midi, a4)) <= Tab.BEND_CENTS
				)
				due.shift()
				settle(item, reached ? 'hit' : 'miss')
				continue
			}
			if (now < item.at + reach + CONFIRM_MS) break
			due.shift()
			settle(item, Tab.judgeNote(item.at, item.midi, item.stepMs, events, used))
		}
	}

	function advance(mark: Tab.Mark) {
		marks.push(mark)
		ui.marked(target, mark, marks)
		wrong = null
		wrongCount = 0
		bendSince = null
		target++
		if (target < exercise().notes.length) return ui.waiting(target, null)
		loops++
		const lastMarks = marks.slice(-exercise().notes.length)
		ui.looped(
			loops,
			lastMarks.every((m) => m === 'hit')
		)
		if (!config!.loop) return
		target = 0
		ui.waiting(0, null)
	}

	/**
	 * One mic frame: the frequency heard (null = none) and whether it was an
	 * attack. True when a session without loop has played its last note (the
	 * view ends it).
	 */
	function frame(now: number, frequency: number | null, attack: boolean): boolean {
		if (!config || !running()) return false
		const a4 = config.a4
		const onClick = clicking && Math.abs(now - lastClickAt) <= CLICK_MASK_MS
		const pick = attack && (!onClick || due.some((d) => d.repeat && Math.abs(d.at - now) <= CLICK_MASK_MS + Tab.ATTACK_LATENCY_MS))
		const event = follower.feed(now, frequency === null ? null : midiOfFrequency(frequency, a4), pick)
		if (config.follow === 'wait') {
			const note = exercise().notes[target]
			if (!note) return false
			const midi = Tab.targetMidi(note)
			if (note.bend) {
				const there = frequency !== null && Math.abs(Tab.centsTo(frequency, midi, a4)) <= Tab.BEND_CENTS
				bendSince = there ? (bendSince ?? now) : null
				if (bendSince !== null && now - bendSince >= BEND_HOLD_MS) advance(wrongCount ? 'miss' : 'hit')
			} else if (event) {
				if (event.midi === midi) advance(wrongCount ? 'miss' : 'hit')
				// The fretted note under a bend is on the way up, not a wrong note.
				else if (!(exercise().notes[target - 1]?.bend && event.midi < midi)) {
					wrong = event.midi
					wrongCount++
					ui.waiting(target, wrong)
				}
			}
			return !config.loop && target >= exercise().notes.length
		}
		if (event) events.push(event)
		if (frequency !== null) readings.push({ at: now, frequency })
		// Old entries go; `used` holds indexes, so trim both together.
		const keepFrom = events.findIndex((e) => now - e.at < KEEP_MS)
		if (keepFrom > 0) {
			events = events.slice(keepFrom)
			used = new Set([...used].map((i) => i - keepFrom).filter((i) => i >= 0))
		}
		if (readings.length && now - readings[0].at > KEEP_MS) readings = readings.filter((r) => now - r.at < KEEP_MS)
		judgeDue(now)
		// Without loop: done once the first loop's notes are all judged.
		return !config.loop && phase === 'running' && !due.length && loops >= 1
	}

	/**
	 * Where the tab stands, in steps from the top of the loop (negative during
	 * the count-in; it does not wrap, the view wraps it). Wait: the note waited on.
	 */
	function position(now: number): number {
		if (!config) return 0
		const { perBeat, notes } = exercise()
		if (config.follow === 'wait') return notes[Math.min(target, notes.length - 1)]?.step ?? 0
		if (!clock) return -COUNT_IN_BEATS * perBeat
		const coast = Math.min(MAX_COAST_BEATS, Math.max(0, (now - clock.at) / clock.beatMs))
		return (clock.index - COUNT_IN_BEATS + coast) * perBeat
	}

	return {
		start,
		end,
		beat,
		frame,
		position,
		phase: () => phase,
		running,
		config: () => config,
		/** A finished session's result was dismissed. */
		dismiss() {
			phase = 'idle'
		},
		/** The mic stopped: forget the note being followed. */
		resetHearing() {
			follower.reset()
		},
	}
}
