// Tap-to-hear: a plucked-string synth (Karplus–Strong). Own AudioContext,
// separate from the microphone's, created on the first tap because browsers
// only start audio after a gesture.
import { frequencyOfMidi } from './notes'
import * as Settings from './settings'

const DURATION_S = 1.6
/** How long a plucked note lasts, for callers that must not hear any of it (ear training). */
export const NOTE_MS = DURATION_S * 1000
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
// Notes still sounding, so stopAll() can cut them (a replay must not stack copies).
const voices = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>()
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

/**
 * Plays a MIDI note `delay` seconds from now; `volume` < 1 for notes that ring
 * together (a chord). `ringMs`: how long after its onset the mic should ignore
 * what it hears; the default covers the loud part, NOTE_MS the whole note.
 */
export function play(midi: number, delay = 0, volume = 1, ringMs = RING_MS) {
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
	const gain = ctx.createGain()
	gain.gain.value = volume
	source.connect(gain).connect(ctx.destination)
	const voice = { source, gain }
	voices.add(voice)
	source.onended = () => voices.delete(voice)
	source.start(ctx.currentTime + delay)
	ringingUntil = Math.max(ringingUntil, performance.now() + delay * 1000 + ringMs)
}

/**
 * Strings that ring together, `step` seconds apart from `at`, in the order
 * given (low to high for a downstroke). At 1/sqrt(n) each they stay as loud
 * as one note. `stop` (default) cuts what is still sounding first, so a new
 * strum never stacks on the last; false for a strum scheduled after another
 * one (a progression's bar). `ringMs` as in play().
 */
export function strum(midis: number[], { step, at = 0, ringMs = RING_MS, stop = true }: { step: number; at?: number; ringMs?: number; stop?: boolean }) {
	if (stop) stopAll()
	const gain = 1 / Math.sqrt(Math.max(1, midis.length))
	midis.forEach((midi, i) => play(midi, at + i * step, gain, ringMs))
}

/** Fades out (20 ms, no click) every plucked note still sounding or scheduled. */
export function stopAll() {
	if (!ctx) return
	const now = ctx.currentTime
	for (const { source, gain } of voices) {
		gain.gain.cancelScheduledValues(now)
		gain.gain.setValueAtTime(gain.gain.value, now)
		gain.gain.linearRampToValueAtTime(0, now + 0.02)
		// A note scheduled for later must not start at all; stop() before start time does that.
		source.stop(now + 0.03)
	}
	voices.clear()
}

/** True while a synth note may still be audible to the microphone. */
export const isRinging = () => performance.now() < ringingUntil

/** The shared audio context, created on first use and resumed if the browser suspended it. */
export function audio(): AudioContext {
	ctx ??= new AudioContext()
	if (ctx.state === 'suspended') ctx.resume()
	return ctx
}

/** Tells the views that ignore the mic while the speaker plays to ignore the next `ms` too (a UI click). */
export function mask(ms: number) {
	ringingUntil = Math.max(ringingUntil, performance.now() + ms)
}

/* Reference tone ----------------------------------------------------------- */
// A string to tune against needs the exact pitch, which the plucked buffers
// cannot promise (integer delay line, up to a few cents off), and it should
// hold steady instead of dying away. So: an oscillator at the exact
// frequency, rich in overtones (up to the 12th) so the low strings stay audible
// on a phone speaker: it barely reproduces anything under ~300 Hz, and the ear
// still hears the pitch from the harmonics (the missing fundamental).
const TONE_S = 2.2
const TONE_HOLD_S = 1.5
const TONE_HARMONICS = [0, 1, 0.85, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2]
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
