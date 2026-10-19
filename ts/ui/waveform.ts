// The live waveform strip in the shared #mic block: a scope-like trace of the
// latest mic samples, triggered on a rising zero crossing and auto-ranged.
import * as Microphone from '../core/microphone'
import { clamp } from '../core/math'

// ~23 ms at 44.1 kHz: two periods of the low E string, many of the high ones.
const WAVE_SAMPLES = 1024
// Display-only automatic gain, like a scope's auto-range: the trace aims for
// WAVE_TARGET of the half-height, so a loud acoustic and an unplugged electric
// look alike, with headroom. The remembered peak jumps up at once (never
// clips) and decays slowly (WAVE_RELEASE per frame, ~0.4 s half-life) so the
// trace does not pump. The gain is capped by how tall room noise would be
// drawn: WAVE_NOISE_SILENT while nothing is sounding (silence stays almost
// flat), WAVE_NOISE_SOUNDING once the gate hears a note, so a quiet source
// (an unplugged electric) still fills the strip. The noise level is the
// average trace peak while nothing is sounding, so it calibrates itself.
const WAVE_TARGET = 0.6
const WAVE_RELEASE = 0.97
const WAVE_NOISE_SILENT = 0.04
const WAVE_NOISE_SOUNDING = 0.3
const WAVE_GAIN_BEFORE_NOISE = 4 // until some silence has been heard
let wavePeak = 0
let noisePeak = 0

/** Draws the latest samples into `waveform` (a flat line while the mic is off); `voiced` = a note is being read. */
export function drawWaveform(waveform: HTMLCanvasElement, voiced: boolean) {
	const dpr = window.devicePixelRatio || 1
	const width = Math.round(waveform.clientWidth * dpr)
	const height = Math.round(waveform.clientHeight * dpr)
	if (waveform.width !== width || waveform.height !== height) {
		waveform.width = width
		waveform.height = height
	}

	const data = Microphone.getWaveform()
	waveform.classList.toggle('wave--live', data !== null)
	waveform.classList.toggle('wave--voiced', voiced)

	const ctx = waveform.getContext('2d')
	if (!ctx || width === 0) return
	ctx.clearRect(0, 0, width, height)
	ctx.strokeStyle = getComputedStyle(waveform).color
	ctx.lineWidth = 1.5 * dpr
	ctx.lineJoin = 'round'
	ctx.beginPath()

	if (!data) {
		ctx.moveTo(0, height / 2)
		ctx.lineTo(width, height / 2)
	} else {
		// Start at a rising zero crossing so a steady note stands still on screen
		// instead of scrolling, like an oscilloscope trigger.
		let start = data.length - 2 * WAVE_SAMPLES
		for (let i = start; i < data.length - WAVE_SAMPLES; i++) {
			if (data[i - 1] < 0 && data[i] >= 0) {
				start = i
				break
			}
		}
		let peak = 0
		for (let i = start; i < start + WAVE_SAMPLES; i++) peak = Math.max(peak, Math.abs(data[i]))
		wavePeak = Math.max(peak, wavePeak * WAVE_RELEASE)
		const sounding = Microphone.isSounding()
		if (!sounding) noisePeak = noisePeak ? 0.95 * noisePeak + 0.05 * peak : peak
		const noiseCap = noisePeak ? (sounding ? WAVE_NOISE_SOUNDING : WAVE_NOISE_SILENT) / noisePeak : WAVE_GAIN_BEFORE_NOISE
		const gain = Math.min(noiseCap, WAVE_TARGET / Math.max(wavePeak, 1e-9))
		for (let x = 0; x <= width; x++) {
			const sample = data[start + Math.floor((x / width) * (WAVE_SAMPLES - 1))]
			const y = height / 2 - clamp(sample * gain, -1, 1) * (height / 2 - ctx.lineWidth)
			if (x === 0) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
	}
	ctx.stroke()
}
