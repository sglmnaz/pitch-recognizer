// Offline stand-ins for the Web Audio pieces the app uses (decoding, the
// biquad band-pass, AnalyserNode's spectrum), so scripts can run the app's
// real detection code on recordings and synthetic signals in Node.
import { spawnSync } from 'node:child_process'
import { fft } from '../ts/fft.ts'
import { HIGHPASS_HZ, HIGHPASS_STAGES, LOWPASS_HZ } from '../ts/microphone.ts'

/** Decodes any audio file ffmpeg can read to mono float samples. */
export function decode(path: string, sampleRate: number): Float32Array {
	const result = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(sampleRate), '-'], {
		maxBuffer: 1 << 30,
	})
	if (result.status !== 0) throw new Error(`ffmpeg failed on ${path}: ${result.stderr}`)
	const bytes = result.stdout
	return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice()
}

/**
 * RBJ-cookbook biquad. Approximates Web Audio's BiquadFilterNode, whose
 * lowpass/highpass default Q (1 dB of resonance) is close to Butterworth's 0.707.
 */
export function biquad(signal: Float32Array, sampleRate: number, type: 'highpass' | 'lowpass', frequency: number): Float32Array {
	const w0 = (2 * Math.PI * frequency) / sampleRate
	const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
	const cos = Math.cos(w0)
	const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos)
	const b0 = type === 'lowpass' ? b1 / 2 : -b1 / 2
	const a0 = 1 + alpha
	const [nb0, nb1, nb2, na1, na2] = [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
	const out = new Float32Array(signal.length)
	let [x1, x2, y1, y2] = [0, 0, 0, 0]
	for (let i = 0; i < signal.length; i++) {
		const x = signal[i]
		const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2
		;[x2, x1, y2, y1] = [x1, x, y1, y]
		out[i] = y
	}
	return out
}

/** The app's high-pass stages (ts/microphone.ts), as Web Audio applies them. */
export function appHighpass(signal: Float32Array, sampleRate: number): Float32Array {
	let out = signal
	for (let stage = 0; stage < HIGHPASS_STAGES; stage++) out = biquad(out, sampleRate, 'highpass', HIGHPASS_HZ)
	return out
}

/** The app's whole pitch-path band-pass: high-pass stages then the low-pass. */
export function appBand(signal: Float32Array, sampleRate: number): Float32Array {
	return biquad(appHighpass(signal, sampleRate), sampleRate, 'lowpass', LOWPASS_HZ)
}

/**
 * dB magnitude spectrum of `frame` as AnalyserNode.getFloatFrequencyData
 * computes it: Blackman window, |X|/N, then optional smoothing over calls
 * (`state` carries the previous magnitudes, as smoothingTimeConstant does).
 */
export function spectrumDb(frame: Float32Array, state?: { magnitudes?: Float64Array; smoothing: number }): Float32Array {
	const n = frame.length
	const re = new Float64Array(n)
	const im = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const p = (2 * Math.PI * i) / n
		re[i] = frame[i] * (0.42 - 0.5 * Math.cos(p) + 0.08 * Math.cos(2 * p))
	}
	fft(re, im)
	const out = new Float32Array(n / 2)
	const previous = state?.magnitudes
	const smoothing = state?.smoothing ?? 0
	const magnitudes = new Float64Array(n / 2)
	for (let k = 0; k < n / 2; k++) {
		const magnitude = Math.hypot(re[k], im[k]) / n
		magnitudes[k] = previous ? smoothing * previous[k] + (1 - smoothing) * magnitude : magnitude
		out[k] = 20 * Math.log10(magnitudes[k] + 1e-12)
	}
	if (state) state.magnitudes = magnitudes
	return out
}

// Simulated playback conditions, so a benchmark on studio recordings says how
// the app copes with many phones, not one (the approach of lars76's pitch
// benchmark: background noise, reverberation and microphone filtering).
// Phone mics roll off the low end at different points — the low E sits at
// 82 Hz — so the high-pass varies most between profiles.
export interface Condition {
	name: string
	/** Microphone low-end roll-off (two cascaded biquads, 24 dB/octave), 0 = none. */
	highpassHz: number
	/** White noise at this signal-to-noise ratio, Infinity = none. */
	snrDb: number
	/** Room reverberation time (RT60), 0 = dry. */
	reverbSeconds: number
	/** Optional playing-level change and a fixed room-noise level (RMS), for quiet sources. */
	gainDb?: number
	noiseRms?: number
	/** Low-end roll-off of the source itself (12 dB/octave), before any noise is added. */
	sourceHighpassHz?: number
	/** Pink (1/f) room noise instead of white: more rumble in the low end, like a real room. */
	pinkNoise?: boolean
}

