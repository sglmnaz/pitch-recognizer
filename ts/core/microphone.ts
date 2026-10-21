import { fft } from './fft.ts'

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
// MIN_VOLUME in any case. MIN_VOLUME (~-70 dBFS) only guards near-digital
// silence: at the old 0.004 an electric guitar played unplugged was read in
// 17 % of frames on the benchmark (`unplugged` condition), at 0.0003 in 98 %,
// with room noise alone still never producing a note (scripts/pitch-check.ts).
// Boosting the input would not help: detection is level-invariant and a boost
// raises the room noise just as much.
// ponytail: pitched hum (mains harmonics) is never learned as noise, so hum
// louder than MIN_VOLUME reads as a note; learn hum that stays put for many
// seconds if that shows up in practice.
const MIN_VOLUME = 0.0003
const NOISE_MARGIN = 3
const NOISE_FLOOR_RISE = 1.1
// Gate hysteresis for pitch readings (NOISE_MARGIN above stays the "something
// is sounding" level used by the waveform and the chords view). A new note
// must clear NOTE_MARGIN; a note already being tracked keeps reading down to
// SUSTAIN_MARGIN, as long as its pitch stays put. A single 3x gate cut an
// unplugged electric's sustain at ~10 dB above the room noise while the string
// was still clearly pitched (clarity 0.85-0.9): the needle froze a second
// after the pluck, before there was time to turn the peg. With 2x / 1.2x a
// synthetic unplugged low E reads twice as long (0.6 -> 1.2 s at -31 dB) and
// the benchmark improves everywhere (acoustic 87.9 -> 91.7 % RPA, electric on
// a cheap phone 96.9 -> 99.4 %); room noise alone still never reads.
const NOTE_MARGIN = 2
const SUSTAIN_MARGIN = 1.2

// Clarity a new note needs. 0.9 (pitchy's default) rejected an unplugged A
// string at 0.84-0.91 on the field recording; 0.85 read it 82 % of the time,
// raised the benchmark (acoustic 92.2 -> 93.5 %, unplugged 32 -> 41.5 % RPA)
// and still produced no note from room noise. 0.8 read slightly more but
// doubled acoustic octave errors.
const MIN_CLARITY = 0.85
// Voicing hysteresis: a note already being tracked keeps going down to this
// clarity while it decays into the noise, as long as the pitch stays within
// SUSTAIN_CENTS of it. 0.7 (was 0.8) follows an unplugged string ~0.3 s
// further into its tail, still on the right note.
const SUSTAIN_CLARITY = 0.7
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
// octave-down errors. The low-pass trims pick and fret hiss while passing the
// first harmonics of every playable note.
// The high-pass is HIGHPASS_STAGES cascaded biquads (12 dB/octave each): mains
// hum (50/60 Hz) sits just below the low E, and on a field recording of an
// unplugged electric in a humming room a single 60 Hz stage left the hum
// strong enough to win the period search over the A and D strings. Two 70 Hz
// stages take ~14 dB off 50 Hz for ~4 dB off the low E's fundamental (its
// harmonics carry the period anyway).
export const HIGHPASS_HZ = 70
export const HIGHPASS_STAGES = 2
export const LOWPASS_HZ = 1400

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
// Margin tuned on the benchmark: 0.02 also pushed acoustic notes an octave
// down (G3 read as G2 in 13 % of frames on GuitarSet, where body resonance and
// still-ringing notes lift the 2τ peak); 0.05 gave the best acoustic RPA
// (88.6 % vs 86.4 % at 0.02, 87.6 % with no check) and left electric
// (IDMT, even behind a 250 Hz phone roll-off) unchanged.
const SUBHARMONIC_MARGIN = 0.05

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

// Autocorrelation via the power spectrum (Wiener-Khinchin), zero-padded to 2x
// so it is linear, not circular. Computing it this way lets stationary room
// noise be subtracted from the spectrum first (see NOISE_SUBTRACTION).
const PADDED = 2 * FFT_SIZE
const spectrumRe = new Float64Array(PADDED)
const spectrumIm = new Float64Array(PADDED)
const framePower = new Float64Array(PADDED)
// Whether framePower is this frame's (silent frames skip the analysis), and its sample rate.
let powerFresh = false
let powerRate = 44100
const nsdf = new Float32Array(FFT_SIZE)

