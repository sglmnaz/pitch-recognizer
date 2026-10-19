// Tap-to-hear: a plucked-string synth (Karplus–Strong). Own AudioContext,
// separate from the microphone's, created on the first tap because browsers
// only start audio after a gesture.
import { frequencyOfMidi } from './notes'
import * as Settings from './settings'

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
// The buffers are tuned to this A4; a calibration change drops them.
let bufferA4 = 440

function pluck(context: AudioContext, midi: number): AudioBuffer {
	const frequency = frequencyOfMidi(midi, bufferA4)
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
	const { a4 } = Settings.get()
	if (a4 !== bufferA4) {
		buffers.clear()
		bufferA4 = a4
	}
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

/* Reference tone ----------------------------------------------------------- */
// A string to tune against needs the exact pitch, which the plucked buffers
// cannot promise (integer delay line, up to a few cents off), and it should
// hold steady instead of dying away. So: an oscillator at the exact
// frequency, with a few overtones so the low strings stay audible on a phone
// speaker, which cannot reproduce 82 Hz but does play the 3rd and 4th harmonic.
const TONE_S = 2.2
const TONE_HOLD_S = 1.5
const TONE_HARMONICS = [0, 1, 0.7, 0.5, 0.3, 0.15, 0.08]
const TONE_GAIN = 0.5
let tone: { gain: GainNode; osc: OscillatorNode } | null = null

/** Cuts the reference tone short (a new one, or leaving the tuner) without a click. */
export function stopTone() {
	if (!ctx || !tone) return
	const { gain, osc } = tone
	tone = null
	gain.gain.cancelScheduledValues(ctx.currentTime)
	gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime)
	gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03)
	osc.stop(ctx.currentTime + 0.2)
	ringingUntil = performance.now() + 250
}

/**
 * Plays a steady tone at exactly `frequency` Hz, volume 0–1. Returns the ms
 * until the mic may listen again (the tone plus the room's tail).
 */
export function playTone(frequency: number, volume: number): number {
	ctx ??= new AudioContext()
	if (ctx.state === 'suspended') ctx.resume()
	stopTone()
	const now = ctx.currentTime
	const osc = ctx.createOscillator()
	osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(TONE_HARMONICS.length), Float32Array.from(TONE_HARMONICS)))
	osc.frequency.value = frequency
	const gain = ctx.createGain()
	// 30 ms attack and a 0.7 s release: no click, and a gentle end.
	gain.gain.setValueAtTime(0, now)
	gain.gain.linearRampToValueAtTime(volume * TONE_GAIN, now + 0.03)
	gain.gain.setValueAtTime(volume * TONE_GAIN, now + TONE_HOLD_S)
	gain.gain.linearRampToValueAtTime(0, now + TONE_S)
	osc.connect(gain).connect(ctx.destination)
	osc.start(now)
	osc.stop(now + TONE_S + 0.05)
	tone = { gain, osc }
	const ms = TONE_S * 1000 + RING_MS / 3
	ringingUntil = performance.now() + ms
	return ms
}
