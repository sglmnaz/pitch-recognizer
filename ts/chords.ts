// Chord recognition from a magnitude spectrum with a small learned model
// (weights in ts/chord-model.ts, trained by scripts/chord-train.py on the
// benchmark's tune split) and HMM smoothing over time. Pure functions plus the
// smoother's state, so scripts/chord-check.ts and scripts/bench.ts run them in
// Node on synthetic strums and recordings.
//
// Pipeline, per analyser frame:
//  1. logSpectrum: the FFT resampled to 3 bins per semitone, level-normalised.
//  2. Harmonic stacking (Bittner et al., "A Lightweight Instrument-Agnostic
//     Model for Polyphonic Note Transcription", ICASSP 2022 — Basic Pitch):
//     the log spectrum read at sub-harmonics 1/5-1/2 and harmonics 1-7 of
//     every bin, so small kernels see a note's whole overtone series and the
//     lower notes it could be an overtone of.
//  3. Three convolutions along pitch, the same weights at every pitch (the note
//     model is transposition-equivariant), -> a salience per semitone C2..B6:
//     approximate transcription learned from GuitarSet's per-string note
//     annotations, the role of Mauch & Dixon's NNLS chroma (ISMIR 2010) and of
//     Korzeniowski & Widmer's deep chroma extractor (ISMIR 2016).
//  4. Chroma (noisy-OR of the saliences over octaves), a bass chroma (chance
//     that each note is the lowest one sounding) and per-pitch-class pooled
//     hidden features, rotated to each of the 12 roots and scored for the 8
//     chord types by one small MLP shared by all roots (so every root learns
//     from every key); a separate "no chord" logit. Softmax over 97 classes.
//  5. trackChord: HMM forward filtering over those 97 states with a uniform
//     switch probability (Cho & Bello, IEEE/ACM TASLP 22(2), 2014: enforcing
//     continuity is what matters, a musically informed transition matrix adds
//     little); online filtering adds no lag, unlike Viterbi decoding.
//
// Trained on the tune split only: GuitarSet players 00-01 (performed chord
// labels and per-string notes), IDMT-SMT-Guitar dataset4 "fast" takes and
// synthetic strums (scripts/chord-data.ts), all under the benchmark's phone
// conditions. 10.7k parameters, ~0.6 ms per frame in Node.
//
// The tuning reference `a4` (the tuner's A4 calibration) moves the
// log-frequency grid, so the model always sees notes on its semitone bins.
// The ~100 KB of weights load on first use (loadChordModel), not at app
// start-up, so the Tuner does not pay for parsing them.
type Model = typeof import('./chord-model.ts')

/** Pitch-class names as guitarists usually spell them. */
export const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

export interface ChordMatch {
	/** Display name, e.g. `C`, `Am`, `G7`. */
	name: string
	/** Pitch classes of the chord, root first. */
	notes: string[]
	/** Probability of this chord, in [0, 1]. */
	score: number
}

export interface ChordAnalysis {
	/** 12-bin learned chroma (C..B), chance that each pitch class sounds, in [0, 1]. */
	chroma: number[]
	/** Best-matching chord, or null when no chord is clearly being played. */
	chord: ChordMatch | null
}

// Chord types as intervals above the root, in the model's output order.
const CHORD_TYPES: { suffix: string; intervals: number[] }[] = [
	{ suffix: '', intervals: [0, 4, 7] },
	{ suffix: 'm', intervals: [0, 3, 7] },
	{ suffix: '7', intervals: [0, 4, 7, 10] },
	{ suffix: 'm7', intervals: [0, 3, 7, 10] },
	{ suffix: 'maj7', intervals: [0, 4, 7, 11] },
	{ suffix: '9', intervals: [0, 4, 7, 10, 2] },
	{ suffix: 'sus2', intervals: [0, 2, 7] },
	{ suffix: 'sus4', intervals: [0, 5, 7] },
]
// Log-odds added to each type before the softmax: a prior correction. The
// synthetic training takes play every type equally often, while 9 chords are
// rare in real playing, and a bright string's overtones spell a 9th (the
// fifth's 3rd harmonic) and a major 7th (the third's 3rd, the fifth's 5th),
// so the model leans to 9 and maj7. The values were chosen as the smallest
// that keep the dominant-7th voicings of scripts/chord-check.ts (synthetic)
// from reading as 9ths; the held-out recordings (scripts/chord-train.py
// --val) only confirmed that they move every score by < 1 point.
const TYPE_BIAS = [0, 0, 0, 0, -1, -1.75, 0, 0]
const TYPES = CHORD_TYPES.length
const CLASSES = 12 * TYPES + 1
const NONE = 12 * TYPES