export const CONDITIONS: Condition[] = [
	{ name: 'clean', highpassHz: 0, snrDb: Infinity, reverbSeconds: 0 },
	{ name: 'phone-good', highpassHz: 100, snrDb: 25, reverbSeconds: 0.3 },
	{ name: 'phone-mid', highpassHz: 150, snrDb: 15, reverbSeconds: 0.5 },
	{ name: 'phone-cheap', highpassHz: 250, snrDb: 10, reverbSeconds: 0.8 },
	// An electric guitar played unplugged: no body, so only the strings radiate
	// (a thin vibrating string radiates as a dipole, losing ~12 dB per octave
	// downwards: the low strings almost vanish), ~36 dB quieter than an
	// acoustic, over pink room noise that is strongest in the low end.
	{ name: 'unplugged', highpassHz: 100, snrDb: Infinity, reverbSeconds: 0.3, gainDb: -36, noiseRms: 0.0008, sourceHighpassHz: 300, pinkNoise: true },
]

/**
 * Schroeder reverberator: four parallel feedback combs (gains set for the
 * RT60) into two allpasses, mixed 30 % wet. Cheap and deterministic.
 */
function reverb(signal: Float32Array, sampleRate: number, rt60: number): Float32Array {
	const wet = new Float32Array(signal.length)
	for (const ms of [29.7, 37.1, 41.1, 43.7]) {
		const delay = Math.round((ms / 1000) * sampleRate)
		const gain = 10 ** ((-3 * ms) / 1000 / rt60)
		const buffer = new Float32Array(signal.length)
		for (let i = 0; i < signal.length; i++) {
			buffer[i] = signal[i] + (i >= delay ? gain * buffer[i - delay] : 0)
			wet[i] += buffer[i] / 4
		}
	}
	for (const ms of [5, 1.7]) {
		const delay = Math.round((ms / 1000) * sampleRate)
		const input = wet.slice()
		for (let i = 0; i < signal.length; i++) {
			const x = i >= delay ? input[i - delay] : 0
			const y = i >= delay ? wet[i - delay] : 0
			wet[i] = -0.7 * input[i] + x + 0.7 * y
		}
	}
	return signal.map((x, i) => 0.7 * x + 0.3 * wet[i])
}

/** Applies a condition. Seeded noise, so every run hears exactly the same audio. */
export function degrade(signal: Float32Array, sampleRate: number, condition: Condition, seed = 1): Float32Array {
	let out = condition.gainDb ? signal.map((x) => x * 10 ** (condition.gainDb! / 20)) : signal
	if (condition.sourceHighpassHz) out = biquad(out, sampleRate, 'highpass', condition.sourceHighpassHz)
	if (condition.reverbSeconds > 0) out = reverb(out, sampleRate, condition.reverbSeconds)
	if (condition.highpassHz > 0) {
		out = biquad(biquad(out, sampleRate, 'highpass', condition.highpassHz), sampleRate, 'highpass', condition.highpassHz)
	}
	if (Number.isFinite(condition.snrDb) || condition.noiseRms) {
		const noiseRms = condition.noiseRms ?? rms(out) / 10 ** (condition.snrDb / 20)
		let state = seed
		const uniform = () => (state = (state * 16807) % 2147483647) / 2147483647
		// Box-Muller Gaussian white noise, optionally pinked (Paul Kellet's filter).
		const white = () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform())
		const noise = new Float32Array(out.length)
		let [b0, b1, b2, b3, b4, b5, b6] = [0, 0, 0, 0, 0, 0, 0]
		for (let i = 0; i < noise.length; i++) {
			const w = white()
			if (!condition.pinkNoise) {
				noise[i] = w
				continue
			}
			b0 = 0.99886 * b0 + w * 0.0555179
			b1 = 0.99332 * b1 + w * 0.0750759
			b2 = 0.969 * b2 + w * 0.153852
			b3 = 0.8665 * b3 + w * 0.3104856
			b4 = 0.55 * b4 + w * 0.5329522
			b5 = -0.7616 * b5 - w * 0.016898
			noise[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
			b6 = w * 0.115926
		}
		const scale = noiseRms / Math.max(rms(noise), 1e-12)
		out = out.map((x, i) => x + scale * noise[i])
	}
	return out
}

/** RMS of a sample range. */
export function rms(signal: Float32Array, from = 0, to = signal.length): number {
	let sum = 0
	for (let i = from; i < to; i++) sum += signal[i] * signal[i]
	return Math.sqrt(sum / Math.max(1, to - from))
}
