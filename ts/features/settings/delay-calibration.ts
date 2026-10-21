import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import * as Latency from '../../core/latency'
import * as Tab from '../../music/tab'
import { micState, setListening } from '../../ui/mic-block'

/**
 * Settings → Metronome → Audio delay → Calibrate: the metronome clicks at
 * 75 BPM with no delay of ours and the user taps the pad on each click heard.
 * How far the taps land behind the moment the browser says the click is heard
 * (ts/core/latency.ts) becomes the setting. Borrows the shared engine, so it
 * waits for the Metronome tab's own clicks to stop; leaving the tab cancels it.
 */
export function createDelayCalibration(root: HTMLElement): { cancel(): void } {
	const button = root.querySelector<HTMLButtonElement>('[data-action="calibrate-delay"]')!
	const panel = root.querySelector<HTMLElement>('[data-calibrate]')!
	const pad = root.querySelector<HTMLButtonElement>('[data-calibrate-pad]')!
	const status = root.querySelector<HTMLElement>('[data-calibrate-status]')!
	const beatMs = 60000 / Latency.CALIBRATION_BPM

	let clicks: number[] = []
	let taps: number[] = []
	let off: (() => void) | null = null
	let finishTimer = 0

	const say = (text: string) => (status.textContent = text)

	function start() {
		panel.hidden = false
		if (Metronome.getState().running) {
			say('Stop the metronome first, then calibrate.')
			return
		}
		clicks = []
		taps = []
		button.textContent = 'Cancel'
		pad.disabled = false
		say(`Listen for ${Latency.LISTEN_CLICKS} clicks, then tap the pad on every click you hear.`)
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
			const left = Latency.CALIBRATION_CLICKS - clicks.length
			if (clicks.length > Latency.LISTEN_CLICKS) say(left > 0 ? `Tap on every click · ${left} to go` : 'Last one…')
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
		button.textContent = 'Calibrate'
		// Back to the stored delay; a new one comes through Settings.update below.
		Metronome.configure({ outputDelayMs: Settings.get().audioDelayMs })
	}

	function finish() {
		stopClicks()
		const read = Latency.estimateDelay(clicks, taps, beatMs)
		if (!read) return say('Not enough taps. Try again, one tap on each click.')
		if (read.spread > Latency.MAX_SPREAD_MS) return say(`Taps too uneven (±${Math.round(read.spread)} ms). Try again, as steady as you can.`)
		const ms = Latency.delaySetting(read.lag)
		Settings.update({ audioDelayMs: ms })
		say(`Measured ${Math.round(read.lag)} ms from ${read.taps} taps: set to ${ms} ms.`)
	}

	function cancel() {
		if (!off) return
		stopClicks()
		say('Cancelled.')
	}

	button.addEventListener('click', () => (off ? cancel() : start()))
	// pointerdown, not click: the press is the moment the finger meets the glass.
	pad.addEventListener('pointerdown', (event) => {
		if (off) taps.push(event.timeStamp)
	})
	pad.addEventListener('keydown', (event) => {
		if (off && (event.key === ' ' || event.key === 'Enter') && !event.repeat) taps.push(event.timeStamp)
	})

	return { cancel }
}

/**
 * Settings → Metronome → Mic delay → Calibrate: the metronome clicks out loud
 * at 75 BPM, Audio delay included, and the mic listens for them. How far each
 * click is heard behind its BeatEvent.heardAt, picked and dated like Trainer →
 * Tab's notes, becomes the setting: Changes and Tab then judge what they hear
 * that much earlier, the whole round trip (speaker, room, input path) whatever
 * Audio delay says. Turns the mic on for the run and off after.
 */
export function createMicCalibration(root: HTMLElement): { frame(): void; cancel(): void } {
	const button = root.querySelector<HTMLButtonElement>('[data-action="calibrate-mic"]')!
	const status = root.querySelector<HTMLElement>('[data-mic-calibrate-status]')!
	const beatMs = 60000 / Latency.CALIBRATION_BPM
	const onsets = Tab.createOnsetDetector()

	let clicks: number[] = []
	let picks: number[] = []
	let frames = 0
	let off: (() => void) | null = null
	let finishTimer = 0

	const say = (text: string) => {
		status.hidden = false
		status.textContent = text
	}

	function start() {
		if (Metronome.getState().running) return say('Stop the metronome first, then calibrate.')
		clicks = []
		picks = []
		frames = 0
		onsets.reset()
		button.textContent = 'Cancel'
		say(`Volume up, no headphones, quiet please: listening for ${Latency.CALIBRATION_CLICKS} clicks…`)
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
		Metronome.setTempo(Latency.CALIBRATION_BPM)
		off = Metronome.onBeat((event) => {
			clicks.push(event.heardAt)
			// The last click still has to reach the mic: stop a beat later.
			if (clicks.length === Latency.CALIBRATION_CLICKS) finishTimer = window.setTimeout(finish, beatMs)
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
		button.textContent = 'Calibrate'
		Metronome.configure({ outputDelayMs: Settings.get().audioDelayMs })
	}

	function finish() {
		stopRun()
		if (!frames) return say('The microphone is off or blocked: allow it, then try again.')
		const read = Latency.estimateDelay(clicks, picks, beatMs)
		if (!read) return say('Not enough clicks heard. Turn the volume up, take off headphones and try again.')
		if (read.spread > Latency.MAX_SPREAD_MS) return say(`Clicks heard too unevenly (±${Math.round(read.spread)} ms). Try again somewhere quieter.`)
		const ms = Latency.delaySetting(read.lag)
		Settings.update({ micDelayMs: ms })
		say(`The mic heard ${read.taps} clicks ${Math.round(read.lag)} ms late: set to ${ms} ms.`)
	}

	button.addEventListener('click', () => (off ? cancel() : start()))

	function cancel() {
		if (!off) return
		stopRun()
		// A mic that fails to start stops itself, and that resets the view: say why.
		say(micState() === 'blocked' ? 'The microphone is blocked: allow it in the browser, then try again.' : 'Cancelled.')
	}

	return {
		/** One mic frame while the Settings tab is open. */
		frame() {
			if (!off) return
			frames++
			const now = performance.now()
			const wave = Microphone.getWaveform()
			if (wave && onsets.feed(now, Tab.newestEnergy(wave))) picks.push(now - Tab.ATTACK_LATENCY_MS)
		},
		cancel,
	}
}
