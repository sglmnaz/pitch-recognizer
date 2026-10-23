// Trainer → Songs: a song as the player reads it, DOM-free (`npm run check:songs`).
// Bars carry their own meter and tempo; repeats and endings are unrolled into
// the order the song is played in (timeline), and every note sits in quarters
// from the start of its bar, so the strip is laid out in quarters and the
// clock maps them to seconds through each bar's tempo.

/** Standard tuning, MIDI per string, string 1 (high E) first. */
export const STANDARD_TUNING = [64, 59, 55, 50, 45, 40]
// Positions are looked for up to this fret.
const MAX_FRET = 20

export type Tech = 'h' | 'p' | '/' | '\\' | 'x'

export interface SongNote {
	/** Start, in quarter notes from the start of its bar. */
	at: number
	/** Length in quarter notes. */
	length: number
	/** 1 = high E. */
	string: number
	fret: number
	midi: number
	/** Hammer-on / pull-off to the next note, slide, dead note. */
	tech?: Tech
	/** Bent up this many semitones. */
	bend?: number
	/** Tied to the note before: drawn, not plucked again. */
	tied?: boolean
}

export interface SongBar {
	/** The meter: `beats` of 1/`unit` (2/2, 3/4, 6/8…). */
	beats: number
	unit: number
	/** Quarter notes per minute from the start of the bar. */
	tempo: number
	repeatStart?: boolean
	/** A closing repeat: the passage is played this many times. */
	repeatEnd?: number
	/** Volta brackets as a bit mask: bit 0 = ending 1, bit 1 = ending 2… */
	endings?: number
	/** A section starts here (Verse, Chorus, Canto…). */
	section?: string
}

export interface SongTrack {
	name: string
	/** MIDI per string, string 1 first. */
	tuning: number[]
	/** Notes per bar, in time order. */
	bars: SongNote[][]
}

export interface Song {
	id: string
	title: string
	artist: string
	bars: SongBar[]
	tracks: SongTrack[]
}

/** Quarter notes in a bar. */
export const barQuarters = (bar: SongBar) => (bar.beats * 4) / bar.unit

/**
 * The order the written bars are played in, repeats and volta endings
 * unrolled. A closing repeat sends the music back to its opening repeat (or
 * the start); the passage is played as many times as the repeat says, or as
 * many as its last ending number. On each pass a bar under a volta bracket is
 * played only if the bracket includes that pass.
 */
export function playOrder(bars: SongBar[]): number[] {
	const order: number[] = []
	let start = 0
	let pass = 1
	// The last repeat is done: its last ending may follow, then the next passage starts afresh.
	let closed = false
	let i = 0
	// ponytail: nested repeats and D.C./D.S. are not followed (a guard stops runaway loops).
	while (i < bars.length && order.length < 5000) {
		const bar = bars[i]
		if ((bar.repeatStart && i !== start) || (closed && !bar.endings)) {
			start = i
			pass = 1
			closed = false
		}
		if (bar.endings && !(bar.endings & (1 << (pass - 1)))) {
			i++
			continue
		}
		order.push(i)
		if (bar.repeatEnd) {
			let endings = 0
			for (let j = start; j < bars.length && (j <= i || bars[j].endings); j++) endings |= bars[j].endings ?? 0
			const times = Math.max(bar.repeatEnd, 32 - Math.clz32(endings))
			if (pass < times) {
				pass++
				i = start
				continue
			}
			closed = true
		}
		i++
	}
	return order
}

export interface Slot {
	/** The written bar (0-based). */
	bar: number
	/** Which time this bar comes round (1-based) and how many times it does. */
	pass: number
	passes: number
	/** Start in seconds at 100% and in quarters from the top of the song. */
	start: number
	quarter: number
	/** Length in quarters, and seconds per quarter at 100%. */
	quarters: number
	secPerQuarter: number
}

export interface Timeline {
	slots: Slot[]
	/** Seconds at 100%, and quarters. */
	duration: number
	quarters: number
}

export function timeline(song: Song): Timeline {
	const order = playOrder(song.bars)
	const passes = new Map<number, number>()
	for (const bar of order) passes.set(bar, (passes.get(bar) ?? 0) + 1)
	const seen = new Map<number, number>()
	const slots: Slot[] = []
	let start = 0
	let quarter = 0
	for (const bar of order) {
		const written = song.bars[bar]
		const pass = (seen.get(bar) ?? 0) + 1
		seen.set(bar, pass)
		const quarters = barQuarters(written)
		const secPerQuarter = 60 / written.tempo
		slots.push({ bar, pass, passes: passes.get(bar)!, start, quarter, quarters, secPerQuarter })
		start += quarters * secPerQuarter
		quarter += quarters
	}
	return { slots, duration: start, quarters: quarter }
}

