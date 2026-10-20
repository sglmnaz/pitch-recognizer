import * as Settings from '../core/settings'
import { audio, mask } from '../core/sound'

/*
 * Tactile feedback: tiny synthesized sounds and vibrations when a control is
 * pressed, so the hardware look also feels like hardware. No audio files: a
 * few milliseconds of filtered noise, built on the shared
 * audio context (zero latency, nothing to download).
 *
 *   key     a momentary key goes down
 *   latch   a latching key sinks (down) or comes back up
 *   rocker  a rocker switch flips on or off
 *   detent  one click of a knob, a stepper or a dropdown
 *
 * Wired once by delegation (initFeedback); the rotary and the dropdown call
 * detent() themselves. Settings: uiSounds, haptics, uiVolume. Every sound
 * masks the mic for a moment (Sound.mask), so the views that listen don't
 * read their own clicks. Vibration: navigator.vibrate where it exists
 * (Android); on iPhone (no Vibration API) a hidden native switch toggled from
 * a tap makes the Taptic Engine tick (iOS 18+), silently elsewhere.
 */

type Kind = 'key' | 'latch' | 'rocker' | 'detent'

let noiseBuffer: AudioBuffer | null = null

function noise(at: number, dur: number, type: BiquadFilterType, frequency: number, q: number, level: number) {
	const ctx = audio()
	if (!noiseBuffer) {
		noiseBuffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.1), ctx.sampleRate)
		const data = noiseBuffer.getChannelData(0)
		for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
	}
	const source = ctx.createBufferSource()
	source.buffer = noiseBuffer
	const filter = ctx.createBiquadFilter()
	filter.type = type
	filter.frequency.value = frequency
	filter.Q.value = q
	const gain = ctx.createGain()
	gain.gain.setValueAtTime(level, at)
	gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
	source.connect(filter).connect(gain).connect(ctx.destination)
	source.start(at)
	source.stop(at + dur + 0.01)
}

// The approved sounds, chosen by ear: key K5, latch L6, rocker R1, detent D1. `v` = volume,
// `on` = going down / switching on.
const SOUNDS: Record<Kind, (at: number, v: number, on: boolean) => void> = {
	key: (at, v) => noise(at, 0.007, 'bandpass', 3600, 3, 0.45 * v),
	// A click, then the latch catching with a small metallic ring.
	latch: (at, v, on) => {
		noise(at, 0.006, 'bandpass', 3000, 3, 0.55 * v)
		noise(at + (on ? 0.022 : 0.014), 0.008, 'bandpass', on ? 4600 : 5200, 8, 0.4 * v)
	},
	rocker: (at, v, on) => {
		noise(at, 0.01, 'bandpass', on ? 3200 : 2600, 5, 0.9 * v)
		noise(at + 0.009, 0.012, 'bandpass', on ? 1800 : 1500, 3, 0.6 * v)
	},
	detent: (at, v) => noise(at, 0.003, 'highpass', 5000, 0.7, 0.7 * v),
}

// Vibration lengths (ms): a rocker is a snap with a settle.
const BUZZ: Record<Kind, number | number[]> = { key: 8, latch: 14, rocker: [6, 25, 10], detent: 3 }

// iPhone: a native switch toggled from a tap ticks the Taptic Engine.
let iosSwitch: HTMLLabelElement | null = null
function iosTick() {
	if (!iosSwitch) {
		iosSwitch = document.createElement('label')
		iosSwitch.setAttribute('aria-hidden', 'true')
		iosSwitch.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
		const input = document.createElement('input')
		input.type = 'checkbox'
		input.setAttribute('switch', '')
		input.tabIndex = -1
		iosSwitch.append(input)
		document.body.append(iosSwitch)
	}
	iosSwitch.click()
}

/** Plays one feedback: sound and vibration, as the settings allow. */
export function feedback(kind: Kind, on = true) {
	const { uiSounds, haptics, uiVolume } = Settings.get()
	if (uiSounds && uiVolume > 0) {
		SOUNDS[kind](audio().currentTime + 0.002, uiVolume, on)
		mask(60)
	}
	if (haptics) {
		if ('vibrate' in navigator) navigator.vibrate(BUZZ[kind])
		else iosTick()
	}
}

export const detent = () => feedback('detent')

const KEYS = '.key, .btn, .chip, .link-btn, .segmented > button, .tab'
// Keys that stay down: interlocked ones (one of a row) and any aria-pressed toggle.
const INTERLOCKED = '.segmented > button, .tab'
const latching = (key: Element) => key.matches(`${INTERLOCKED}, [aria-pressed]`)
const pressed = (key: Element) => key.getAttribute('aria-pressed') === 'true' || key.getAttribute('aria-selected') === 'true'

/** Wires the feedback for every key and switch in the app (call once at boot). */
export function initFeedback() {
	document.addEventListener(
		'pointerdown',
		(event) => {
			if (event.button !== 0) return
			const key = (event.target as Element).closest(KEYS)
			if (!key || key.matches(':disabled, [aria-disabled="true"]')) return
			if (key.matches('.key--step')) feedback('detent')
			else if (latching(key)) {
				// An interlocked key or a tab already down stays down: no sound.
				if (pressed(key) && key.matches(INTERLOCKED)) return
				feedback('latch', !pressed(key))
			} else feedback('key')
		},
		{ passive: true }
	)
	document.addEventListener('change', (event) => {
		const input = event.target as HTMLInputElement
		if (input.matches('.switch__input')) feedback('rocker', input.checked)
	})
}