// --- log-frequency front end -------------------------------------------------

// 3 bins per semitone, the CQT resolution of Basic Pitch and of NNLS chroma.
// MIDI 24 is the sub-harmonic of the lowest analysed note (C2, MIDI 36); 316
// bins reach the 7th harmonic of the highest one (B6, MIDI 95).
export const LOG_LOW_MIDI = 24
export const LOG_BINS_PER_SEMITONE = 3
export const LOG_BINS = 316
// dB below the loudest fundamental-range bin mapped to 0. Level-invariant
// (the input can be 36 dB quieter unplugged) and roughly a log compression,
// as standard in chroma features (Müller, FMP §3.1).
const LOG_RANGE_DB = 60
const LOG_NORM_FROM = (36 - LOG_LOW_MIDI) * LOG_BINS_PER_SEMITONE
const LOG_NORM_TO = (97 - LOG_LOW_MIDI) * LOG_BINS_PER_SEMITONE

let logTable: { binHz: number; length: number; a4: number; lo: Int32Array; hi: Int32Array; at: Float64Array } | null = null

/**
 * Log-frequency spectrum in [0, 1]: each bin takes the loudest FFT bin within
 * ±1/6 semitone of its centre, or the interpolated value where FFT bins are
 * coarser than that (below ~250 Hz at 2.7 Hz per bin). Bins sit on the
 * semitones of the tuning reference `a4` (the tuner's A4 calibration), so the
 * model names a guitar tuned to A = 432 Hz the same as one tuned to 440.
 */
export function logSpectrum(spectrumDb: Float32Array, binHz: number, a4 = 440, out = new Float32Array(LOG_BINS)): Float32Array {
	if (!logTable || logTable.binHz !== binHz || logTable.length !== spectrumDb.length || logTable.a4 !== a4) {
		const lo = new Int32Array(LOG_BINS)
		const hi = new Int32Array(LOG_BINS)
		const at = new Float64Array(LOG_BINS)
		for (let j = 0; j < LOG_BINS; j++) {
			const k = (a4 * 2 ** ((LOG_LOW_MIDI + j / LOG_BINS_PER_SEMITONE - 69) / 12)) / binHz
			at[j] = Math.min(k, spectrumDb.length - 2)
			lo[j] = Math.ceil(k * 2 ** (-1 / 72))
			hi[j] = Math.min(spectrumDb.length - 1, Math.floor(k * 2 ** (1 / 72)))
		}
		logTable = { binHz, length: spectrumDb.length, a4, lo, hi, at }
	}
	const { lo, hi, at } = logTable
	for (let j = 0; j < LOG_BINS; j++) {
		const i = Math.floor(at[j])
		// Clamped first: an empty analyser bin is -Infinity, and -Infinity minus -Infinity is NaN.
		const a = Math.max(spectrumDb[i], -200)
		let db = a + (at[j] - i) * (Math.max(spectrumDb[i + 1], -200) - a)
		for (let b = lo[j]; b <= hi[j]; b++) db = Math.max(db, spectrumDb[b])
		out[j] = db
	}
	let ref = -Infinity
	for (let j = LOG_NORM_FROM; j < LOG_NORM_TO; j++) ref = Math.max(ref, out[j])
	// Digital silence (an empty analyser) has nothing to normalise to.
	if (!(ref > -180)) return out.fill(0)
	for (let j = 0; j < LOG_BINS; j++) out[j] = Math.min(1, Math.max(0, 1 + (out[j] - ref) / LOG_RANGE_DB))
	return out
}

// --- model -------------------------------------------------------------------

