import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import * as Latency from '../../core/latency'
import * as Tab from '../../music/tab'
import { micState, setListening } from '../../ui/mic-block'
import { t } from '../../core/i18n'

/**
 * The parts of a step card (index.html, #view-calibration) a run fills: its
 * Start key (Cancel while running), the running panel, the count, one segment
 * per click, the line under it. A segment lights as its click goes by.
 */
function stepParts(step: HTMLElement, clicks: number) {
	const part = <T extends HTMLElement>(name: string) => step.querySelector<T>(`[data-${name}]`)!
	const start = part<HTMLButtonElement>('start')
	const run = part('run')
	const count = part('count')
	const dots = part('dots')
	const status = part('status')
	return {
		say: (text: string) => (status.textContent = text),
		count: (n: number) => (count.textContent = String(n)),
		begin() {
			run.hidden = false
			start.textContent = t('Cancel')
			count.textContent = '0'
			dots.replaceChildren(...Array.from({ length: clicks }, () => document.createElement('i')))
			dots.style.setProperty('--n', String(clicks))
		},
		tick(index: number) {
			dots.querySelectorAll('i').forEach((dot, i) => {
				dot.classList.toggle('on', i <= index)
				dot.classList.toggle('now', i === index + 1)
			})
		},
		end() {
			run.hidden = true
			// Start or Redo (data-label, set by the calibration view).
			start.textContent = start.dataset.label ?? t('Start')
		},
	}
}

/**
 * Calibration step 1, your ears: the metronome clicks at 75 BPM with no delay
 * of ours and the user taps the pad on each click heard. How far the taps land
 * behind the moment the browser says the click is heard (ts/core/latency.ts)
 * becomes Audio delay. Borrows the shared engine, so it waits for the
 * Metronome tab's own clicks to stop; leaving the page cancels it.
 */
export function createDelayCalibration(step: HTMLElement, onDone: () => void): { cancel(): void } {
	const ui = stepParts(step, Latency.CALIBRATION_CLICKS)
	const pad = step.querySelector<HTMLButtonElement>('[data-pad]')!
	const beatMs = 60000 / Latency.CALIBRATION_BPM

	let clicks: number[] = []
	let taps: number[] = []
	let off: (() => void) | null = null
	let finishTimer = 0

	function start() {
		if (Metronome.getState().running) return ui.say(t('Stop the metronome first, then calibrate.'))
		clicks = []
		taps = []
		ui.begin()
		pad.disabled = false
		ui.say(t('Listen for {n} clicks, then tap the pad on every click you hear.', { n: Latency.LISTEN_CLICKS }))
		const s = Settings.get()
		Metronome.configure({
			beats: 4,
			accents: [1, 1, 1, 1],
			subdivision: 1,
			sound: 'click',
			volume: s.metroVolume,
			trainer: { enabled: false, step: 5, bars: 4, target: 160 },
			outputDelayMs: 0,
		})
		Metronome.setTempo(Latency.CALIBRATION_BPM)
		off = Metronome.onBeat((event) => {
			clicks.push(event.heardAt)
			ui.tick(clicks.length - 1)
			const left = Latency.CALIBRATION_CLICKS - clicks.length
			if (clicks.length > Latency.LISTEN_CLICKS) ui.say(left > 0 ? t('Tap on every click · {n} to go', { n: left }) : t('Last one…'))
			// The last click still gets its tap: stop a beat later.
			if (left === 0) finishTimer = window.setTimeout(finish, beatMs)
		})
		Metronome.start()
	}

	function stopClicks() {
		clearTimeout(finishTimer)
		off?.()
		off = null
		Metronome.stop()
		pad.disabled = true
		ui.end()
		// Back to the stored delay; a new one comes through Settings.update below.
		Metronome.configure({ outputDelayMs: Settings.get().audioDelayMs })
	}

	function finish() {
		stopClicks()
		const read = Latency.estimateDelay(clicks, taps, beatMs)
		if (!read) return ui.say(t('Not enough taps. Try again, one tap on each click.'))
		if (read.spread > Latency.MAX_SPREAD_MS) return ui.say(t('Taps too uneven (±{ms} ms). Try again, as steady as you can.', { ms: Math.round(read.spread) }))
		const ms = Latency.delaySetting(read.lag)
		Settings.update({ audioDelayMs: ms, audioCalibratedAt: Date.now() })
		ui.say(t('Measured {lag} ms from {taps} taps: set to {ms} ms.', { lag: Math.round(read.lag), taps: read.taps, ms }))
		onDone()
	}

	function cancel() {
		if (!off) return
		stopClicks()
		ui.say(t('Cancelled.'))
	}

	function tap(at: number) {
		if (!off) return
		taps.push(at)
		ui.count(taps.length)
	}

	step.querySelector('[data-start]')!.addEventListener('click', () => (off ? cancel() : start()))
	// pointerdown, not click: the press is the moment the finger meets the glass.
	pad.addEventListener('pointerdown', (event) => tap(event.timeStamp))
	pad.addEventListener('keydown', (event) => {
		if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) tap(event.timeStamp)
	})

	return { cancel }
}

