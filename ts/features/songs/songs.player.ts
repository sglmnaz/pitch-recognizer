// Trainer → Songs: plays a song, DOM-free (`npm run check:songs` drives it with
// a fake audio clock). One clock for everything: notes, clicks and the strip
// all follow the audio context's time, so they cannot drift apart. A coarse
// timer calls tick(), which schedules what falls in the next LOOKAHEAD seconds
// on that clock (as the metronome does, ts/core/metronome.ts). Song time is in
// seconds at 100%; the speed only stretches how long it takes.
import { quarterAt, slotIndexAt, timeline, type Song, type Timeline } from '../../music/song.ts'

const LOOKAHEAD = 0.15
// First sound a hair after Play, so the audio graph is ready.
const START_DELAY = 0.06
// A note rings its written length plus this, so legato lines join up.
const RELEASE = 0.05

export interface PlayerAudio {
	/** The audio clock, s. */
	now(): number
	/** From scheduled to heard: the output latency plus the user's Audio delay, s. */
	heardAfter(): number
	/** A note at audio time `at`, cut `length` s later; `bend` semitones pushed up just after the pick. */
	pluck(midi: number, at: number, length: number, volume: number, bend: number): void
	click(at: number, accented: boolean): void
	/** Silences everything scheduled or ringing. */
	stop(): void
}

export interface PlayerOptions {
	/** 25–200 (%). */
	speed: number
	/** Pluck plays the notes. */
	listen: boolean
	/** A click on every beat. */
	click: boolean
	/** One bar of clicks before playing from a stop. */
	countIn: boolean
	/** The tracks played together (indices into song.tracks). */
	tracks: number[]
}

interface NoteEvent {
	t: number
	midi: number
	length: number
	volume: number
	bend: number
}

// A hammer-on, pull-off or slide sounds the next note without a pick: quieter.
const LEGATO_VOLUME = 0.55
interface ClickEvent {
	t: number
	accented: boolean
}

/** Every note (not tied over) of the tracks played and every beat of the song, in time order, at 100%. */
function events(song: Song, tl: Timeline, tracks: number[]) {
	const notes: NoteEvent[] = []
	const clicks: ClickEvent[] = []
	// Several tracks together stay about as loud as one.
	const mix = 1 / Math.sqrt(Math.max(1, tracks.length))
	for (const track of tracks) notes.push(...trackNotes(song, tl, track, mix))
	for (const slot of tl.slots) {
		const bar = song.bars[slot.bar]
		const beat = 4 / bar.unit
		for (let k = 0; k * beat < slot.quarters - 1e-6; k++) clicks.push({ t: slot.start + k * beat * slot.secPerQuarter, accented: k === 0 })
	}
	notes.sort((a, b) => a.t - b.t)
	return { notes, clicks }
}

function trackNotes(song: Song, tl: Timeline, track: number, gain: number): NoteEvent[] {
	const notes: NoteEvent[] = []
	const bars = song.tracks[track]?.bars ?? []
	// Per string, the note sounding last: a tie lengthens it, a hammer-on or slide from it makes the next one legato.
	const last = new Map<number, { event: NoteEvent; tech?: string }>()
	for (const slot of tl.slots) {
		const spq = slot.secPerQuarter
		const written = bars[slot.bar] ?? []
		// Notes struck together share the loudness of one (1/sqrt(n)).
		const together = new Map<number, number>()
		for (const note of written) if (!note.tied) together.set(note.at, (together.get(note.at) ?? 0) + 1)
		for (const note of written) {
			const before = last.get(note.string)
			if (note.tied && before) {
				before.event.length += note.length * spq
				continue
			}
			if (note.tied) continue
			const legato = before?.tech && before.tech !== 'x' && before.event.t + before.event.length > slot.start + note.at * spq - 0.05
			const event: NoteEvent = {
				t: slot.start + note.at * spq,
				midi: note.midi,
				length: note.length * spq,
				volume: ((legato ? LEGATO_VOLUME : 1) * gain) / Math.sqrt(together.get(note.at)!),
				bend: note.bend ?? 0,
			}
			notes.push(event)
			last.set(note.string, { event, tech: note.tech })
		}
	}
	return notes
}