const LOW_NOTE = 36
const NOTES = 60
const OCTAVES = NOTES / 12
const FINE = NOTES * LOG_BINS_PER_SEMITONE
const FIRST = (LOW_NOTE - LOG_LOW_MIDI) * LOG_BINS_PER_SEMITONE
// Sub-harmonics 1/5..1/2 show whether a peak is the 3rd, 4th or 5th harmonic
// of a lower note (an overtone, not a played note).
const HARMONICS = [1 / 5, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 5, 6, 7]
const OFFSETS = HARMONICS.map((h) => Math.round(LOG_BINS_PER_SEMITONE * 12 * Math.log2(h)))

/** 1-D convolution + ReLU over `length` positions, zero padding, as torch.nn.Conv1d. */
function conv(
	input: Float32Array,
	cin: number,
	length: number,
	weight: Float32Array,
	bias: Float32Array,
	cout: number,
	k: number,
	stride: number,
	pad: number,
	out: Float32Array
) {
	const outLength = Math.floor((length + 2 * pad - k) / stride) + 1
	for (let o = 0; o < cout; o++) {
		for (let t = 0; t < outLength; t++) {
			let sum = bias[o]
			const start = t * stride - pad
			for (let c = 0; c < cin; c++) {
				const w = (o * cin + c) * k
				const row = c * length
				for (let i = 0; i < k; i++) {
					const x = start + i
					if (x >= 0 && x < length) sum += weight[w + i] * input[row + x]
				}
			}
			out[o * outLength + t] = sum > 0 ? sum : 0
		}
	}
}

/** The loaded weights, their sizes and scratch buffers reused every frame (the loop runs at 60 Hz). */
function networkOf(M: Model) {
	const [C1, , K1] = M.SHAPE.conv1_weight
	const [C2, , K2] = M.SHAPE.conv2_weight
	const [C3, , K3] = M.SHAPE.conv3_weight
	const [HIDDEN, HEAD_IN] = M.SHAPE.head1_weight
	return {
		M,
		C1,
		K1,
		C2,
		K2,
		C3,
		K3,
		HIDDEN,
		HEAD_IN,
		NONE_HIDDEN: M.SHAPE.none1_weight[0],
		logBuffer: new Float32Array(LOG_BINS),
		stacked: new Float32Array(HARMONICS.length * FINE),
		hidden1: new Float32Array(C1 * FINE),
		hidden2: new Float32Array(C2 * NOTES),
		hidden3: new Float32Array(C3 * NOTES),
		pooled: new Float32Array(C3 * 12),
		headInput: new Float32Array(HEAD_IN),
		headHidden: new Float32Array(HIDDEN),
		logits: new Float64Array(CLASSES),
	}
}

let network: ReturnType<typeof networkOf> | null = null
let loading: Promise<void> | null = null
// A failed load (offline before the chunk was cached) must not be cached
// forever: it is retried, but at most every RETRY_MS since the trackers call
// this every frame, and logged only once.
const RETRY_MS = 5000
let failedAt = -Infinity
let failureLogged = false

/**
 * Loads the weights (once). Until it resolves, recognizeChord and the trackers
 * answer "no chord" (and start the load themselves), so a caller in the rAF
 * loop simply skips frames instead of throwing. Failures are logged here:
 * callers only need to swallow the rejection.
 */
export function loadChordModel(): Promise<void> {
	if (!loading && performance.now() - failedAt < RETRY_MS) return Promise.reject(new Error('chord model unavailable'))
	loading ??= import('./chord-model.ts').then(
		(M) => {
			network = networkOf(M)
		},
		(error) => {
			loading = null
			failedAt = performance.now()
			if (!failureLogged) console.error('chord model failed to load', error)
			failureLogged = true
			throw error
		}
	)
	return loading
}

/** True once loadChordModel has resolved. */
export function chordModelReady(): boolean {
	return network !== null
}

