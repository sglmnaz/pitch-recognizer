import { PitchDetector } from 'pitchy'

/** A single accepted pitch measurement. */
export interface PitchReading {
	/** Smoothed fundamental frequency in Hz. */
	frequency: number
	/** Pitchy clarity in [0, 1]; higher means more confidently pitched. */
	clarity: number
	/** RMS loudness in [0, 1]. */
	volume: number
}

export type ReadingCallback = (reading: PitchReading | null) => void
export type ErrorCallback = (error: unknown) => void

// Silence gate, relative to the room. A fixed RMS threshold cut thin strings
// (the high E radiates far less energy and decays fastest) while they were
// still clearly audible, so the gate tracks the background noise instead (see
// learnNoise). Signal must sit NOISE_MARGIN× (~10 dB) above it, and above
// MIN_VOLUME in any case.
// ponytail: pitched hum (mains harmonics) is never learned as noise, so hum
// louder than MIN_VOLUME reads as a note; learn hum that stays put for many
// seconds if that shows up in practice.
const MIN_VOLUME = 0.004
const NOISE_MARGIN = 3
const NOISE_FLOOR_RISE = 1.1

// Pitchy clarity below this is almost always noise rather than a real note.
// (Pitchy's own peak-picking constant k stays at its 0.9 default: McLeod's
// thesis, table 6.3, measures it among the lowest octave-error rates on real
// instrument recordings.)
const MIN_CLARITY = 0.9
// Voicing hysteresis: a note already being tracked keeps going down to this
// clarity while it decays into the noise, as long as the pitch stays put.
const SUSTAIN_CLARITY = 0.8
const SUSTAIN_CENTS = 50

// Analysis window. MPM needs ~2 periods of the lowest note to work at all;
// more periods sharpen the NSDF peaks and make the estimate less sensitive to
// noise. 4096 samples (~93 ms at 44.1 kHz) hold ~7.6 periods of the low E
// string (E2, 82 Hz) while keeping each pick attack — where most octave errors
// happen — inside the window as briefly as possible.
export const FFT_SIZE = 4096

// Chord recognition needs frequency resolution, not timing: 16384 samples
// (~370 ms) give 2.7 Hz bins, finer than a semitone from the low E (82 Hz,
// semitones ~5 Hz apart) up. A strummed chord rings long enough to fill it.
// The analyser's default smoothingTimeConstant (0.8) also averages successive
// spectra, steadying the chroma between strums.
const CHORD_FFT_SIZE = 16384

// Classic tuner front end: band-pass to the guitar range before detection
// (Lourde & Saji, "A Digital Guitar Tuner", use 75–1320 Hz). The high-pass
// removes rumble, handling noise and DC that pull the estimate toward
// octave-down errors; 60 Hz leaves E2 (and drop-D, D2 73 Hz) unattenuated. The
// low-pass trims pick and fret hiss while passing the first harmonics of every
// playable note.
const HIGHPASS_HZ = 60
const LOWPASS_HZ = 1400

// Fundamentals outside the guitar range are noise, not a string.
const MIN_FREQUENCY = 60
const MAX_FREQUENCY = 1400

// Octave-up check. MPM takes the first NSDF peak within k (0.9) of the highest,
// so when the fundamental is weak — phone mics roll off well above the low E's
// 82 Hz — the half-period peak of an even-harmonic-heavy waveform can pass
// and the reading lands an octave high (E2 shown as E3). For a waveform truly
// periodic at τ the NSDF peak at 2τ is no higher than at τ (decay and pitch
// drift only lower it); if it is clearly higher, the waveform only repeats
// every 2τ and the note is an octave below. Applied repeatedly, down to
// MIN_FREQUENCY.
const SUBHARMONIC_MARGIN = 0.02

// Pick attacks. Most octave errors happen at note onset, while the balance of
// harmonics is still settling (McLeod, "Fast, Accurate Pitch Detection Tools
// for Music Analysis", §6.3 and §7.1). A frame whose RMS jumps above
// ONSET_RATIO× the running envelope is a new pluck: tracking restarts for the
// new note and readings are suppressed for ATTACK_MS after the jump settles
// (the jump itself lasts until the attack has filled the window, ~80 ms).
const ONSET_RATIO = 2
const ENVELOPE_ALPHA = 0.2
const ATTACK_MS = 30

