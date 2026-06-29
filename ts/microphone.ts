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

// Below this RMS the signal is treated as silence.
const MIN_VOLUME = 0.015
// Pitchy clarity below this is almost always noise rather than a real note.
const MIN_CLARITY = 0.9

// A short median window rejects lone spikes (e.g. an octave glitch) before
// smoothing, without adding noticeable latency.
const MEDIAN_WINDOW = 5

// One Euro filter parameters. The filter stays steady while a note is held and
// becomes responsive when the pitch actually slides:
//   - minCutoff (Hz): lower means steadier at rest but a touch more lag.
//   - beta: higher means quicker to follow a real pitch change.
const MIN_CUTOFF = 0.6
const BETA = 0.02
const DERIVATIVE_CUTOFF = 1.0

let audioContext: AudioContext | null = null
let stream: MediaStream | null = null
let rafId: number | null = null
let recentFrequencies: number[] = []

// One Euro filter state.
let filteredValue: number | null = null
let filteredSlope = 0
let lastTimestamp = 0

function rootMeanSquare(input: Float32Array): number {
	let sumSquares = 0
	for (let i = 0; i < input.length; i++) {
		sumSquares += input[i] * input[i]
	}
	return Math.sqrt(sumSquares / input.length)
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
		const analyser = audioContext.createAnalyser()
		analyser.fftSize = 2048
		source.connect(analyser)

		const input = new Float32Array(analyser.fftSize)
		const detector = PitchDetector.forFloat32Array(analyser.fftSize)

		const tick = (timestampMs: number) => {
			// A thrown frame (e.g. a downstream render error) must never stop the
			// loop: the `finally` always reschedules so detection keeps running.
			try {
				analyser.getFloatTimeDomainData(input)
				const volume = rootMeanSquare(input)

				if (volume < MIN_VOLUME) {
					resetSmoothing()
					onReading(null)
				} else {
					const [pitch, clarity] = detector.findPitch(input, audioContext!.sampleRate)

					if (pitch > 0 && clarity >= MIN_CLARITY) {
						const frequency = smoothFrequency(medianFrequency(pitch), timestampMs)
						onReading({ frequency, clarity, volume })
					} else {
						onReading(null)
					}
				}
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
	resetSmoothing()
}

export { start, stop }
