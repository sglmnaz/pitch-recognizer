// Offline stand-ins for the Web Audio pieces the app uses (decoding, the
// biquad band-pass, AnalyserNode's spectrum), so scripts can run the app's
// real detection code on recordings and synthetic signals in Node.
import { spawnSync } from 'node:child_process'

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

/** In-place iterative radix-2 FFT; length must be a power of two. */
function fft(re: Float64Array, im: Float64Array) {
	const n = re.length
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1
		for (; j & bit; bit >>= 1) j ^= bit
		j ^= bit
		if (i < j) {
			;[re[i], re[j]] = [re[j], re[i]]
			;[im[i], im[j]] = [im[j], im[i]]
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const step = (-2 * Math.PI) / size
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < size / 2; k++) {
				const [wr, wi] = [Math.cos(step * k), Math.sin(step * k)]
				const [i, j] = [start + k, start + k + size / 2]
				const tr = wr * re[j] - wi * im[j]
				const ti = wr * im[j] + wi * re[j]
				re[j] = re[i] - tr
				im[j] = im[i] - ti
				re[i] += tr
				im[i] += ti
			}
		}
	}
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
}

export const CONDITIONS: Condition[] = [
	{ name: 'clean', highpassHz: 0, snrDb: Infinity, reverbSeconds: 0 },
	{ name: 'phone-good', highpassHz: 100, snrDb: 25, reverbSeconds: 0.3 },
	{ name: 'phone-mid', highpassHz: 150, snrDb: 15, reverbSeconds: 0.5 },
	{ name: 'phone-cheap', highpassHz: 250, snrDb: 10, reverbSeconds: 0.8 },
	// An electric guitar played unplugged: the string alone is ~30 dB quieter
	// than an acoustic, while the room noise stays what it is.
	{ name: 'unplugged', highpassHz: 150, snrDb: Infinity, reverbSeconds: 0.3, gainDb: -30, noiseRms: 0.0005 },
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
	if (condition.reverbSeconds > 0) out = reverb(out, sampleRate, condition.reverbSeconds)
	if (condition.highpassHz > 0) {
		out = biquad(biquad(out, sampleRate, 'highpass', condition.highpassHz), sampleRate, 'highpass', condition.highpassHz)
	}
	if (Number.isFinite(condition.snrDb) || condition.noiseRms) {
		const noiseRms = condition.noiseRms ?? rms(out) / 10 ** (condition.snrDb / 20)
		let state = seed
		const uniform = () => (state = (state * 16807) % 2147483647) / 2147483647
		out = out.map((x) => {
			// Box-Muller: Gaussian white noise.
			const gaussian = Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform())
			return x + noiseRms * gaussian
		})
	}
	return out
}

/** RMS of a sample range. */
export function rms(signal: Float32Array, from = 0, to = signal.length): number {
	let sum = 0
	for (let i = from; i < to; i++) sum += signal[i] * signal[i]
	return Math.sqrt(sum / Math.max(1, to - from))
}
