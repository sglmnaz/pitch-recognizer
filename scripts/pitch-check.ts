// Self-check for the detection pipeline: feeds synthetic plucked-string
// signals through `processFrame` the way the rAF loop does and asserts the
// readings land on the right note, with no octave errors once the attack has
// passed. Run with `npm run check:pitch` (Node 24 strips the TS types).
import { FFT_SIZE, processFrame, stop, type PitchReading } from '../ts/core/microphone.ts'
import { appBand, degrade } from './audio.ts'

const SAMPLE_RATE = 44100
const HOP = Math.round(SAMPLE_RATE / 60) // one rAF frame
const SILENCE_S = 0.3
const NOTE_S = 1.2 // the synthetic pluck decays below MIN_VOLUME soon after
// Readings before this point (attack, onset blanking, median fill) are not judged.
const SETTLE_MS = 300

// Deterministic noise so a failure reproduces.
let seed = 1
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1

/**
 * Plucked string: decaying harmonics with stiff-string inharmonicity
 * (f_n = n·f0·√(1 + B·n²)), a short pick-noise burst and background noise.
 * The weak fundamental mimics a phone mic, which rolls off the low end.
 */
function pluck(f0: number, glitch = false, level = 0.15, amplitudes = [0.25, 1, 0.7, 0.5, 0.35, 0.25, 0.15, 0.1]): Float32Array {
	const inharmonicity = 0.0001
	const total = Math.round((SILENCE_S + NOTE_S) * SAMPLE_RATE)
	const out = new Float32Array(total)
	for (let i = Math.round(SILENCE_S * SAMPLE_RATE); i < total; i++) {
		const t = i / SAMPLE_RATE - SILENCE_S
		let sample = 0
		amplitudes.forEach((a, k) => {
			const n = k + 1
			const fn = n * f0 * Math.sqrt(1 + inharmonicity * n * n)
			sample += a * Math.exp(-t * (1 + n * 0.4)) * Math.sin(2 * Math.PI * fn * t + n)
		})
		sample *= level
		sample += 0.3 * Math.exp(-t / 0.008) * noise() // pick attack
		// Simulated octave glitch: 60 ms mid-note where only the 2nd harmonic sounds.
		if (glitch && t > 0.7 && t < 0.76) sample = 0.15 * Math.exp(-t * 1.8) * Math.sin(4 * Math.PI * f0 * t)
		out[i] = sample
	}
	for (let i = 0; i < total; i++) out[i] += 0.002 * noise()
	return out
}

function check(name: string, f0: number, glitch = false, level?: number, amplitudes?: number[]) {
	stop() // reset pipeline state between notes
	const signal = pluck(f0, glitch, level, amplitudes)
	const onsetMs = SILENCE_S * 1000
	let judged = 0
	let missing = 0
	let worst = 0
	let last = NaN

	for (let end = FFT_SIZE; end <= signal.length; end += HOP) {
		const now = (end / SAMPLE_RATE) * 1000
		const reading = processFrame(signal.subarray(end - FFT_SIZE, end), SAMPLE_RATE, now)
		if (now < onsetMs + SETTLE_MS) continue
		judged++
		if (!reading) {
			missing++
			continue
		}
		const cents = 1200 * Math.log2(reading.frequency / f0)
		worst = Math.max(worst, Math.abs(cents))
		last = cents
	}

	const ok = worst < 15 && missing / judged < 0.05
	console.log(
		`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} worst ${worst.toFixed(1).padStart(6)}¢  final ${last.toFixed(1).padStart(5)}¢  missing ${missing}/${judged}`
	)
	return ok
}

const strings: [string, number][] = [
	['E2 (6th)', 82.41],
	['A2 (5th)', 110],
	['D3 (4th)', 146.83],
	['G3 (3rd)', 196],
	['B3 (2nd)', 246.94],
	['E4 (1st)', 329.63],
	['C5', 523.25],
]

let allOk = true
for (const [name, f0] of strings) allOk = check(name, f0) && allOk
for (const [name, f0] of strings.slice(0, 3)) allOk = check(`${name} glitch`, f0, true) && allOk
// A quiet high E decaying close to the noise must keep reading (a fixed RMS
// gate used to cut the thin string while it was still clearly audible).
allOk = check('E4 quiet', 329.63, false, 0.04) && allOk
// Low E through a cheap phone mic: a real pluck spectrum (|sin(nπ/7)|/n)
// behind a 24 dB/octave roll-off at 250 Hz, i.e. the fundamental ~38 dB down
// (the benchmark's phone-cheap condition). It must still read E2, not E3.
// (An earlier version also suppressed the odd partials; real recordings never
// look like that, and tuning for it caused octave-down errors on acoustics.)
const phoneCheap = Array.from({ length: 8 }, (_, k) => {
	const n = k + 1
	const rolloff = ((n * 82.41) / 250) ** 4
	return ((Math.abs(Math.sin((n * Math.PI) / 7)) / n) * rolloff) / Math.sqrt(1 + rolloff * rolloff)
})
allOk = check('E2 phone-cheap', 82.41, false, 0.4, phoneCheap) && allOk

