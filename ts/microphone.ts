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
// Number of recent frequencies kept for median smoothing.
const SMOOTHING_WINDOW = 7

let audioContext: AudioContext | null = null
let stream: MediaStream | null = null
let rafId: number | null = null
let recentFrequencies: number[] = []

function rootMeanSquare(input: Float32Array): number {
	let sumSquares = 0
	for (let i = 0; i < input.length; i++) {
		sumSquares += input[i] * input[i]
	}
	return Math.sqrt(sumSquares / input.length)
}

// The median rejects the occasional octave-jump or glitch far better than a
// mean while still tracking real pitch changes within a few frames.
function smoothFrequency(frequency: number): number {
	recentFrequencies.push(frequency)
	if (recentFrequencies.length > SMOOTHING_WINDOW) {
		recentFrequencies.shift()
	}

	const sorted = [...recentFrequencies].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
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

		const tick = () => {
			// A thrown frame (e.g. a downstream render error) must never stop the
			// loop: the `finally` always reschedules so detection keeps running.
			try {
				analyser.getFloatTimeDomainData(input)
				const volume = rootMeanSquare(input)

				if (volume < MIN_VOLUME) {
					recentFrequencies = []
					onReading(null)
				} else {
					const [pitch, clarity] = detector.findPitch(input, audioContext!.sampleRate)

					if (pitch > 0 && clarity >= MIN_CLARITY) {
						onReading({ frequency: smoothFrequency(pitch), clarity, volume })
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
	recentFrequencies = []
}

export { start, stop }