// Noise subtraction (spectral subtraction, as in speech enhancement): the
// power spectrum of room-noise frames is averaged into noisePower, and
// NOISE_SUBTRACTION times it is removed from every frame's power spectrum
// before the autocorrelation, keeping at least SPECTRAL_FLOOR of each bin
// (avoids the "musical noise" of over-subtraction). Hum, fans and whines are
// stationary, so they cancel instead of competing with the string.
// A frame teaches the estimate only if it is near the noise floor AND has no
// periodicity at guitar lags (clarity < NOISE_LEARN_CLARITY): a decaying
// note is still periodic there, while hum's periods lie outside the range,
// so earlier notes' tails are not learned and subtracted from later ones.
// (Minimum statistics, Martin 2001, was tried: it learns any long-held note
// as "stationary noise" and erased it.) 0 disables it.
const NOISE_SUBTRACTION = 3
const SPECTRAL_FLOOR = 0.05
const NOISE_LEARN_RATE = 0.05
const NOISE_LEARN_CLARITY = 0.3
let noisePower: Float64Array | null = null
// MPM peak-picking constant k (McLeod & Wyvill): the first NSDF key maximum
// within k of the highest one is the period. 0.9 as pitchy (McLeod's thesis,
// table 6.3: among the lowest octave-error rates on real instruments); 0.8-0.85
// sent the B string an octave up on the field recording.
const PEAK_K = 0.9

/**
 * McLeod pitch method (as the pitchy library implements it, which this
 * replaces), with two changes: the autocorrelation goes through the power
 * spectrum so room noise can be subtracted first, and key maxima are
 * only considered at lags of guitar fundamentals (MIN_FREQUENCY..MAX_FREQUENCY).
 * Pitchy searches every lag, so a long-period component — mains hum and its
 * beats, ~12-50 Hz — could set the highest maximum and push a real note's
 * peak below k of it: on a humming room the A string came out as 55 Hz or as
 * noise instead of 110 Hz. Returns [frequency, clarity], or [0, 0].
 */
function findPitch(input: Float32Array, sampleRate: number): [number, number] {
	spectrumRe.fill(0)
	spectrumIm.fill(0)
	spectrumRe.set(input)
	fft(spectrumRe, spectrumIm)
	let total = 0
	let kept = 0
	for (let k = 0; k < PADDED; k++) {
		const power = spectrumRe[k] * spectrumRe[k] + spectrumIm[k] * spectrumIm[k]
		framePower[k] = power
		const clean = noisePower ? Math.max(power - NOISE_SUBTRACTION * noisePower[k], SPECTRAL_FLOOR * power) : power
		total += power
		kept += clean
		spectrumRe[k] = clean
		spectrumIm[k] = 0
	}
	powerFresh = true
	// The FFT of the (real, even) power spectrum is PADDED x the autocorrelation.
	fft(spectrumRe, spectrumIm)

	// NSDF (McLeod eq. 9): 2 r(τ) / m'(τ), m' updated incrementally as in
	// pitchy. m' comes from the raw samples, so it is scaled by the share of
	// energy left after noise subtraction to stay consistent with r.
	const share = total > 0 ? kept / total : 1
	let m = 2 * (spectrumRe[0] / PADDED / share)
	let i = 0
	for (; i < nsdf.length && m > 0; i++) {
		nsdf[i] = (2 * (spectrumRe[i] / PADDED)) / (m * share)
		m -= input[i] ** 2 + input[input.length - i - 1] ** 2
	}
	for (; i < nsdf.length; i++) nsdf[i] = 0

	const minLag = Math.floor(sampleRate / MAX_FREQUENCY)
	const maxLag = Math.min(nsdf.length - 2, Math.ceil(sampleRate / MIN_FREQUENCY))
	// Key maximum: the highest point between a rising and a falling zero crossing.
	const keys: number[] = []
	for (let lag = 1, looking = false, peak = -1; lag <= maxLag; lag++) {
		if (nsdf[lag - 1] <= 0 && nsdf[lag] > 0) {
			looking = true
			peak = lag
		} else if (nsdf[lag - 1] > 0 && nsdf[lag] <= 0) {
			looking = false
			if (peak >= minLag) keys.push(peak)
		} else if (looking && nsdf[lag] > nsdf[peak]) {
			peak = lag
		}
	}
	let nMax = 0
	for (const key of keys) nMax = Math.max(nMax, nsdf[key])
	const peak = keys.find((key) => nsdf[key] >= PEAK_K * nMax)
	if (peak === undefined) return [0, 0]

	// Parabolic interpolation around the peak (McLeod §5).
	const [a, b, c] = [nsdf[peak - 1], nsdf[peak], nsdf[peak + 1]]
	const denominator = a - 2 * b + c
	const shift = denominator === 0 ? 0 : (a - c) / (2 * denominator)
	return [sampleRate / (peak + shift), Math.min(1, b - 0.25 * (a - c) * shift)]
}

