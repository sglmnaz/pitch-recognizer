// Audio delay from tapping along with clicks (Settings → Metronome → Audio
// delay → Calibrate). Pure: the Settings view feeds it the times the browser
// says each click is heard (BeatEvent.heardAt, with no delay of ours added)
// and the times of the taps; `npm run check:metronome` covers it.

/** Clicks, tempo and window of a calibration run. */
export const CALIBRATION_BPM = 75
export const CALIBRATION_CLICKS = 16
/** The first clicks are for listening: taps on them are not counted. */
export const LISTEN_CLICKS = 2
/** Fewer counted taps than this: no answer. */
export const MIN_TAPS = 6
/** Taps further apart than this (median deviation, ms) are too uneven to trust. */
export const MAX_SPREAD_MS = 50
export const MIN_DELAY_MS = -200
export const MAX_DELAY_MS = 400

// Mic delay (the mic hearing the clicks): a phone's round trip, speaker to
// mic to the app, can pass half a second. At 75 BPM a click heard 640 ms late
// paired with the next one and read -160 ms, so these clicks are slower and a
// heard click may come up to MIC_AHEAD_MS early or a beat less that late.
export const MIC_CALIBRATION_BPM = 40
export const MIC_CALIBRATION_CLICKS = 12
export const MIC_AHEAD_MS = 500
export const MIN_MIC_DELAY_MS = -500
export const MAX_MIC_DELAY_MS = 1000

export interface DelayEstimate {
	/** Median lag of the taps behind the clicks, ms (negative: taps ahead). */
	lag: number
	/** Median absolute deviation of the lags, ms. */
	spread: number
	/** Taps counted. */
	taps: number
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Pairs each tap with the click it answers: the one it precedes by up to
 * `ahead` ms or follows by less than a beat minus that (by default a quarter
 * beat: a delay up to 600 ms at 75 BPM, a tap a little ahead of the beat). One
 * tap per click, the first; taps on the listening clicks are dropped. Median,
 * not mean: one missed or doubled tap must not move the answer. Null below MIN_TAPS.
 */
export function estimateDelay(clicks: number[], taps: number[], beatMs: number, ahead = beatMs / 4): DelayEstimate | null {
	const lags: number[] = []
	const used = new Set<number>()
	for (const tap of taps) {
		const index = clicks.findIndex((click) => tap - click >= -ahead && tap - click < beatMs - ahead)
		if (index < LISTEN_CLICKS || used.has(index)) continue
		used.add(index)
		lags.push(tap - clicks[index])
	}
	if (lags.length < MIN_TAPS) return null
	const lag = median(lags)
	return { lag, spread: median(lags.map((l) => Math.abs(l - lag))), taps: lags.length }
}

// Mic delay: each click is the strongest jump in energy near it (the energy of
// a frame over the quietest of the ONSET_LOOK_MS before it), not the first
// pick: on a phone the room and the click's own tail fired picks all through
// the window, and the first one always sat at the window's start (-160, -245,
// -445 ms for windows from -200, -300, -500). A click at full volume is the
// loudest thing in the room; a jump under MIN_STRENGTH is not one.
const ONSET_LOOK_MS = 100
export const MIN_STRENGTH = 3

/**
 * The mic's lag behind each click (after the listening ones): the frame with
 * the strongest energy jump from `ahead` ms before the click to a beat minus
 * that after it. `frames` = each mic frame's time and energy (oldest first).
 * Median and spread as estimateDelay; null below MIN_TAPS clicks heard.
 */
export function estimateOnsetDelay(clicks: number[], frames: { at: number; energy: number }[], beatMs: number, ahead: number): DelayEstimate | null {
	const lags: number[] = []
	for (const click of clicks.slice(LISTEN_CLICKS)) {
		let best = 0
		let bestAt = 0
		for (let i = 0; i < frames.length; i++) {
			const { at, energy } = frames[i]
			if (at < click - ahead || at >= click + beatMs - ahead) continue
			let quietest = Infinity
			for (let j = i - 1; j >= 0 && frames[j].at >= at - ONSET_LOOK_MS; j--) quietest = Math.min(quietest, frames[j].energy)
			const strength = quietest > 0 && quietest < Infinity ? energy / quietest : 0
			if (strength > best) {
				best = strength
				bestAt = at
			}
		}
		if (best >= MIN_STRENGTH) lags.push(bestAt - click)
	}
	if (lags.length < MIN_TAPS) return null
	const lag = median(lags)
	return { lag, spread: median(lags.map((l) => Math.abs(l - lag))), taps: lags.length }
}

/**
 * The setting for a lag: rounded to the slider's 5 ms steps, within the
 * setting's range. Negative when taps land ahead of where the browser places
 * the click (it over-reports its output latency). The lag includes the
 * touchscreen's own delay (some tens of ms on a phone), so it can come out a
 * little high; nudge it down by hand if needed.
 */
export function delaySetting(lag: number, max = MAX_DELAY_MS, min = MIN_DELAY_MS): number {
	return Math.min(max, Math.max(min, Math.round(lag / 5) * 5))
}
