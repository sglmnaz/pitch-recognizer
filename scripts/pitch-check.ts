// Self-check for the detection pipeline: feeds synthetic plucked-string
// signals through `processFrame` the way the rAF loop does and asserts the
// readings land on the right note, with no octave errors once the attack has
// passed. Run with `npm run check:pitch` (Node 24 strips the TS types).
import { FFT_SIZE, processFrame, stop } from '../ts/microphone.ts'

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
		`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} worst ${worst.toFixed(1).padStart(6)}¢  final ${last.toFixed(1).padStart(5)}¢  missing ${missing}/${judged}`,
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
// Low E through a phone mic: fundamental ~30 dB down, odd partials weak. MPM
// alone reads this an octave high (E3); the subharmonic check must catch it.
allOk = check('E2 weak fund.', 82.41, false, 0.15, [0.03, 1, 0.22, 0.75, 0.14, 0.45, 0.08, 0.25]) && allOk

// A tone already sounding when listening starts must not be learned as
// background noise and gated out.
{
	stop()
	const tone = new Float32Array(SAMPLE_RATE * 3)
	for (let i = 0; i < tone.length; i++) tone[i] = 0.15 * (((i / SAMPLE_RATE) * 110) % 1) * 2 - 0.15
	let reading = null
	for (let end = FFT_SIZE; end <= tone.length; end += HOP) {
		reading = processFrame(tone.subarray(end - FFT_SIZE, end), SAMPLE_RATE, (end / SAMPLE_RATE) * 1000)
	}
	const ok = reading !== null && Math.abs(1200 * Math.log2(reading.frequency / 110)) < 5
	console.log(`${ok ? 'ok  ' : 'FAIL'} tone from start ${reading ? reading.frequency.toFixed(2) + ' Hz' : 'no reading'}`)
	allOk = ok && allOk
}

if (!allOk) throw new Error('pitch check failed')
console.log('all pitch checks passed')