// The live level bar: dB of the newest samples' energy over this range.
const LEVEL_FLOOR_DB = -80
const LEVEL_TOP_DB = -10

/**
 * Calibration step 2, the microphone: the metronome clicks out loud at 40 BPM
 * (Latency.MIC_CALIBRATION_BPM), Audio delay included, and the mic listens for
 * them. How far each click is heard behind its BeatEvent.heardAt (its
 * strongest energy jump, Latency.estimateOnsetDelay; dated like Trainer →
 * Tab's picks) becomes Mic delay: Changes and Tab then judge what they hear
 * that much earlier, the whole round trip (speaker, room, input path)
 * whatever Audio delay says. Turns the mic on for the run and off after.
 */
export function createMicCalibration(step: HTMLElement, onDone: () => void): { frame(): void; cancel(): void } {
	const ui = stepParts(step, Latency.MIC_CALIBRATION_CLICKS)
	const level = step.querySelector<HTMLElement>('[data-level]')!
	const beatMs = 60000 / Latency.MIC_CALIBRATION_BPM

	let clicks: number[] = []
	// Every mic frame's time (dated like Tab's picks) and the energy of its newest samples.
	let frames: { at: number; energy: number }[] = []
	let off: (() => void) | null = null
	let finishTimer = 0

	function start() {
		if (Metronome.getState().running) return ui.say(t('Stop the metronome first, then calibrate.'))
		clicks = []
		frames = []
		ui.begin()
		ui.say(t('Keep still and quiet: the phone plays a click every 1.5 s and listens for it.'))
		const s = Settings.get()
		Metronome.configure({
			beats: 4,
			accents: [1, 1, 1, 1],
			subdivision: 1,
			sound: 'click',
			// Full volume: the mic has to hear every click over the room.
			volume: 1,
			trainer: { enabled: false, step: 5, bars: 4, target: 160 },
			outputDelayMs: s.audioDelayMs,
		})
		Metronome.setTempo(Latency.MIC_CALIBRATION_BPM)
		off = Metronome.onBeat((event) => {
			clicks.push(event.heardAt)
			ui.count(clicks.length)
			ui.tick(clicks.length - 1)
			// The last click still has to reach the mic: stop a beat later.
			if (clicks.length === Latency.MIC_CALIBRATION_CLICKS) finishTimer = window.setTimeout(finish, beatMs)
		})
		setListening(true)
		Metronome.start()
	}

	function stopRun() {
		clearTimeout(finishTimer)
		off?.()
		off = null
		Metronome.stop()
		setListening(false)
		ui.end()
		Metronome.configure({ outputDelayMs: Settings.get().audioDelayMs })
	}

	function finish() {
		stopRun()
		if (!frames.length) return ui.say(t('The microphone is off or blocked: allow it, then try again.'))
		const read = Latency.estimateOnsetDelay(clicks, frames, beatMs, Latency.MIC_AHEAD_MS)
		if (!read) return ui.say(t('Not enough clicks heard. Turn the volume up, take off headphones and try again.'))
		if (read.spread > Latency.MAX_SPREAD_MS)
			return ui.say(t('Clicks heard too unevenly (±{ms} ms). Try again somewhere quieter.', { ms: Math.round(read.spread) }))
		const ms = Latency.delaySetting(read.lag, Latency.MAX_MIC_DELAY_MS, Latency.MIN_MIC_DELAY_MS)
		Settings.update({ micDelayMs: ms, micCalibratedAt: Date.now() })
		ui.say(
			t('The mic heard {heard} of {clicks} clicks, steady within ±{spread} ms: set to {ms} ms.', {
				heard: read.taps,
				clicks: clicks.length - Latency.LISTEN_CLICKS,
				spread: Math.round(read.spread),
				ms,
			})
		)
		onDone()
	}

	function cancel() {
		if (!off) return
		stopRun()
		// A mic that fails to start stops itself, and that resets the view: say why.
		ui.say(micState() === 'blocked' ? t('The microphone is blocked: allow it in the browser, then try again.') : t('Cancelled.'))
	}

	step.querySelector('[data-start]')!.addEventListener('click', () => (off ? cancel() : start()))

	return {
		/** One mic frame while the calibration page is open. */
		frame() {
			if (!off) return
			const wave = Microphone.getWaveform()
			if (!wave) return
			const energy = Tab.newestEnergy(wave)
			frames.push({ at: performance.now() - Tab.ATTACK_LATENCY_MS, energy })
			const db = energy > 0 ? 10 * Math.log10(energy) : LEVEL_FLOOR_DB
			level.style.setProperty('--level', `${Math.round((100 * (db - LEVEL_FLOOR_DB)) / (LEVEL_TOP_DB - LEVEL_FLOOR_DB))}%`)
		},
		cancel,
	}
}
