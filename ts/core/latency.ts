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
export const MAX_DELAY_MS = 400

export interface DelayEstimate {
	/** Median lag of the taps behind the clicks, ms (may be negative: taps ahead). */
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
 * Pairs each tap with the click it answers: the one it follows by less than
 * three quarters of a beat or precedes by less than a quarter (a delay up to
 * 600 ms at 75 BPM, a tap a little ahead of the beat). One tap per click, the
 * first; taps on the listening clicks are dropped. Median, not mean: one
 * missed or doubled tap must not move the answer. Null below MIN_TAPS.
 */
export function estimateDelay(clicks: number[], taps: number[], beatMs: number): DelayEstimate | null {
	const lags: number[] = []
	const used = new Set<number>()
	for (const tap of taps) {
		const index = clicks.findIndex((click) => tap - click >= -beatMs / 4 && tap - click < (beatMs * 3) / 4)
		if (index < LISTEN_CLICKS || used.has(index)) continue
		used.add(index)
		lags.push(tap - clicks[index])
	}
	if (lags.length < MIN_TAPS) return null
	const lag = median(lags)
	return { lag, spread: median(lags.map((l) => Math.abs(l - lag))), taps: lags.length }
}

/**
 * The setting for a lag: rounded to the slider's 5 ms steps, never below 0.
 * The lag includes the touchscreen's own delay (some tens of ms on a phone),
 * so it can come out a little high; nudge it down by hand if needed.
 */
export function delaySetting(lag: number): number {
	return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(lag / 5) * 5))
}