let audioContext: AudioContext | null = null
let stream: MediaStream | null = null
let rafId: number | null = null
// The latest analysis window, shared with the UI's waveform display.
let waveform: Float32Array | null = null
// Spectrum for chord recognition (ts/music/chords.ts), read on demand.
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
// Whether the latest frame cleared the silence gate (shared with the chords view).
let sounding = false

/** What the last frame measured and why it did or did not read (for ?debug). */
export interface FrameStats {
	volume: number
	noiseFloor: number
	clarity: number
	/**
	 * This frame's own pitch in Hz, before the median and One Euro smoothing,
	 * at any clarity (weigh it with `clarity`; 0 = silent, below the noise gate
	 * or out of range). The smoothing steadies the tuner's needle but glides
	 * through the notes in between when the pitch jumps, and lags a fast line:
	 * Trainer → Tab reads this instead.
	 */
	pitch: number
	reason: 'silent' | 'below noise' | 'attack' | 'low clarity' | 'out of range' | 'reading'
}
const stats: FrameStats = { volume: 0, noiseFloor: 0, clarity: 0, pitch: 0, reason: 'silent' }

function rootMeanSquare(input: Float32Array): number {
	let sumSquares = 0
	for (let i = 0; i < input.length; i++) {
		sumSquares += input[i] * input[i]
	}
	return Math.sqrt(sumSquares / input.length)
}

// The current frame's NSDF (from findPitch) at one lag, best of lag±1 (the
// true peak sits between integer lags).
function nsdfPeak(lag: number): number {
	return Math.max(nsdf[lag - 1], nsdf[lag], nsdf[lag + 1])
}

/** Folds the last frame's power spectrum into the room-noise estimate. */
function learnNoisePower() {
	if (!noisePower) {
		noisePower = Float64Array.from(framePower)
		return
	}
	for (let k = 0; k < PADDED; k++) noisePower[k] += NOISE_LEARN_RATE * (framePower[k] - noisePower[k])
}

