// Tap-to-hear: a plucked-string synth (Karplus–Strong). Own AudioContext,
// separate from the microphone's, created on the first tap because browsers
// only start audio after a gesture.

const DURATION_S = 1.6
// Energy kept per trip round the string; with the two-tap average below,
// highs die first and low strings ring longer, like steel strings.
const DECAY = 0.996
const VOLUME = 0.5
// Synthesis rate, above the device's: a longer delay line per period keeps
// the high frets in tune with an integer delay.
const RATE = 96000
// How long after a pluck the mic should ignore what it hears (the speaker).
const RING_MS = 900

let ctx: AudioContext | null = null
const buffers = new Map<number, AudioBuffer>()
let ringingUntil = 0

function pluck(context: AudioContext, midi: number): AudioBuffer {
	const frequency = 440 * 2 ** ((midi - 69) / 12)
	const length = Math.round(RATE * DURATION_S)
	// The context resamples a buffer of any rate on playback.
	const buffer = context.createBuffer(1, length, RATE)
	const out = buffer.getChannelData(0)
	// A noise burst circulating through a delay line one period long. The
	// averaging filter adds half a sample of delay, hence the -0.5.
	// ponytail: integer delay; at RATE the top note (D6, fret 22) is up to ~8
	// cents off. Add a fractional (allpass) delay if this ever doubles as a
	// reference pitch.
	const period = Math.max(2, Math.round(RATE / frequency - 0.5))
	const line = Float32Array.from({ length: period }, () => Math.random() * 2 - 1)
	for (let i = 0, at = 0; i < length; i++) {
		const next = (at + 1) % period
		out[i] = line[at] * VOLUME
		line[at] = DECAY * 0.5 * (line[at] + line[next])
		at = next
	}
	return buffer
}

/** Plays a MIDI note `delay` seconds from now. */
export function play(midi: number, delay = 0) {
	ctx ??= new AudioContext()
	if (ctx.state === 'suspended') ctx.resume()
	let buffer = buffers.get(midi)
	if (!buffer) buffers.set(midi, (buffer = pluck(ctx, midi)))
	const source = ctx.createBufferSource()
	source.buffer = buffer
	source.connect(ctx.destination)
	source.start(ctx.currentTime + delay)
	ringingUntil = Math.max(ringingUntil, performance.now() + delay * 1000 + RING_MS)
}

/** True while a synth note may still be audible to the microphone. */
export const isRinging = () => performance.now() < ringingUntil
