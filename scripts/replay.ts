// Replays a field report (Calibration → Diagnostics → Field report: the mic
// recording plus the session's timing log) to see what the phone heard:
//   node scripts/replay.ts <report.txt|json> <report.webm> [--fps 60]
// It lines the audio up with the log by the metronome clicks the mic recorded,
// finds the strums in the sound itself (the loud onsets), and runs the app's
// own front end on the recording (ts/core/microphone.ts processFrame, the
// Changes strum detector through Tab's held gate, Tab's pick detector) to
// count what each detector fires for every real strum, then places the
// changes by sound as Trainer → Changes In time does. Field data instead of
// guesses (docs/adr/0009).
//
// Environment:
//   A4=hz            the profiles on another reference than the session's
//   LOUDER=, LOUDER_MS=, BETTER=, BETTER_MS=, CLICK=louder|off
//                    the In time rules' knobs (defaults: changes.session.ts; LOUDER=off, BETTER=off drop a rule)
//   TUNE=1           a grid of strum-detector settings
//   PROFILES=1       the mean pitch-class profile of each chord as played
//   DUMP=n           the first n strums with their level and drill-chord shares
//   NOISE=1          how loud strums (and Tab's picks) still are AFTER ms on (default 100) over the noise floor
import { readFileSync } from 'node:fs'
import { appBand, decode } from './audio.ts'
import { FFT_SIZE, getFramePower, getStats, processFrame } from '../ts/core/microphone.ts'
import { chromaOf, createHeldGate, createOnsetDetector, newestEnergy } from '../ts/music/tab.ts'
import { chordShare, createStrumDetector, drillChord, MAX_FLATNESS, spectralFlatness } from '../ts/music/changes.ts'

const args = process.argv.slice(2)
const [jsonPath, audioPath] = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const fps = Number(args[args.indexOf('--fps') + 1]) || 60
if (!jsonPath || !audioPath) {
	console.log('usage: node scripts/replay.ts <report.txt|json> <report.webm> [--fps 60]')
	process.exit(1)
}

type Entry = { kind: string; [key: string]: unknown }
const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
	recordStartedAt: number
	entries: Entry[]
	micTrack?: { sampleRate?: number }
	settings: Record<string, unknown>
}
const SR = report.micTrack?.sampleRate ?? 48000
const audio = decode(audioPath, SR)
const band = appBand(audio, SR)
const ms = (samples: number) => (samples / SR) * 1000

/* Onsets in the sound: energy of 10 ms windows every 5 ms over the quietest of the 100 ms before. */
const HOP = Math.round(SR / 200)
const WIN = 2 * HOP
function onsets(signal: Float32Array, minStrength: number) {
	const env: number[] = []
	for (let i = WIN; i < signal.length; i += HOP) {
		let sum = 0
		for (let j = i - WIN; j < i; j++) sum += signal[j] * signal[j]
		env.push(sum / WIN)
	}
	const found: { at: number; strength: number }[] = []
	for (let i = 20; i < env.length; i++) {
		let quietest = Infinity
		for (let j = i - 20; j < i; j++) quietest = Math.min(quietest, env[j])
		const strength = env[i] / Math.max(quietest, 1e-12)
		if (strength < minStrength || env[i] < env[i - 1] * 1.5) continue
		const at = ms(WIN + i * HOP)
		const last = found[found.length - 1]
		// One event per 40 ms, its first frame kept with the strongest strength seen.
		if (last && at - last.at < 40) last.strength = Math.max(last.strength, strength)
		else found.push({ at, strength })
	}
	return found
}

/* Line up: the clicks are the onsets that fall one beat apart where the log says the beats were heard. */
const beats = report.entries.filter((e) => e.kind === 'beat').map((e) => (e.heardAt as number) - report.recordStartedAt)
const quiet = onsets(audio, 4)
let offset = { x: 0, matched: 0 }
// Within what the recorder's start can plausibly be off by: a wider search locks onto the clicks a beat or two away.
for (let x = -300; x <= 500; x += 2) {
	let matched = 0
	for (const b of beats) if (quiet.some((o) => Math.abs(o.at - (b + x)) < 12)) matched++
	if (matched > offset.matched) offset = { x, matched }
}
console.log(`audio ${(audio.length / SR).toFixed(1)} s at ${SR} Hz · ${beats.length} beats in the log`)
console.log(`clicks: audio = heardAt − recordStartedAt + ${offset.x} ms (${offset.matched} of ${beats.length} beats found as onsets)`)
/** A time of the session's log on the recording. */
const toAudio = (sessionTime: number) => sessionTime - report.recordStartedAt + offset.x

