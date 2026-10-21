// Replays a field report (Calibration → Diagnostics → Field report: the mic
// recording plus the session's timing log) to see what the phone heard:
//   node scripts/replay.ts <report.json> <report.webm> [--fps 60]
// It lines the audio up with the log by the metronome clicks the mic recorded,
// finds the strums in the sound itself (the loud onsets), and runs the app's
// own front end on the recording (ts/core/microphone.ts processFrame, the
// Changes strum rule, Tab's pick detector) to count what each detector fires
// for every real strum. Field data instead of guesses (docs/adr/0009).
import { readFileSync } from 'node:fs'
import { appBand, decode } from './audio.ts'
import { FFT_SIZE, getStats, isSounding, processFrame } from '../ts/core/microphone.ts'
import { chromaOf, createOnsetDetector, newestEnergy } from '../ts/music/tab.ts'
import { chordShare, createStrumDetector } from '../ts/music/changes.ts'
import { getFramePower } from '../ts/core/microphone.ts'

const args = process.argv.slice(2)
const [jsonPath, audioPath] = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const fps = Number(args[args.indexOf('--fps') + 1]) || 60
if (!jsonPath || !audioPath) {
	console.log('usage: node scripts/replay.ts <report.json> <report.webm> [--fps 60]')
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

/* Real strums: loud guitar-band onsets, the first of each 150 ms. */
const strums: number[] = []
for (const o of onsets(band, 40)) if (!strums.length || o.at - strums[strums.length - 1] > 150) strums.push(o.at)

/* The app's front end on the recording, one frame every 1000/fps ms. */
const STRUM_RISE = 1.5
const STRUM_WINDOW_MS = 250
const STRUM_REFRACTORY_MS = 120
const picker = createOnsetDetector()
const strumDetector = createStrumDetector()
const appStrums: number[] = []
let levels: { at: number; volume: number }[] = []
let lastStrum = Number.NEGATIVE_INFINITY
const levelStrums: number[] = []
const attackStrums: number[] = []
const picks: number[] = []
// Per frame: its level and pitch-class profile (as the Changes view feeds the session).
const frames: { at: number; volume: number; chroma: Float32Array | null }[] = []
const a4 = Number(report.settings.a4) || 440
const newest: { at: number; energy: number }[] = []
const step = SR / fps
for (let end = FFT_SIZE; end <= band.length; end += step) {
	const at = ms(end)
	const frame = band.subarray(Math.round(end) - FFT_SIZE, Math.round(end))
	processFrame(frame, SR, at)
	const { reason, volume } = getStats()
	levels.push({ at, volume })
	levels = levels.filter((l) => l.at >= at - STRUM_WINDOW_MS)
	const quietest = Math.min(...levels.map((l) => l.volume))
	const attack = reason === 'attack'
	const rise = isSounding() && volume > STRUM_RISE * quietest
	if (attack || rise) {
		if (at - lastStrum >= STRUM_REFRACTORY_MS) (attack ? attackStrums : levelStrums).push(at)
		lastStrum = at
	}
	if (picker.feed(at, newestEnergy(frame))) picks.push(at)
	newest.push({ at, energy: newestEnergy(frame) })
	if (strumDetector.feed(at, newestEnergy(frame))) appStrums.push(at)
	const power = getFramePower()
	frames.push({ at, volume, chroma: power ? chromaOf(power.power, power.binHz, a4) : null })
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
tally(
	'old rule (before 10/21)',
	[...attackStrums, ...levelStrums].sort((a, b) => a - b)
)
tally('  of which attack state', attackStrums)
tally('  of which level rise', levelStrums)
tally('Tab pick detector', picks)

/* The log: each judged change against the real strum nearest its click. */
const slots = report.entries.filter((e) => e.kind === 'slot')
const judged = report.entries.filter((e) => e.kind === 'judged')
if (slots.length) {
	const truth: number[] = []
	for (const [i, j] of judged.entries()) {
		if (j.dt === null) continue
		const click = (slots[i]?.downbeat as number) - report.recordStartedAt + offset.x
		const near = strums.filter((s) => Math.abs(s - click) < 400).sort((a, b) => Math.abs(a - click) - Math.abs(b - click))[0]
		if (near !== undefined) truth.push(Math.round(near - click) - Math.round(j.dt as number))
	}
	const sorted = [...truth].sort((a, b) => a - b)
	const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
	console.log(`changes: real strum − click vs the app's dt, difference (25/50/75%): ${q(0.25)} / ${q(0.5)} / ${q(0.75)} ms over ${truth.length}`)
	const real = judged.map((_, i) => {
		const click = (slots[i]?.downbeat as number) - report.recordStartedAt + offset.x
		const near = strums.filter((s) => Math.abs(s - click) < 400).sort((a, b) => Math.abs(a - click) - Math.abs(b - click))[0]
		return near === undefined ? null : Math.round(near - click)
	})
	console.log(`real strum − click per change: ${real.map((r) => (r === null ? '–' : r)).join(' ')}`)
	console.log(`the app's dt per change:       ${judged.map((j) => (j.dt === null ? 'miss' : Math.round(j.dt as number))).join(' ')}`)
}

/* The same with the profiles: does a strum sound like the chord named, more than like the one before? */
if (slots.length) {
	const sequence = report.settings.changesChords as string[]
	const profileAfter = (t: number) => {
		const near = frames.filter((f) => f.chroma && f.at >= t + 40 && f.at <= t + 200)
		if (!near.length) return null
		const mean = new Float32Array(12)
		for (const f of near) for (let i = 0; i < 12; i++) mean[i] += f.chroma![i] / near.length
		return mean
	}
	const sounds = (t: number, chord: string) => {
		const before = sequence[(sequence.indexOf(chord) - 1 + sequence.length) % sequence.length]
		const p = profileAfter(t)
		return p !== null && chordShare(p, chord) > chordShare(p, before)
	}
	const loud = (t: number) => Math.max(0, ...frames.filter((f) => f.at >= t && f.at <= t + 80).map((f) => f.volume))
	const ruleFires = [...attackStrums, ...levelStrums].sort((a, b) => a - b)
	const named = report.entries.filter((e) => e.kind === 'named')
	const toAudio = (sessionTime: number) => sessionTime - report.recordStartedAt + offset.x
	for (const [name, fires] of [
		['old strum rule', ruleFires],
		['app strum detector', appStrums],
	] as const) {
		console.log(`strums from the ${name}:`)
		const rules = {
			// Before the field report: the first strum that sounds like the chord, up to 150 ms before the naming.
			firstSounding: (cands: number[], n: number, chord: string) =>
				cands.filter((t) => t <= n - 150).find((t) => sounds(t, chord)) ?? cands.filter((t) => t >= n - 800 && t <= n - 150).pop(),
			// The app (changes.session.ts strumOf): of those that sound like it, the first at least half as loud as the loudest.
			firstLoud: (cands: number[], n: number, chord: string) => {
				const ok = cands.filter((t) => t <= n + 100 && sounds(t, chord))
				const pool = ok.length ? ok : cands.filter((t) => t >= n - 800 && t <= n + 100)
				if (!pool.length) return undefined
				const top = Math.max(...pool.map(loud))
				return pool.find((t) => loud(t) >= top / 2)
			},
		}
		for (const [name, rule] of Object.entries(rules)) {
			let previous = Number.NEGATIVE_INFINITY
			const errors: number[] = []
			for (const slot of slots) {
				const click = toAudio(slot.downbeat as number)
				const naming = named.find((n) => n.symbol === slot.target && toAudio(n.at as number) > click - 1000 && toAudio(n.at as number) < click + 2000)
				const truth = strums.filter((s) => Math.abs(s - click) < 400).sort((a, b) => Math.abs(a - click) - Math.abs(b - click))[0]
				if (!naming || truth === undefined) continue
				const n = toAudio(naming.at as number)
				const chosen = rule(
					fires.filter((t) => t > previous && t >= n - 1500),
					n,
					slot.target as string
				)
				if (chosen === undefined) {
					errors.push(Number.NaN)
					continue
				}
				previous = chosen
				errors.push(Math.round(chosen - truth))
			}
			const off = errors.filter((e) => !(Math.abs(e) <= 60)).length
			console.log(
				`rule ${name.padEnd(16)} ${off} of ${errors.length} more than 60 ms off (or none): ${errors.map((e) => (Number.isNaN(e) ? '–' : e)).join(' ')}`
			)
		}
	}
}

/* Strum detector candidates, tried on this recording: a jump in the energy of the
   newest samples over the quietest of the last LOOK ms and over the frame before,
   then nothing for REFRACTORY ms (a plain refractory, not one that a sustained rise keeps extending). */
if (process.env.TUNE) {
	for (const look of [60, 100]) {
		for (const rise of [2, 3, 4, 6, 10]) {
			for (const refractory of [80, 120]) {
				const fired: number[] = []
				let last = Number.NEGATIVE_INFINITY
				for (let i = 1; i < newest.length; i++) {
					const { at, energy } = newest[i]
					let quietest = Infinity
					for (let j = i - 1; j >= 0 && newest[j].at >= at - look; j--) quietest = Math.min(quietest, newest[j].energy)
					if (energy > rise * quietest && energy > 1.3 * newest[i - 1].energy && at - last >= refractory) {
						fired.push(at)
						last = at
					}
				}
				tally(`look ${look} rise ${rise} ref ${refractory}`, fired)
			}
		}
	}
}
