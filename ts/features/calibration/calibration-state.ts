// The ways to the calibration page (the Settings section's Calibrate key, the
// "Timing calibration" link of Changes and Tab) and the state of its two steps
// as the Settings section and the page show it: the value, when it was done,
// a lamp green once done, amber until then.
import * as Settings from '../../core/settings'

/** Wires every [data-action="open-calibration"] under `root` to open the page. */
export function bindCalibrationLinks(root: ParentNode) {
	for (const button of root.querySelectorAll<HTMLElement>('[data-action="open-calibration"]')) {
		button.addEventListener('click', () => {
			location.hash = '#calibration'
		})
	}
}

const signed = (ms: number) => `${ms < 0 ? '−' : ms > 0 ? '+' : ''}${Math.abs(ms)} ms`
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** Fills the [data-cal-*] parts under `root` (lamp, value, when) for both steps. */
export function showCalibrationState(root: ParentNode) {
	const s = Settings.get()
	const steps = {
		audio: { at: s.audioCalibratedAt, ms: s.audioDelayMs },
		mic: { at: s.micCalibratedAt, ms: s.micDelayMs },
	}
	for (const [key, { at, ms }] of Object.entries(steps) as [keyof typeof steps, { at: number; ms: number }][]) {
		const done = at > 0
		for (const lamp of root.querySelectorAll<HTMLElement>(`[data-cal-lamp="${key}"]`)) {
			lamp.classList.toggle('lamp--ok', done)
			lamp.classList.toggle('lamp--warn', !done)
			lamp.classList.add('is-on')
		}
		for (const el of root.querySelectorAll<HTMLElement>(`[data-cal-value="${key}"]`)) el.textContent = done ? signed(ms) : (el.dataset.calEmpty ?? '— —')
		for (const el of root.querySelectorAll<HTMLElement>(`[data-cal-when="${key}"]`)) el.textContent = done ? `Done ${day(at)}` : 'Not done'
	}
}
