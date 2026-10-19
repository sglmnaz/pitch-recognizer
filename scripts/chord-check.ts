// Self-check for chord recognition: strums synthetic open-position guitar
// chords, takes the magnitude spectrum the way AnalyserNode does (Blackman
// window, dB) and asserts recognizeChord names them, that single notes,
// silence and noise are not named, and that the A4 reference is honoured.
// Run with `npm run check:chords`.
import { createChordTracker, loadChordModel, recognizeChord, resetChordTracking, trackChord } from '../ts/chords.ts'
import { spectrumDb as analyserSpectrum } from './audio.ts'

await loadChordModel()

const SAMPLE_RATE = 44100
const FFT_SIZE = 16384 // must match CHORD_FFT_SIZE in ts/microphone.ts

let seed = 5
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1

// Open-position voicings, low string to high, as MIDI notes.
const n = (midi: number, a4: number) => a4 * 2 ** ((midi - 69) / 12)
const VOICINGS: [string, number[]][] = [
	['C', [48, 52, 55, 60, 64]], // x32010
	['G', [43, 47, 50, 55, 59, 67]], // 320003
	['D', [50, 57, 62, 66]], // xx0232
	['A', [45, 52, 57, 61, 64]], // x02220
	['E', [40, 47, 52, 56, 59, 64]], // 022100
	['Am', [45, 52, 57, 60, 64]], // x02210
	['Em', [40, 47, 52, 55, 59, 64]], // 022000
	['Dm', [50, 57, 62, 65]], // xx0231
	['A7', [45, 52, 55, 61, 64]], // x02020
	['B7', [47, 51, 57, 59, 66]], // x21202
	['G7', [43, 47, 50, 55, 59, 65]], // 320001
	['F', [41, 48, 53, 57, 60, 65]], // 133211 barre
	// Barre majors, E and A shapes.
	['G', [43, 50, 55, 59, 62, 67]], // 355433
	['A', [45, 52, 57, 61, 64, 69]], // 577655
	['Bb', [46, 53, 58, 62, 65]], // x13331
	['C', [48, 55, 60, 64, 67]], // x35553
	// Barre minors, E and A shapes.
	['Fm', [41, 48, 53, 56, 60, 65]], // 133111
	['F#m', [42, 49, 54, 57, 61, 66]], // 244222
	['Bm', [47, 54, 59, 62, 66]], // x24432
	['Cm', [48, 55, 60, 63, 67]], // x35543
	['C#m', [49, 56, 61, 64, 68]], // x46654
	// Dominant 7ths, open and movable.
	['E7', [40, 47, 50, 56, 59, 64]], // 020100
	['D7', [50, 57, 60, 66]], // xx0212
	['C7', [48, 52, 58, 60, 64]], // x32310
	['F7', [41, 48, 51, 57, 60, 65]], // 131211
	['C7', [48, 55, 58, 64, 67]], // x35353
	['E7', [52, 59, 62, 68, 71]], // x79797
	// Minor and major 7ths.
	['Am7', [45, 52, 55, 60, 64]], // x02010
	['Em7', [40, 47, 52, 55, 62, 64]], // 022030
	['Dm7', [50, 57, 60, 65]], // xx0211
	['Bm7', [47, 54, 57, 62, 66]], // x24232
	['Cmaj7', [48, 52, 55, 59, 64]], // x32000
	['Fmaj7', [53, 57, 60, 64]], // xx3210
	['Amaj7', [45, 52, 56, 61, 64]], // x02120
	['Dmaj7', [50, 57, 61, 66]], // xx0222
	// Dominant 9ths.
	['E9', [40, 47, 50, 56, 59, 66]], // 020102
	['C9', [48, 52, 58, 62, 67]], // x32333
	// Suspended: same notes as another sus chord, told apart by the bass.
	['Dsus4', [50, 57, 62, 67]], // xx0233
	['Dsus2', [50, 57, 62, 64]], // xx0230
	['Asus4', [45, 52, 57, 62, 64]], // x02230
	['Asus2', [45, 52, 57, 59, 64]], // x02200
	['Esus4', [40, 47, 52, 57, 59, 64]], // 022200
]