// See SUBHARMONIC_MARGIN.
function correctOctaveUp(input: Float32Array, sampleRate: number, pitch: number): number {
	// Lags past half the window compare too few samples to be trusted.
	while (pitch / 2 >= MIN_FREQUENCY && (2 * sampleRate) / pitch < input.length / 2) {
		const lag = Math.round(sampleRate / pitch)
		const doubleLag = Math.round((2 * sampleRate) / pitch)
		if (nsdfPeak(doubleLag) - nsdfPeak(lag) < SUBHARMONIC_MARGIN) break
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
	powerFresh = false
	powerRate = sampleRate
	const volume = rootMeanSquare(input)
	const onset = volume > ONSET_RATIO * envelope
	envelope += ENVELOPE_ALPHA * (volume - envelope)

	const dt = Math.max(0, now - lastFrameAt) / 1000
	lastFrameAt = now

	sounding = volume >= Math.max(MIN_VOLUME, NOISE_MARGIN * (noiseFloor ?? 0))
	stats.volume = volume
	stats.clarity = 0
	stats.pitch = 0
	stats.reason = 'silent'
	if (volume < MIN_VOLUME) {
		learnNoise(volume, dt)
		resetSmoothing()
		return held(now)
	}

	if (onset) {
		resetSmoothing()
		attackUntil = now + ATTACK_MS
	}

	const [rawPitch, clarity] = findPitch(input, sampleRate)
	const pitch = clarity >= SUSTAIN_CLARITY ? correctOctaveUp(input, sampleRate, rawPitch) : rawPitch
	const sustaining = filteredValue !== null && Math.abs(1200 * Math.log2(pitch / filteredValue)) < SUSTAIN_CENTS
	const voiced = clarity >= MIN_CLARITY || (sustaining && clarity >= SUSTAIN_CLARITY)
	stats.clarity = clarity
	stats.pitch = pitch >= MIN_FREQUENCY && pitch <= MAX_FREQUENCY ? pitch : 0

	// Only unpitched frames teach the noise floor: a note held from the moment
	// listening starts (or sung for a long time) must never gate itself out.
	if (!voiced) learnNoise(volume, dt)
	if (clarity < NOISE_LEARN_CLARITY && noiseFloor !== null && volume < NOTE_MARGIN * noiseFloor) learnNoisePower()
	stats.noiseFloor = noiseFloor ?? 0
	stats.reason = now < attackUntil ? 'attack' : !voiced ? 'low clarity' : pitch < MIN_FREQUENCY || pitch > MAX_FREQUENCY ? 'out of range' : 'reading'
	if (volume < (sustaining ? SUSTAIN_MARGIN : NOTE_MARGIN) * (noiseFloor ?? 0)) {
		stats.reason = 'below noise'
		stats.pitch = 0
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
	noiseFloor = noiseFloor === null || volume < noiseFloor ? volume : Math.min(volume, noiseFloor * NOISE_FLOOR_RISE ** dt)
}

// The last reading while within the dropout hold, otherwise silence.
function held(now: number): PitchReading | null {
	return lastReading && now - lastReadingAt <= DROPOUT_HOLD_MS ? lastReading : null
}

// stop() bumps it. A start() still waiting for getUserMedia then finds it
// changed and drops what it got: a Stop pressed during the permission prompt
// wins, and a later start cannot leak a second context and rAF loop.
let generation = 0
// True from start() until stop(), including while getUserMedia is pending.
let running = false

async function start(onReading: ReadingCallback, onError: ErrorCallback) {
	// Idempotent: a second start while live (or starting) would run two loops.
	if (running) return
	running = true
	const startedAt = generation
	try {
		// Disable the browser voice-processing chain: it is tuned for speech and
		// distorts the steady tones we want to measure.
		const captured = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
		})
		if (generation !== startedAt) {
			captured.getTracks().forEach((track) => track.stop())
			return
		}
		stream = captured

		audioContext = new AudioContext()
		const source = audioContext.createMediaStreamSource(stream)

		// source -> high-pass stages -> low-pass -> analyser: confine to the guitar band.
		let highpass: AudioNode = source
		for (let stage = 0; stage < HIGHPASS_STAGES; stage++) {
			const filter = audioContext.createBiquadFilter()
			filter.type = 'highpass'
			filter.frequency.value = HIGHPASS_HZ
			highpass.connect(filter)
			highpass = filter
		}
		const lowpass = audioContext.createBiquadFilter()
		lowpass.type = 'lowpass'
		lowpass.frequency.value = LOWPASS_HZ

		const analyser = audioContext.createAnalyser()
		analyser.fftSize = FFT_SIZE
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
		// A start already cancelled by stop() has nobody to tell.
		if (generation !== startedAt) return
		console.error('Error accessing microphone:', error)
		running = false
		onError(error)
	}
}

function stop() {
	generation++
	running = false
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
	noisePower = null
	lastFrameAt = 0
	envelope = 0
	lastReading = null
	sounding = false
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

/** Measurements of the latest frame (debug view). */
function getStats(): Readonly<FrameStats> {
	return stats
}

/** The raw microphone stream, as the app captures it (debug recorder). */
function getStream(): MediaStream | null {
	return stream
}

/**
 * The latest frame's power spectrum (the FFT_SIZE window zero-padded to 2x,
 * no taper, before noise subtraction) and its bin width; null when that frame
 * was too quiet to analyse. Read-only: the next frame overwrites it. Trainer →
 * Tab checks in it whether the note due just rose, where the single pitch
 * cannot tell two ringing strings apart.
 */
function getFramePower(): { power: Readonly<Float64Array>; binHz: number } | null {
	return powerFresh ? { power: framePower, binHz: powerRate / PADDED } : null
}

/** True while the input clears the adaptive silence gate (a note or chord is sounding). */
function isSounding(): boolean {
	return sounding
}

export { start, stop, processFrame, getWaveform, getSpectrum, getFramePower, getStats, getStream, isSounding, isSuspended, resume }