/* Real strums: loud guitar-band onsets, the first of each 150 ms. */
const strums: number[] = []
for (const o of onsets(band, 40)) if (!strums.length || o.at - strums[strums.length - 1] > 150) strums.push(o.at)
/** The real strum nearest `click`, within 400 ms. */
const nearestStrum = (click: number) => strums.filter((s) => Math.abs(s - click) < 400).sort((a, b) => Math.abs(a - click) - Math.abs(b - click))[0]

/* The app's front end on the recording, one frame every 1000/fps ms. */
const a4 = Number(process.env.A4) || Number(report.settings.a4) || 440
const picker = createOnsetDetector()
const strumDetector = createStrumDetector()
// As the Changes session: a strum counts once it rings (Tab.createHeldGate).
const held = createHeldGate()
let fired = 0
const appStrums: number[] = []
const picks: number[] = []
// Per frame: its level, the mic's learned noise floor (RMS), its newest energy, pitch-class profile and flatness.
const frames: { at: number; volume: number; floor: number; energy: number; chroma: Float32Array | null; flatness: number | null }[] = []
// Every pitched frame's cents off the nearest semitone on the session's A4: how the guitar is tuned.
const cents: number[] = []
const step = SR / fps
for (let end = FFT_SIZE; end <= band.length; end += step) {
	const at = ms(end)
	const frame = band.subarray(Math.round(end) - FFT_SIZE, Math.round(end))
	processFrame(frame, SR, at)
	const { volume, pitch, noiseFloor } = getStats()
	if (pitch > 0) cents.push(((((1200 * Math.log2(pitch / (Number(report.settings.a4) || 440)) + 50) % 100) + 100) % 100) - 50)
	const energy = newestEnergy(frame)
	if (picker.feed(at, energy)) picks.push(at)
	const strum = strumDetector.feed(at, energy)
	if (strum) fired++
	appStrums.push(...held.feed(at, strum, volume, noiseFloor))
	const power = getFramePower()
	frames.push({
		at,
		volume,
		floor: noiseFloor,
		energy,
		chroma: power ? chromaOf(power.power, power.binHz, a4) : null,
		flatness: power ? spectralFlatness(power.power, power.binHz) : null,
	})
}
console.log(`held: kept ${appStrums.length} of ${fired} strums`)

/** Mean pitch-class profile of the frames 40–200 ms after `t` (only those with pitch, as the session, when `tonal`); null if none. */
function profileAfter(t: number, tonal = false): Float32Array | null {
	const near = frames.filter((f) => f.chroma && f.at >= t + 40 && f.at <= t + 200 && (!tonal || (f.flatness !== null && f.flatness < MAX_FLATNESS)))
	if (!near.length) return null
	const mean = new Float32Array(12)
	for (const f of near) for (let i = 0; i < 12; i++) mean[i] += f.chroma![i] / near.length
	return mean
}
/** How loud a strum is: the peak level over its first 80 ms (changes.session.ts LOUD_MS). */
const loud = (t: number) => Math.max(0, ...frames.filter((f) => f.at >= t && f.at <= t + 80).map((f) => f.volume))
/** Level AFTER ms on over the noise floor at `t`. */
const heldOver = (t: number, after: number) => {
	const f = frames.find((x) => x.at >= t + after)
	const n = frames.find((x) => x.at === t)?.floor ?? Number.NaN
	return f ? f.volume / n : Number.NaN
}

/* What each detector fired per real strum (−100 … +300 ms from it), and away from any. */
function tally(name: string, fired: number[]) {
	const per = strums.map((s) => fired.filter((t) => t >= s - 100 && t <= s + 300))
	const counts = [0, 1, 2, 3].map((n) => per.filter((p) => (n < 3 ? p.length === n : p.length >= 3)).length)
	const lag = per.filter((p) => p.length).map((p) => p[0] - strums[per.indexOf(p)])
	const stray = fired.filter((t) => !strums.some((s) => t >= s - 100 && t <= s + 300)).length
	const median = [...lag].sort((a, b) => a - b)[lag.length >> 1]
	console.log(
		`${name.padEnd(22)} fired ${String(fired.length).padStart(4)} · per strum: none ${counts[0]}, once ${counts[1]}, twice ${counts[2]}, 3+ ${counts[3]} · away from strums ${stray} · first one after the strum, median ${median === undefined ? '–' : Math.round(median)} ms`
	)
}
console.log(`real strums in the sound: ${strums.length}`)
tally('Changes strum detector', appStrums)
tally('Tab pick detector', picks)

const slots = report.entries.filter((e) => e.kind === 'slot')
const sequence = report.settings.changesChords as string[]