/** Log-probabilities of the 97 classes (root * 8 + type, then "no chord") and the chroma; null until the model has loaded. */
function classify(spectrumDb: Float32Array, binHz: number, a4: number): { logp: Float64Array; chroma: number[] } | null {
	if (!network) {
		loadChordModel().catch(() => {})
		return null
	}
	const { M, C1, K1, C2, K2, C3, K3, HIDDEN, HEAD_IN, NONE_HIDDEN, logBuffer, stacked, hidden1, hidden2, hidden3, pooled, headInput, headHidden, logits } =
		network
	const v = logSpectrum(spectrumDb, binHz, a4, logBuffer)
	OFFSETS.forEach((offset, h) => {
		for (let t = 0; t < FINE; t++) {
			const j = FIRST + t + offset
			stacked[h * FINE + t] = j >= 0 && j < LOG_BINS ? v[j] : 0
		}
	})
	conv(stacked, HARMONICS.length, FINE, M.conv1_weight, M.conv1_bias, C1, K1, 1, (K1 - 1) / 2, hidden1)
	conv(hidden1, C1, FINE, M.conv2_weight, M.conv2_bias, C2, K2, LOG_BINS_PER_SEMITONE, 1, hidden2)
	conv(hidden2, C2, NOTES, M.conv3_weight, M.conv3_bias, C3, K3, 1, (K3 - 1) / 2, hidden3)

	const p = new Float64Array(NOTES)
	for (let n = 0; n < NOTES; n++) {
		let sum = M.salience_bias[0] + M.note_bias[n]
		for (let c = 0; c < C3; c++) sum += M.salience_weight[c] * hidden3[c * NOTES + n]
		p[n] = 1 / (1 + Math.exp(-sum))
	}
	const chroma = new Array<number>(12).fill(1)
	const bass = new Array<number>(12).fill(0)
	let below = 1
	let total = 0
	let peak = 0
	for (let n = 0; n < NOTES; n++) {
		chroma[n % 12] *= 1 - p[n]
		bass[n % 12] += p[n] * below
		below *= 1 - p[n]
		total += p[n]
		peak = Math.max(peak, p[n])
	}
	for (let pc = 0; pc < 12; pc++) chroma[pc] = 1 - chroma[pc]
	for (let c = 0; c < C3; c++) {
		for (let pc = 0; pc < 12; pc++) {
			let max = 0
			for (let o = 0; o < OCTAVES; o++) max = Math.max(max, hidden3[c * NOTES + o * 12 + pc])
			pooled[c * 12 + pc] = max
		}
	}

	for (let root = 0; root < 12; root++) {
		for (let i = 0; i < 12; i++) {
			const pc = (root + i) % 12
			headInput[i] = chroma[pc]
			headInput[12 + i] = bass[pc]
			for (let c = 0; c < C3 && HEAD_IN > 24; c++) headInput[24 + c * 12 + i] = pooled[c * 12 + pc]
		}
		for (let h = 0; h < HIDDEN; h++) {
			let sum = M.head1_bias[h]
			for (let i = 0; i < HEAD_IN; i++) sum += M.head1_weight[h * HEAD_IN + i] * headInput[i]
			headHidden[h] = sum > 0 ? sum : 0
		}
		for (let q = 0; q < TYPES; q++) {
			let sum = M.head2_bias[q]
			for (let h = 0; h < HIDDEN; h++) sum += M.head2_weight[q * HIDDEN + h] * headHidden[h]
			logits[root * TYPES + q] = sum + TYPE_BIAS[q]
		}
	}
	const stats = [...[...chroma].sort((a, b) => b - a), ...[...bass].sort((a, b) => b - a), total, peak]
	let none = M.none2_bias[0]
	for (let h = 0; h < NONE_HIDDEN; h++) {
		let sum = M.none1_bias[h]
		for (let i = 0; i < stats.length; i++) sum += M.none1_weight[h * stats.length + i] * stats[i]
		if (sum > 0) none += M.none2_weight[h] * sum
	}
	logits[NONE] = none

	let max = -Infinity
	for (let k = 0; k < CLASSES; k++) max = Math.max(max, logits[k])
	let z = 0
	for (let k = 0; k < CLASSES; k++) z += Math.exp(logits[k] - max)
	const logp = new Float64Array(CLASSES)
	for (let k = 0; k < CLASSES; k++) logp[k] = logits[k] - max - Math.log(z)
	return { logp, chroma }
}