/** Strum: each string plucked 15 ms after the previous, with real-ish partials. */
function strum(midis: number[], bright = false, a4 = 440, seconds = 0.6): Float32Array {
	const length = Math.round(seconds * SAMPLE_RATE)
	const out = new Float32Array(length)
	midis.forEach((midi, string) => {
		const f0 = n(midi, a4)
		const start = string * 0.015
		// Plucked at 1/7 of the string (|sin(kπ/7)|/k partials), or near the bridge
		// with slowly decaying overtones for a bright, overtone-heavy timbre.
		const partials = Array.from({ length: 10 }, (_, k) =>
			bright ? Math.abs(Math.sin(((k + 1) * Math.PI) / 12)) / Math.sqrt(k + 1) : Math.abs(Math.sin(((k + 1) * Math.PI) / 7)) / (k + 1),
		)
		const phases = partials.map(() => noise() * Math.PI)
		for (let i = Math.round(start * SAMPLE_RATE); i < length; i++) {
			const t = i / SAMPLE_RATE - start
			let s = 0
			partials.forEach((a, k) => {
				const h = k + 1
				const fh = h * f0 * Math.sqrt(1 + 1e-4 * h * h)
				s += a * Math.exp(-t * (1 + h * (bright ? 0.15 : 0.5))) * Math.sin(2 * Math.PI * fh * t + phases[k])
			})
			out[i] += 0.08 * s
		}
	})
	for (let i = 0; i < length; i++) out[i] += 0.002 * noise()
	return out
}

/** dB magnitude spectrum of the last FFT_SIZE samples, as AnalyserNode computes it. */
const spectrumDb = (signal: Float32Array) => analyserSpectrum(signal.subarray(signal.length - FFT_SIZE))

const binHz = SAMPLE_RATE / FFT_SIZE
// Bright strums are harder: overtones of each chord's fifth spell a major 7th
// and a 9th. The soft suite must pass in full. The bright one must not drop
// below what the learned recognizer scores (2026-10-19): two dominant 7ths
// (x79797 E7, as before, and the 131211 F7) still read as 9ths, which the
// benchmark's sevenths level counts as right anyway.
const MIN_PASSED = { soft: 45, bright: 43 }

let allOk = true
for (const bright of [false, true]) {
	const timbre = bright ? 'bright' : 'soft'
	let passed = 0
	for (const [expected, midis] of VOICINGS) {
		const { chroma, chord: match } = recognizeChord(spectrumDb(strum(midis, bright)), binHz)
		if (match?.name === expected) {
			passed++
			continue
		}
		const profile = chroma.map((c) => Math.round(c * 9)).join('')
		console.log(`FAIL ${bright ? 'bright' : 'soft  '} ${expected.padEnd(6)} -> ${(match?.name ?? '—').padEnd(6)} chroma C..B ${profile}`)
	}
	// A single note is not a chord.
	for (const midi of [40, 45, 52]) {
		const match = recognizeChord(spectrumDb(strum([midi], bright)), binHz).chord
		if (match === null) passed++
		else {
			console.log(`FAIL ${bright ? 'bright' : 'soft  '} single note ${midi} -> ${match.name}`)
		}
	}
	console.log(`${timbre.padEnd(6)} ${passed}/${VOICINGS.length + 3} passed (minimum ${MIN_PASSED[timbre]})`)
	if (passed < MIN_PASSED[timbre]) allOk = false
}

// Tuning reference: a guitar tuned to A = 432 or 466 Hz (the tuner's A4
// calibration) still plays C and Am; at 432 Hz read against 440 the strings
// sit 32 cents flat, at 466 Hz a whole semitone sharp.
for (const a4 of [432, 466]) {
	for (const [expected, midis] of [['C', [48, 52, 55, 60, 64]], ['Am', [45, 52, 57, 60, 64]]] as [string, number[]][]) {
		const match = recognizeChord(spectrumDb(strum(midis, false, a4)), binHz, a4).chord
		if (match?.name !== expected) {
			console.log(`FAIL A4 = ${a4} ${expected} -> ${match?.name ?? '—'}`)
			allOk = false
		}
	}
}