/** The slot playing at `seconds` (at 100%), or the last one past the end. */
export function slotIndexAt(tl: Timeline, seconds: number): number {
	let lo = 0
	let hi = tl.slots.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (tl.slots[mid].start <= seconds) lo = mid
		else hi = mid - 1
	}
	return lo
}

/** Seconds (at 100%) → quarters from the top: where the strip stands. */
export function quarterAt(tl: Timeline, seconds: number): number {
	if (!tl.slots.length) return 0
	const slot = tl.slots[slotIndexAt(tl, seconds)]
	return slot.quarter + Math.min(slot.quarters, Math.max(0, (seconds - slot.start) / slot.secPerQuarter))
}

/** Quarters from the top → seconds (at 100%): the inverse of quarterAt, for a drag along the score. */
export function secondsAtQuarter(tl: Timeline, quarter: number): number {
	if (!tl.slots.length) return 0
	let lo = 0
	let hi = tl.slots.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (tl.slots[mid].quarter <= quarter) lo = mid
		else hi = mid - 1
	}
	const slot = tl.slots[lo]
	return slot.start + Math.min(slot.quarters, Math.max(0, quarter - slot.quarter)) * slot.secPerQuarter
}

/* Positions ---------------------------------------------------------------- */
// A file with notes but no tab (MusicXML of a score) needs a string and fret
// for each note. The left-hand fingering, where the score has it, says where
// the hand is: finger 0 = an open string, finger f on fret n = the hand in
// position n − f + 1. Without it, stay in the position the hand is in.

export interface Pitch {
	midi: number
	/** Left-hand finger: 0 open string, 1 index … 4 little; undefined = not given. */
	finger?: number
}

/**
 * A string and fret for every note of every beat (notes of a beat ring
 * together, so each on its own string). Unplayable notes get string 0.
 * ponytail: greedy, note by note, one hand position; a cost over the whole
 * phrase (dynamic programming) would pick better fingerings for fast runs.
 */
export function assignPositions(beats: Pitch[][], tuning = STANDARD_TUNING): { string: number; fret: number }[][] {
	// Fret under the index finger; 0 = not known yet.
	let hand = 0
	return beats.map((pitches) => {
		const used = new Set<number>()
		// The highest note first: it is the melody.
		const order = pitches.map((_, i) => i).sort((a, b) => pitches[b].midi - pitches[a].midi)
		const out: { string: number; fret: number }[] = []
		for (const i of order) {
			const { midi, finger } = pitches[i]
			let best = { string: 0, fret: -1 }
			let bestCost = Infinity
			let bestHand = hand
			tuning.forEach((open, s) => {
				const fret = midi - open
				if (fret < 0 || fret > MAX_FRET || used.has(s + 1)) return
				let cost: number
				let at = hand
				if (fret === 0) cost = finger === undefined || finger === 0 ? 0.5 : 20
				else {
					if (finger === 0) cost = 30 + fret
					else {
						at = finger ? Math.max(1, fret - finger + 1) : hand && fret >= hand && fret <= hand + 3 ? hand : fret
						cost = hand ? Math.abs(at - hand) : at / 4
					}
				}
				cost += fret * 0.01
				if (cost < bestCost) {
					bestCost = cost
					best = { string: s + 1, fret }
					bestHand = at
				}
			})
			if (best.string) used.add(best.string)
			if (best.fret > 0) hand = bestHand
			out[i] = best
		}
		return out
	})
}

/* Built-in songs, written compactly -----------------------------------------
 * Bars separated by `|`; in a bar, `duration:notes` tokens: duration 1 2 4 8 16
 * (whole … sixteenth), a dot for dotted; notes `string/fret` joined by `+` for
 * notes struck together, or `r` for a rest. "4:1/0 8.:2/3 16:2/1+3/2 4:r".
 * `quarters(bar)`, when given, is how long each bar must be: a bar that does
 * not add up throws.
 */
export function parseBars(text: string, quarters?: (bar: number) => number): SongNote[][] {
	return text.split('|').map((bar, index) => {
		let at = 0
		const notes: SongNote[] = []
		for (const token of bar.trim().split(/\s+/).filter(Boolean)) {
			const [duration, what] = token.split(':')
			if (!/^(1|2|4|8|16|32)\.?$/.test(duration) || !what) throw new Error(`Bad token "${token}"`)
			const length = (4 / Number.parseInt(duration, 10)) * (duration.endsWith('.') ? 1.5 : 1)
			if (what !== 'r')
				for (const note of what.split('+')) {
					const [string, fret] = note.split('/').map(Number)
					if (!(string >= 1 && string <= 6 && fret >= 0)) throw new Error(`Bad note "${note}"`)
					notes.push({ at, length, string, fret, midi: STANDARD_TUNING[string - 1] + fret })
				}
			at += length
		}
		// A bar that does not add up would shift every bar after it.
		if (quarters && Math.abs(at - quarters(index)) > 1e-9) throw new Error(`Bar ${index + 1} holds ${at} quarters, not ${quarters(index)}`)
		return notes
	})
}