function matchOf(k: number, probability: number): ChordMatch | null {
	if (k === NONE) return null
	const root = Math.floor(k / TYPES)
	const { suffix, intervals } = CHORD_TYPES[k % TYPES]
	return { name: PITCH_CLASSES[root] + suffix, notes: intervals.map((i) => PITCH_CLASSES[(root + i) % 12]), score: probability }
}

/** Most likely chord in this one frame, no smoothing over time; `a4` is the tuning reference in Hz. */
export function recognizeChord(spectrumDb: Float32Array, binHz: number, a4 = 440): ChordAnalysis {
	const result = classify(spectrumDb, binHz, a4)
	if (!result) return { chroma: new Array(12).fill(0), chord: null }
	const { logp, chroma } = result
	let best = 0
	for (let k = 1; k < CLASSES; k++) if (logp[k] > logp[best]) best = k
	return { chroma, chord: matchOf(best, Math.exp(logp[best])) }
}

// --- smoothing over time ------------------------------------------------------

// HMM with a uniform chance of leaving the current chord, run as online
// forward filtering. Time-based, so the app's 60 Hz frames and the
// benchmark's 10 Hz ones behave alike: the switch chance grows with the frame
// gap, and each frame's evidence is tempered by its share of REFERENCE_MS
// (consecutive analyser frames overlap and are far from independent).
// NONE_BIAS (log units) is taken off "no chord" before smoothing: a quarter
// of the training frames are single-note lines and silence, so the model
// says "no chord" too readily under a real strum's decay; a fixed offset is
// the usual prior correction of hybrid NN-HMMs (Bourlard & Morgan,
// "Connectionist Speech Recognition", 1994, posteriors / priors).
// Tuned on held-out tune-split data (scripts/chord-train.py --val: GuitarSet
// player 01 and half the IDMT progressions, the model trained on the rest):
// see bench/README.md.
const SWITCH_PER_SECOND = 3.6
const EVIDENCE_POWER = 1.5
const NONE_BIAS = 1.5
const REFERENCE_MS = 100

export interface ChordTracker {
	/** recognizeChord smoothed over time: call once per analyser frame with its timestamp. */
	track(spectrumDb: Float32Array, binHz: number, timeMs: number, a4?: number): ChordAnalysis
	/** Forgets the chord being tracked (after a stretch of silence, or a new exercise). */
	reset(): void
}

/** An independent smoother, so two features (the Chords view, a trainer) never share state. */
export function createChordTracker(): ChordTracker {
	let belief: Float64Array | null = null
	let lastMs = 0
	return {
		reset() {
			belief = null
		},
		track(spectrumDb, binHz, timeMs, a4 = 440) {
			const result = classify(spectrumDb, binHz, a4)
			if (!result) return { chroma: new Array(12).fill(0), chord: null }
			const { logp, chroma } = result
			const dt = belief ? Math.min(timeMs - lastMs, 1000) : REFERENCE_MS
			lastMs = timeMs
			const prior = belief ?? new Float64Array(CLASSES).fill(1 / CLASSES)
			const stay = Math.exp((-SWITCH_PER_SECOND * dt) / 1000)
			const power = (EVIDENCE_POWER * dt) / REFERENCE_MS
			logp[NONE] -= NONE_BIAS
			let max = -Infinity
			for (let k = 0; k < CLASSES; k++) max = Math.max(max, logp[k])
			const next = new Float64Array(CLASSES)
			let sum = 0
			for (let k = 0; k < CLASSES; k++) {
				next[k] = Math.exp(power * (logp[k] - max)) * (stay * prior[k] + (1 - stay) / CLASSES)
				sum += next[k]
			}
			let best = 0
			for (let k = 0; k < CLASSES; k++) {
				next[k] /= sum
				if (next[k] > next[best]) best = k
			}
			belief = next
			return { chroma, chord: matchOf(best, next[best]) }
		},
	}
}

// The default tracker, used by the Chords view and the benchmark.
const defaultTracker = createChordTracker()
export const trackChord: ChordTracker['track'] = (spectrumDb, binHz, timeMs, a4) => defaultTracker.track(spectrumDb, binHz, timeMs, a4)
export const resetChordTracking = () => defaultTracker.reset()
