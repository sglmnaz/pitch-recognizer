// Self-check for chord recognition: strums synthetic open-position guitar
// chords, takes the magnitude spectrum the way AnalyserNode does (Blackman
// window, dB) and asserts recognizeChord names them. Run with
// `npm run check:chords`.
import { recognizeChord } from '../ts/chords.ts'

const SAMPLE_RATE = 44100
const FFT_SIZE = 16384 // must match CHORD_FFT_SIZE in ts/microphone.ts
const MAX_HZ = 1600 // only bins chromagram reads are computed

let seed = 5
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1

// Open-position voicings, low string to high, in Hz.
const n = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
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
function strum(midis: number[], bright = false): Float32Array {
	const length = Math.round(0.6 * SAMPLE_RATE)
	const out = new Float32Array(length)
	midis.forEach((midi, string) => {
		const f0 = n(midi)
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

/** dB magnitude spectrum of the last FFT_SIZE samples (naive DFT, low bins only). */
function spectrumDb(signal: Float32Array): Float32Array {
	const frame = signal.subarray(signal.length - FFT_SIZE)
	const bins = Math.ceil((MAX_HZ * FFT_SIZE) / SAMPLE_RATE) + 2
	const out = new Float32Array(FFT_SIZE / 2).fill(-200)
	const windowed = frame.map((x, i) => {
		const p = (2 * Math.PI * i) / FFT_SIZE
		return x * (0.42 - 0.5 * Math.cos(p) + 0.08 * Math.cos(2 * p)) // Blackman, as AnalyserNode
	})
	for (let k = 0; k < bins; k++) {
		let re = 0
		let im = 0
		const w = (2 * Math.PI * k) / FFT_SIZE
		for (let i = 0; i < FFT_SIZE; i++) {
			re += windowed[i] * Math.cos(w * i)
			im -= windowed[i] * Math.sin(w * i)
		}
		out[k] = 20 * Math.log10(Math.hypot(re, im) / FFT_SIZE + 1e-12)
	}
	return out
}

const binHz = SAMPLE_RATE / FFT_SIZE
// Bright strums are harder: overtones of each chord's fifth spell a major 7th
// and a 9th. The soft suite must pass in full; the bright one must not drop
// below what it scores today (C -> Cmaj7 and the x79797 E7 -> E9 still miss).
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

if (!allOk) throw new Error('chord check failed')
console.log('all chord checks passed')