/* The log: each judged change against the real strum nearest its click. */
if (slots.length) {
	const judged = report.entries.filter((e) => e.kind === 'judged')
	const real = judged.map((_, i) => {
		const click = toAudio(slots[i]?.downbeat as number)
		const near = nearestStrum(click)
		return near === undefined ? null : Math.round(near - click)
	})
	const truth = judged.flatMap((j, i) => (j.dt === null || real[i] === null ? [] : [real[i] - Math.round(j.dt as number)]))
	const sorted = [...truth].sort((a, b) => a - b)
	const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
	console.log(`changes: real strum − click vs the app's dt, difference (25/50/75%): ${q(0.25)} / ${q(0.5)} / ${q(0.75)} ms over ${truth.length}`)
	console.log(`real strum − click per change: ${real.map((r) => (r === null ? '–' : r)).join(' ')}`)
	console.log(`the app's dt per change:       ${judged.map((j) => (j.dt === null ? 'miss' : Math.round(j.dt as number))).join(' ')}`)
}

/* Each real change strum by its sound alone: the drill's chord its profile 40–200 ms on favours, against the chord due. */
if (slots.length) {
	let right = 0
	let none = 0
	const misses: string[] = []
	for (const slot of slots) {
		const truth = nearestStrum(toAudio(slot.downbeat as number))
		if (truth === undefined) continue
		const p = profileAfter(truth)
		if (!p) {
			none++
			continue
		}
		const shares = sequence.map((c) => chordShare(p, c))
		if (sequence[shares.indexOf(Math.max(...shares))] === slot.target) right++
		else misses.push(`${slot.target}: ${sequence.map((c, i) => `${c} ${shares[i].toFixed(2)}`).join(' ')}`)
	}
	console.log(`\nthe chord due, by each change strum's profile alone: right ${right} · wrong ${misses.length} · no profile ${none}`)
	for (const m of misses) console.log(`  wrong: ${m}`)
}

/* In time by sound alone, as changes.session.ts place() does: each strum's profile (frames with pitch) picks
   the drill's chord (Changes.drillChord); a change is a strum of a chord other than the one ringing, unless a
   strum LOUDER× as loud follows within LOUDER_MS (not where the mic hears a click, CLICK=louder), or one within
   BETTER_MS reads the same chord with BETTER more share. Clicks: the log's beats after the count-in, 22 ± 15 ms
   on (the session also knows the count-in's). Judged against the real strums. */
if (slots.length) {
	const louder = Number(process.env.LOUDER ?? 3)
	const louderMs = Number(process.env.LOUDER_MS ?? 300)
	const better = Number(process.env.BETTER ?? 0.1)
	const betterMs = Number(process.env.BETTER_MS ?? 700)
	const clickAt = beats.map((b) => b + offset.x + 22)
	const isClick = (t: number) => process.env.CLICK !== 'off' && clickAt.some((c) => Math.abs(t - c) <= 15)
	const chordAt = (t: number) => drillChord(profileAfter(t, true), sequence)
	const shareAt = (t: number, chord: string) => {
		const p = profileAfter(t, true)
		return p ? chordShare(p, chord) : 0
	}
	let playing: string | null = null
	const changes: { at: number; chord: string }[] = []
	for (const t of appStrums) {
		const chord = chordAt(t)
		if (!chord || chord === playing) continue
		if (appStrums.some((u) => u > t && u <= t + louderMs && !isClick(u) && loud(u) >= louder * loud(t))) continue
		const mine = shareAt(t, chord)
		if (appStrums.some((u) => u > t && u <= t + betterMs && chordAt(u) === chord && shareAt(u, chord) >= mine + better)) continue
		changes.push({ at: t, chord })
		playing = chord
	}
	const errors: (number | null)[] = []
	// As the player sees it: the change for each downbeat, ms off its click (hit within ±200 at these tempos).
	const fromClick: (number | null)[] = []
	for (const slot of slots) {
		const click = toAudio(slot.downbeat as number)
		const truth = nearestStrum(click)
		const change = changes.find((c) => c.chord === slot.target && Math.abs(c.at - click) < 1200)
		fromClick.push(change ? Math.round(change.at - click) : null)
		if (truth === undefined) continue
		errors.push(change ? Math.round(change.at - truth) : null)
	}
	const hits = fromClick.filter((d) => d !== null && Math.abs(d) <= 200).length
	console.log(`by sound, from the click: ${hits} of ${fromClick.length} within ±200 ms · ${fromClick.map((d) => (d === null ? '–' : d)).join(' ')}`)
	const off = errors.filter((e) => e === null || Math.abs(e) > 60).length
	console.log(`\nby sound alone: ${off} of ${errors.length} changes more than 60 ms off or not found: ${errors.map((e) => (e === null ? '–' : e)).join(' ')}`)
}

/* TUNE: strum detector candidates, tried on this recording: a jump in the energy of the newest samples over
   the quietest of the last LOOK ms and over the frame before, then nothing for REFRACTORY ms. */