// Octave lock. Within one note the pitch does not jump by whole octaves, so a
// reading about an octave away from the tracked pitch is an octave error and
// is folded back — the cheap form of McLeod's one-octave-estimate-per-note
// idea (§7.2). If the jump persists this long without a new pluck, the player
// really changed octave (slide, legato) and tracking restarts there.
const OCTAVE_TOLERANCE_CENTS = 50
const OCTAVE_CONFIRM_MS = 300

// A short dropout (one low-clarity frame, the attack of a re-pluck) repeats the
// last reading instead of reporting silence, so the tuner does not flicker and
// one bad frame does not reset the trainer's hold timer.
const DROPOUT_HOLD_MS = 200

// Median window: rejects lone glitches before smoothing. McLeod's thesis
// (table 7.1) measures fewer octave errors with 7 than with 5 frames; larger
// windows add lag for little gain.
const MEDIAN_WINDOW = 7

// One Euro filter parameters. The filter stays steady while a note is held and
// becomes responsive when the pitch actually slides:
//   - minCutoff (Hz): lower means steadier at rest but a touch more lag.
//   - beta: higher means quicker to follow a real pitch change.
const MIN_CUTOFF = 0.6
const BETA = 0.02
const DERIVATIVE_CUTOFF = 1.0

const detector = PitchDetector.forFloat32Array(FFT_SIZE)

let audioContext: AudioContext | null = null
let stream: MediaStream | null = null
let rafId: number | null = null
// The latest analysis window, shared with the UI's waveform display.
let waveform: Float32Array | null = null
// Spectrum for chord recognition (ts/chords.ts), read on demand.
let chordAnalyser: AnalyserNode | null = null
let chordSpectrum: Float32Array<ArrayBuffer> | null = null
let recentFrequencies: number[] = []

// One Euro filter state.
let filteredValue: number | null = null
let filteredSlope = 0
let lastTimestamp = 0

// Noise-floor, onset, octave-lock and dropout state.
let noiseFloor: number | null = null
let lastFrameAt = 0
let envelope = 0
let attackUntil = 0
let octaveJumpSince: number | null = null
let lastReading: PitchReading | null = null
let lastReadingAt = 0

function rootMeanSquare(input: Float32Array): number {
	let sumSquares = 0
	for (let i = 0; i < input.length; i++) {
		sumSquares += input[i] * input[i]
	}
	return Math.sqrt(sumSquares / input.length)
}

// McLeod's normalized square difference at one lag, best of lag±1 (the true
// peak sits between integer lags).
function nsdfPeak(input: Float32Array, lag: number): number {
	let best = -1
	for (let l = lag - 1; l <= lag + 1; l++) {
		let cross = 0
		let energy = 0
		for (let j = 0; j + l < input.length; j++) {
			cross += input[j] * input[j + l]
			energy += input[j] * input[j] + input[j + l] * input[j + l]
		}
		if (energy > 0) best = Math.max(best, (2 * cross) / energy)
	}
	return best
}

// See SUBHARMONIC_MARGIN.
function correctOctaveUp(input: Float32Array, sampleRate: number, pitch: number): number {
	// Lags past half the window compare too few samples to be trusted.
	while (pitch / 2 >= MIN_FREQUENCY && (2 * sampleRate) / pitch < input.length / 2) {
		const lag = Math.round(sampleRate / pitch)
		const doubleLag = Math.round((2 * sampleRate) / pitch)
		if (nsdfPeak(input, doubleLag) - nsdfPeak(input, lag) < SUBHARMONIC_MARGIN) break
		pitch /= 2
	}
	return pitch
}

