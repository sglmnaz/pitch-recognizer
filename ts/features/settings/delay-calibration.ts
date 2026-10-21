import * as Metronome from '../../core/metronome'
import * as Settings from '../../core/settings'
import * as Latency from '../../core/latency'

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