if (process.env.TUNE) {
	for (const look of [60, 100]) {
		for (const rise of [2, 3, 4, 6, 10]) {
			for (const refractory of [80, 120]) {
				const fired: number[] = []
				let last = Number.NEGATIVE_INFINITY
				for (let i = 1; i < frames.length; i++) {
					const { at, energy } = frames[i]
					let quietest = Infinity
					for (let j = i - 1; j >= 0 && frames[j].at >= at - look; j--) quietest = Math.min(quietest, frames[j].energy)
					if (energy > rise * quietest && energy > 1.3 * frames[i - 1].energy && at - last >= refractory) {
						fired.push(at)
						last = at
					}
				}
				tally(`look ${look} rise ${rise} ref ${refractory}`, fired)
			}
		}
	}
}

/* PROFILES: the mean profile of each chord as played (strums from its downbeat to the next one), to see whether they differ at all. */
if (slots.length && process.env.PROFILES) {
	const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
	const byChord = new Map<string, Float32Array[]>()
	slots.forEach((slot, i) => {
		const from = toAudio(slot.downbeat as number) - 200
		const to = slots[i + 1] ? toAudio(slots[i + 1].downbeat as number) - 200 : from + 2000
		for (const t of strums.filter((s) => s >= from && s < to)) {
			const m = profileAfter(t)
			if (!m) continue
			const sum = m.reduce((a, b) => a + b, 0)
			for (let k = 0; k < 12; k++) m[k] /= sum
			const list = byChord.get(slot.target as string) ?? []
			list.push(m)
			byChord.set(slot.target as string, list)
		}
	})
	console.log(`\nmean profile per chord (%):   ${names.map((n) => n.padStart(3)).join(' ')}`)
	for (const [chord, list] of byChord) {
		const m = names.map((_, k) => list.reduce((a, p) => a + p[k], 0) / list.length)
		console.log(`${chord.padEnd(4)} (${String(list.length).padStart(3)} strums)          ${m.map((v) => String(Math.round(v * 100)).padStart(3)).join(' ')}`)
	}
}

/* DUMP: the first n app strums with their offset from the nearest click, level and drill-chord shares. */
if (slots.length && process.env.DUMP) {
	const clicks = beats.map((b) => b + offset.x)
	const downs = new Map(slots.map((s) => [Math.round(toAudio(s.downbeat as number)), s.target as string]))
	for (const t of appStrums.slice(0, Number(process.env.DUMP))) {
		const m = profileAfter(t, true)
		const click = clicks.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))
		const due = downs.get(Math.round(click))
		console.log(
			`${(t / 1000).toFixed(2).padStart(6)}s ${String(Math.round(t - click)).padStart(5)} ms ${due ? `▼${due.padEnd(3)}` : '    '} lvl ${loud(t).toFixed(4)} flat ${m ? '' : 'none'} ${sequence.map((c) => `${c} ${m ? chordShare(m, c).toFixed(2) : '-'}`).join(' ')}`
		)
	}
}

/* NOISE: how loud the sound still is AFTER ms on over the noise floor (Tab.createHeldGate's measure): a strum rings, a noise spike does not. */
if (process.env.NOISE) {
	const after = Number(process.env.AFTER ?? 100)
	const lowest = (v: number[], n: number) =>
		v
			.slice(0, n)
			.map((x) => x.toFixed(1))
			.join(' ')
	const ring = appStrums
		.filter((t) => strums.some((s) => Math.abs(t - s) < 60))
		.map((t) => heldOver(t, after))
		.filter(Number.isFinite)
		.sort((a, b) => a - b)
	console.log(`\nlevel ${after} ms on over the floor: real (${ring.length}) lowest 5: ${lowest(ring, 5)} · median ${ring[ring.length >> 1]?.toFixed(0)}`)
	// A Tab report: the picks nearest each note due.
	const dues = report.entries.filter((e) => e.kind === 'due').map((e) => toAudio(e.at as number))
	if (dues.length) {
		const notes = dues
			.map((d) => picks.filter((p) => Math.abs(p - d) <= 150).sort((a, b) => Math.abs(a - d) - Math.abs(b - d))[0])
			.filter((p) => p !== undefined)
			.map((p) => heldOver(p, after))
			.filter(Number.isFinite)
			.sort((a, b) => a - b)
		console.log(
			`tab: picks by the notes due (${notes.length} of ${dues.length}), level ${after} ms on over the floor, lowest 8: ${lowest(notes, 8)} · median ${notes[notes.length >> 1]?.toFixed(1)}`
		)
	}
}

{
	const sorted = [...cents].sort((a, b) => a - b)
	const at = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]?.toFixed(0)
	console.log(
		`\ntuning: ${cents.length} pitched frames, cents off the nearest semitone (A4 ${report.settings.a4}) 25/50/75%: ${at(0.25)} / ${at(0.5)} / ${at(0.75)}`
	)
}