// Folds an octave error back into the tracked pitch's octave. Only active once
// the median window is full, so a glitch right after the attack cannot become
// the reference the rest of the note is locked to.
function correctOctave(frequency: number, now: number): number {
	if (filteredValue === null || recentFrequencies.length < MEDIAN_WINDOW) return frequency

	const cents = 1200 * Math.log2(frequency / filteredValue)
	const octaves = Math.round(cents / 1200)
	if (octaves === 0 || Math.abs(cents - 1200 * octaves) > OCTAVE_TOLERANCE_CENTS) {
		octaveJumpSince = null
		return frequency
	}

	if (octaveJumpSince === null) octaveJumpSince = now
	if (now - octaveJumpSince < OCTAVE_CONFIRM_MS) return frequency / 2 ** octaves

	resetSmoothing()
	return frequency
}

// Median of the recent window: rejects the occasional octave-jump or glitch that
// a mean would smear into the result.
function medianFrequency(frequency: number): number {
	recentFrequencies.push(frequency)
	if (recentFrequencies.length > MEDIAN_WINDOW) {
		recentFrequencies.shift()
	}

	const sorted = [...recentFrequencies].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

// Smoothing factor of a first-order low-pass for a given cutoff and timestep.
function lowPassAlpha(cutoff: number, dt: number): number {
	const tau = 1 / (2 * Math.PI * cutoff)
	return 1 / (1 + tau / dt)
}

/**
 * One Euro filter (Casiez et al.). Adapts its cutoff to the signal's speed, so
 * it is very steady when the pitch is held yet still tracks deliberate changes.
 */
function smoothFrequency(frequency: number, timestampMs: number): number {
	if (filteredValue === null) {
		filteredValue = frequency
		filteredSlope = 0
		lastTimestamp = timestampMs
		return frequency
	}

	let dt = (timestampMs - lastTimestamp) / 1000
	if (dt <= 0) dt = 1 / 60

	const slope = (frequency - filteredValue) / dt
	filteredSlope += lowPassAlpha(DERIVATIVE_CUTOFF, dt) * (slope - filteredSlope)

	const cutoff = MIN_CUTOFF + BETA * Math.abs(filteredSlope)
	filteredValue += lowPassAlpha(cutoff, dt) * (frequency - filteredValue)
	lastTimestamp = timestampMs

	return filteredValue
}

function resetSmoothing() {
	recentFrequencies = []
	filteredValue = null
	filteredSlope = 0
	octaveJumpSince = null
}

/**
 * Turns one analysis window (the latest FFT_SIZE samples, already band-passed)
 * into a reading, or null for silence. Stateful: call once per frame, in order.
 */
function processFrame(input: Float32Array, sampleRate: number, now: number): PitchReading | null {
	const volume = rootMeanSquare(input)
	const onset = volume > ONSET_RATIO * envelope
	envelope += ENVELOPE_ALPHA * (volume - envelope)

	const dt = Math.max(0, now - lastFrameAt) / 1000
	lastFrameAt = now

	if (volume < MIN_VOLUME) {
		learnNoise(volume, dt)
		resetSmoothing()
		return held(now)
	}

	if (onset) {
		resetSmoothing()
		attackUntil = now + ATTACK_MS
	}

	const [rawPitch, clarity] = detector.findPitch(input, sampleRate)
	const pitch = clarity >= SUSTAIN_CLARITY ? correctOctaveUp(input, sampleRate, rawPitch) : rawPitch
	const sustaining =
		filteredValue !== null && Math.abs(1200 * Math.log2(pitch / filteredValue)) < SUSTAIN_CENTS
	const voiced = clarity >= MIN_CLARITY || (sustaining && clarity >= SUSTAIN_CLARITY)

	// Only unpitched frames teach the noise floor: a note held from the moment
	// listening starts (or sung for a long time) must never gate itself out.
	if (!voiced) learnNoise(volume, dt)
	if (volume < NOISE_MARGIN * (noiseFloor ?? 0)) {
		resetSmoothing()
		return held(now)
	}

	if (now >= attackUntil && voiced && pitch >= MIN_FREQUENCY && pitch <= MAX_FREQUENCY) {
		const frequency = smoothFrequency(medianFrequency(correctOctave(pitch, now)), now)
		lastReading = { frequency, clarity, volume }
		lastReadingAt = now
		return lastReading
	}

	return held(now)
}

// Background-noise estimate: drops instantly to a quieter frame, creeps up at
// NOISE_FLOOR_RISE per second of unpitched input.
function learnNoise(volume: number, dt: number) {
	// Digital silence (the stream has not delivered audio yet) says nothing about
	// the room, and a zero floor would never rise again.
	if (volume <= 1e-5) return
	noiseFloor =
		noiseFloor === null || volume < noiseFloor ? volume : Math.min(volume, noiseFloor * NOISE_FLOOR_RISE ** dt)
}

// The last reading while within the dropout hold, otherwise silence.
function held(now: number): PitchReading | null {
	return lastReading && now - lastReadingAt <= DROPOUT_HOLD_MS ? lastReading : null
}

async function start(onReading: ReadingCallback, onError: ErrorCallback) {
	try {
		// Disable the browser voice-processing chain: it is tuned for speech and
		// distorts the steady tones we want to measure.
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
		})

		audioContext = new AudioContext()
		const source = audioContext.createMediaStreamSource(stream)

		// source -> high-pass -> low-pass -> analyser: confine to the guitar band.
		const highpass = audioContext.createBiquadFilter()
		highpass.type = 'highpass'
		highpass.frequency.value = HIGHPASS_HZ
		const lowpass = audioContext.createBiquadFilter()
		lowpass.type = 'lowpass'
		lowpass.frequency.value = LOWPASS_HZ

		const analyser = audioContext.createAnalyser()
		analyser.fftSize = FFT_SIZE
		source.connect(highpass)
		highpass.connect(lowpass)
		lowpass.connect(analyser)

		// Chords tap before the low-pass: their band reaches 1.5 kHz.
		chordAnalyser = audioContext.createAnalyser()
		chordAnalyser.fftSize = CHORD_FFT_SIZE
		highpass.connect(chordAnalyser)
		chordSpectrum = new Float32Array(chordAnalyser.frequencyBinCount)

		const input = new Float32Array(FFT_SIZE)
		waveform = input

		const tick = (timestampMs: number) => {
			// A thrown frame (e.g. a downstream render error) must never stop the
			// loop: the `finally` always reschedules so detection keeps running.
			try {
				analyser.getFloatTimeDomainData(input)
				onReading(processFrame(input, audioContext!.sampleRate, timestampMs))
			} catch (error) {
				console.error('Pitch processing error:', error)
			} finally {
				rafId = requestAnimationFrame(tick)
			}
		}

		rafId = requestAnimationFrame(tick)
	} catch (error) {
		console.error('Error accessing microphone:', error)
		onError(error)
	}
}