// Room noise alone, at any level, must never produce a note: the quiet-input
// gate leans on the adaptive noise floor and clarity, not on loudness.
for (const level of [0.0003, 0.002, 0.02]) {
	stop()
	const room = new Float32Array(SAMPLE_RATE * 4)
	for (let i = 0; i < room.length; i++) room[i] = level * Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random())
	let readings = 0
	for (let end = FFT_SIZE; end <= room.length; end += HOP) {
		if (processFrame(room.subarray(end - FFT_SIZE, end), SAMPLE_RATE, (end / SAMPLE_RATE) * 1000)) readings++
	}
	console.log(`${readings === 0 ? 'ok  ' : 'FAIL'} noise only ${level}  readings ${readings}`)
	allOk = readings === 0 && allOk
}
// Pink room noise (more rumble in the low end, like a real room), through the
// app's band-pass, at several levels: still never a note.
for (const level of [0.0005, 0.003, 0.02]) {
	stop()
	const room = degrade(
		new Float32Array(SAMPLE_RATE * 6),
		SAMPLE_RATE,
		{ name: 'room', highpassHz: 0, snrDb: Infinity, reverbSeconds: 0, noiseRms: level, pinkNoise: true },
		7
	)
	const banded = appBand(room, SAMPLE_RATE)
	let readings = 0
	for (let end = FFT_SIZE; end <= banded.length; end += HOP) {
		if (processFrame(banded.subarray(end - FFT_SIZE, end), SAMPLE_RATE, (end / SAMPLE_RATE) * 1000)) readings++
	}
	console.log(`${readings === 0 ? 'ok  ' : 'FAIL'} pink noise ${level}  readings ${readings}`)
	allOk = readings === 0 && allOk
}

// Unplugged electric: a long-sustaining string, no body (dipole roll-off below
// 300 Hz), 31 dB down over pink room noise. The needle must follow the low E
// for over a second, not freeze as soon as the note nears the noise.
{
	stop()
	const string = new Float32Array(SAMPLE_RATE * 4)
	for (let i = Math.round(0.5 * SAMPLE_RATE); i < string.length; i++) {
		const t = i / SAMPLE_RATE - 0.5
		let s = 0
		for (let n = 1; n <= 12; n++) {
			s +=
				(Math.abs(Math.sin((n * Math.PI) / 9)) / n) *
				Math.exp(-t / (1.6 / (1 + 0.15 * n))) *
				Math.sin(2 * Math.PI * n * 82.41 * Math.sqrt(1 + 1e-4 * n * n) * t + n)
		}
		string[i] = 0.3 * s
	}
	const unplugged = degrade(
		string,
		SAMPLE_RATE,
		{ name: 'unplugged', highpassHz: 100, snrDb: Infinity, reverbSeconds: 0.3, gainDb: -31, noiseRms: 0.0008, sourceHighpassHz: 300, pinkNoise: true },
		3
	)
	const banded = appBand(unplugged, SAMPLE_RATE)
	let correct = 0
	for (let end = FFT_SIZE; end <= banded.length; end += HOP) {
		const reading = processFrame(banded.subarray(end - FFT_SIZE, end), SAMPLE_RATE, (end / SAMPLE_RATE) * 1000)
		if (reading && Math.abs(1200 * Math.log2(reading.frequency / 82.41)) < 50) correct++
	}
	const seconds = (correct * HOP) / SAMPLE_RATE
	const ok = seconds >= 1
	console.log(`${ok ? 'ok  ' : 'FAIL'} unplugged E2 sustain  ${seconds.toFixed(2)}s read (min 1.00s)`)
	allOk = ok && allOk
}

// A tone already sounding when listening starts must not be learned as
// background noise and gated out.
{
	stop()
	const tone = new Float32Array(SAMPLE_RATE * 3)
	for (let i = 0; i < tone.length; i++) tone[i] = 0.15 * (((i / SAMPLE_RATE) * 110) % 1) * 2 - 0.15
	let reading: PitchReading | null = null
	for (let end = FFT_SIZE; end <= tone.length; end += HOP) {
		reading = processFrame(tone.subarray(end - FFT_SIZE, end), SAMPLE_RATE, (end / SAMPLE_RATE) * 1000)
	}
	const ok = reading !== null && Math.abs(1200 * Math.log2(reading.frequency / 110)) < 5
	console.log(`${ok ? 'ok  ' : 'FAIL'} tone from start ${reading ? `${reading.frequency.toFixed(2)} Hz` : 'no reading'}`)
	allOk = ok && allOk
}

if (!allOk) throw new Error('pitch check failed')
console.log('all pitch checks passed')