/** First index whose t is at or after `t`. */
function from<T extends { t: number }>(list: T[], t: number): number {
	let lo = 0
	let hi = list.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (list[mid].t < t - 1e-9) lo = mid + 1
		else hi = mid
	}
	return lo
}

export function createPlayer(song: Song, audio: PlayerAudio, initial: PlayerOptions, onEnd: () => void = () => {}) {
	const tl = timeline(song)
	let options = { ...initial }
	let list = events(song, tl, options.tracks)
	let playing = false
	// Song time `song` sounds (is scheduled) at audio time `at`. A loop going round
	// sets the next anchor ahead of time: until it is heard, the one before still says
	// where the song is.
	let anchor = { at: 0, song: 0 }
	let previous: typeof anchor | null = null
	// While stopped: where play() starts.
	let parked = 0
	// Count-in: the song starts at anchor.at; until then the strip waits.
	let scheduledTo = 0
	let nextNote = 0
	let nextClick = 0
	// A–B in slot indices (inclusive), and whether it loops.
	let loop: { a: number | null; b: number | null; on: boolean } = { a: null, b: null, on: false }

	const rate = () => options.speed / 100
	const songAt = (audioTime: number) => anchor.song + (audioTime - anchor.at) * rate()
	const audioAt = (songTime: number) => anchor.at + (songTime - anchor.song) / rate()
	const slotEnd = (i: number) => tl.slots[i].start + tl.slots[i].quarters * tl.slots[i].secPerQuarter
	const looping = () => loop.on && loop.a !== null && loop.b !== null
	const loopStart = () => tl.slots[loop.a!].start
	const loopEnd = () => slotEnd(loop.b!)

	/** Where the song is, as heard, in seconds at 100%. */
	function position(): number {
		if (!playing) return parked
		const heard = audio.now() - audio.heardAfter()
		if (heard < anchor.at) return previous ? previous.song + (heard - previous.at) * rate() : anchor.song
		return Math.min(tl.duration, songAt(heard))
	}

	function startAt(songTime: number, countIn: boolean) {
		audio.stop()
		let at = audio.now() + START_DELAY
		if (countIn) {
			// One bar of the meter and tempo the song is at there.
			const slot = tl.slots[slotIndexAt(tl, songTime)]
			const bar = song.bars[slot.bar]
			const beat = ((4 / bar.unit) * slot.secPerQuarter) / rate()
			for (let k = 0; k < bar.beats; k++) audio.click(at + k * beat, k === 0)
			at += bar.beats * beat
		}
		anchor = { at, song: songTime }
		previous = null
		scheduledTo = songTime
		nextNote = from(list.notes, songTime)
		nextClick = from(list.clicks, songTime)
		tick()
	}

	/** Schedules what the next LOOKAHEAD seconds hold; call it often (every ~25 ms) while playing. */
	function tick() {
		if (!playing) return
		const now = audio.now()
		// The loop's end or the song's: what comes after it is not this run's. After a
		// loop goes round the horizon is read again on the new anchor, or a whole round
		// would be scheduled at once and the strip would wait for it.
		for (let guard = 0; guard < 4; guard++) {
			const horizon = songAt(now + LOOKAHEAD)
			if (scheduledTo >= horizon) break
			const stop = looping() && scheduledTo < loopEnd() ? Math.min(horizon, loopEnd()) : Math.min(horizon, tl.duration)
			schedule(stop)
			if (looping() && stop >= loopEnd() - 1e-9) {
				// Round again: loopEnd sounds at this audio time, loopStart right then.
				previous = anchor
				anchor = { at: audioAt(loopEnd()), song: loopStart() }
				scheduledTo = loopStart()
				nextNote = from(list.notes, scheduledTo)
				nextClick = from(list.clicks, scheduledTo)
				continue
			}
			break
		}
		if (!looping() && audio.now() - audio.heardAfter() >= audioAt(tl.duration)) {
			playing = false
			parked = tl.duration
			onEnd()
		}
	}

	function schedule(to: number) {
		const { notes, clicks } = list
		for (; nextNote < notes.length && notes[nextNote].t < to - 1e-9; nextNote++) {
			const n = notes[nextNote]
			if (options.listen) audio.pluck(n.midi, audioAt(n.t), n.length / rate() + RELEASE, n.volume, n.bend)
		}
		for (; nextClick < clicks.length && clicks[nextClick].t < to - 1e-9; nextClick++) {
			const c = clicks[nextClick]
			if (options.click) audio.click(audioAt(c.t), c.accented)
		}
		scheduledTo = Math.max(scheduledTo, to)
	}

	function seek(songTime: number) {
		const to = Math.max(0, Math.min(tl.duration, songTime))
		if (playing) startAt(to >= tl.duration ? 0 : to, false)
		else parked = to
	}

	return {
		timeline: tl,
		playing: () => playing,
		position,
		/** Heard position in quarters from the top: where the strip stands. */
		quarter: () => quarterAt(tl, position()),
		/** The slot being heard (index into timeline.slots). */
		slot: () => slotIndexAt(tl, position()),
		/** True during the count-in. */
		countingIn: () => playing && audio.now() - audio.heardAfter() < anchor.at,
		play() {
			if (playing) return
			playing = true
			let at = parked >= tl.duration ? 0 : parked
			if (looping() && (at < loopStart() || at >= loopEnd())) at = loopStart()
			startAt(at, options.countIn)
		},
		pause() {
			if (!playing) return
			parked = position()
			playing = false
			audio.stop()
		},
		tick,
		seek,
		/** By bars as played (repeats unrolled), to the start of the bar: −1 = the bar before the one heard. */
		jumpBars(n: number) {
			const i = slotIndexAt(tl, position())
			seek(tl.slots[Math.max(0, Math.min(tl.slots.length - 1, i + n))].start)
		},
		/** By seconds of listening, at the speed set. */
		jumpSeconds(n: number) {
			seek(position() + n * rate())
		},
		setOptions(next: PlayerOptions) {
			const tracksChanged = next.tracks.join() !== options.tracks.join()
			const restart = playing && (next.speed !== options.speed || tracksChanged || next.listen !== options.listen || next.click !== options.click)
			const at = position()
			if (tracksChanged) list = events(song, tl, next.tracks)
			// The speed changes the clock: re-anchor where the song is now.
			if (restart) {
				options = next
				startAt(at, false)
			} else options = next
		},
		loop: () => ({ ...loop }),
		/** A or B at the bar being heard; again on a set mark clears it. */
		mark(which: 'a' | 'b') {
			const here = slotIndexAt(tl, position())
			loop = { ...loop, [which]: loop[which] === null ? here : null }
			if (loop.a !== null && loop.b !== null && loop.a > loop.b) loop = { ...loop, a: loop.b, b: loop.a }
			// Without both marks there is nothing to loop.
			loop.on = loop.on && loop.a !== null && loop.b !== null
		},
		/** Both marks at once (slot indices, null = none), in order; the loop stays as it was if it still can. */
		setMarks(a: number | null, b: number | null) {
			loop = a !== null && b !== null && a > b ? { ...loop, a: b, b: a } : { ...loop, a, b }
			loop.on = loop.on && loop.a !== null && loop.b !== null
		},
		setLooping(on: boolean) {
			loop.on = on && loop.a !== null && loop.b !== null
			if (loop.on && playing) {
				const at = position()
				if (at < loopStart() || at >= loopEnd()) seek(loopStart())
			}
		},
		stop() {
			playing = false
			audio.stop()
		},
	}
}

export type Player = ReturnType<typeof createPlayer>