function stop() {
	if (rafId !== null) {
		cancelAnimationFrame(rafId)
		rafId = null
	}
	if (stream) {
		stream.getTracks().forEach((track) => track.stop())
		stream = null
	}
	if (audioContext) {
		audioContext.close()
		audioContext = null
	}
	waveform = null
	chordAnalyser = null
	chordSpectrum = null
	resetSmoothing()
	noiseFloor = null
	lastFrameAt = 0
	envelope = 0
	lastReading = null
}

/** Latest band-passed input window, or null while not listening. */
function getWaveform(): Float32Array | null {
	return waveform
}

/**
 * True while the browser holds audio back until a user gesture (autoplay
 * policy), which happens when listening starts automatically on page load.
 */
function isSuspended(): boolean {
	return audioContext?.state === 'suspended'
}

function resume() {
	return audioContext?.resume()
}

/** Current dB magnitude spectrum for chord recognition, or null while not listening. */
function getSpectrum(): { spectrumDb: Float32Array; binHz: number } | null {
	if (!chordAnalyser || !chordSpectrum || !audioContext) return null
	chordAnalyser.getFloatFrequencyData(chordSpectrum)
	return { spectrumDb: chordSpectrum, binHz: audioContext.sampleRate / CHORD_FFT_SIZE }
}

export { start, stop, processFrame, getWaveform, getSpectrum, isSuspended, resume }