// Silence and noise are not chords.
const quiet = new Float32Array(FFT_SIZE)
const hiss = quiet.map(() => 0.01 * noise())
for (const [label, signal] of [['silence', quiet], ['white noise', hiss]] as [string, Float32Array][]) {
	const match = recognizeChord(spectrumDb(signal), binHz).chord
	if (match) {
		console.log(`FAIL ${label} -> ${match.name}`)
		allOk = false
	}
}

// The shipped path, as the Chords view drives it: trackChord on 60 Hz analyser
// frames (smoothing 0.8, like AnalyserNode), only while sound is playing, and
// a reset after 300 ms of silence. C, a pause, then Am: each must be named
// within 400 ms of its strum and still be named when it ends.
const HOP = Math.round(SAMPLE_RATE / 60)
const take = (parts: Float32Array[]) => {
	const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
	parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
	return out
}
const gap = new Float32Array(Math.round(0.5 * SAMPLE_RATE)).map(() => 1e-5 * noise())
const cStrum = strum([48, 52, 55, 60, 64], false, 440, 1.5)
const amStrum = strum([45, 52, 57, 60, 64], false, 440, 1.5)
const session = take([cStrum, gap, amStrum])
const segments = [
	{ name: 'C', from: 0, to: cStrum.length },
	{ name: 'Am', from: cStrum.length + gap.length, to: session.length },
]
/** Names per 60 Hz frame of `signal` from `tracker`, null where it is silent (not tracked). */
function trackFrames(signal: Float32Array, track: (spectrum: Float32Array, ms: number) => string | null, reset: () => void, sounding: (end: number) => boolean) {
	const state = { smoothing: 0.8 }
	const frames: { end: number; name: string | null }[] = []
	let silentSince: number | null = null
	for (let end = FFT_SIZE; end <= signal.length; end += HOP) {
		const spectrum = analyserSpectrum(signal.subarray(end - FFT_SIZE, end), state)
		const ms = (end / SAMPLE_RATE) * 1000
		if (sounding(end)) {
			silentSince = null
			frames.push({ end, name: track(spectrum, ms) })
		} else {
			silentSince ??= ms
			if (ms - silentSince >= 300) reset()
			frames.push({ end, name: null })
		}
	}
	return frames
}
resetChordTracking()
const sessionFrames = trackFrames(
	session,
	(spectrum, ms) => trackChord(spectrum, binHz, ms)?.chord?.name ?? null,
	resetChordTracking,
	(end) => segments.some((seg) => end > seg.from && end <= seg.to),
)
for (const seg of segments) {
	const inside = sessionFrames.filter((f) => f.end > seg.from && f.end <= seg.to)
	const first = inside.find((f) => f.name === seg.name)
	const latency = first ? ((first.end - seg.from) / SAMPLE_RATE) * 1000 : Infinity
	const last = inside[inside.length - 1]?.name
	const ok = latency <= 400 && last === seg.name
	console.log(`${ok ? 'ok  ' : 'FAIL'} trackChord ${seg.name}: first named after ${latency.toFixed(0)} ms, last frame ${last ?? '—'}`)
	if (!ok) allOk = false
}

// NONE_BIAS leans the tracker towards chords; a ringing single note (whose
// harmonics spell its own major triad) and noise must still not be named.
// Each runs on its own tracker, as a second feature would.
for (const [label, signal] of [
	['tracked E2', strum([40], false, 440, 1.5)],
	['tracked A2', strum([45], false, 440, 1.5)],
	['tracked noise', new Float32Array(Math.round(1.5 * SAMPLE_RATE)).map(() => 0.01 * noise())],
] as [string, Float32Array][]) {
	const tracker = createChordTracker()
	const frames = trackFrames(signal, (spectrum, ms) => tracker.track(spectrum, binHz, ms).chord?.name ?? null, tracker.reset, () => true)
	const named = frames.filter((f) => f.name !== null)
	if (named.length > 0.1 * frames.length) {
		console.log(`FAIL ${label}: named in ${named.length}/${frames.length} frames (${named[0].name})`)
		allOk = false
	}
}

if (!allOk) throw new Error('chord check failed')
console.log('all chord checks passed')
