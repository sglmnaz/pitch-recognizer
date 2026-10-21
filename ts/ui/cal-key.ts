// The way to the calibration page: the calibration rows of Changes In time
// and Tab and the Settings card's Calibrate key, and the state they show. A
// row blinks amber with a Calibrate key until the mic is calibrated on this
// phone, then shows the Mic delay quietly with Redo.
import * as Settings from '../core/settings'

/** Wires every [data-action="open-calibration"] under `root`, and keeps the calibration rows in step. */
export function bindCalKeys(root: ParentNode) {
	for (const button of root.querySelectorAll<HTMLElement>('[data-action="open-calibration"]')) {
		button.addEventListener('click', () => {
			location.hash = '#calibration'
		})
	}
	const rows = Array.from(root.querySelectorAll<HTMLElement>('.cal-row'))
	const sync = () => {
		const { micCalibratedAt, micDelayMs } = Settings.get()
		const due = !micCalibratedAt
		for (const row of rows) {
			row.classList.toggle('cal-row--due', due)
			row.classList.toggle('cal-row--done', !due)
			const lamp = row.querySelector<HTMLElement>('.lamp')!
			lamp.className = `lamp ${due ? 'lamp--warn' : 'lamp--ok is-on'}`
			row.querySelector('.cal-row__title')!.textContent = due ? 'Mic not calibrated' : 'Timing calibrated'
			row.querySelector('.cal-row__desc')!.textContent = due
				? 'Your timing will read late or early. 20 s, once per phone.'
				: `Mic delay ${signed(micDelayMs)} · ${day(micCalibratedAt)}`
			const key = row.querySelector<HTMLElement>('.key')!
			key.textContent = due ? 'Calibrate' : 'Redo'
			key.classList.toggle('key--hot', due)
		}
	}
	Settings.subscribe(sync)
	sync()
}

const signed = (ms: number) => `${ms < 0 ? '−' : ms > 0 ? '+' : ''}${Math.abs(ms)} ms`
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

const NOT_DONE = {
	audio: 'Not done: the beat lights may drift from the clicks',
	mic: 'Not done: Changes and Tab will misjudge your timing',
}

/** Fills the [data-cal-*] parts under `root` (lamp, value, when, desc) for both steps. */
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
		for (const el of root.querySelectorAll<HTMLElement>(`[data-cal-value="${key}"]`)) el.textContent = done ? signed(ms) : '— —'
		for (const el of root.querySelectorAll<HTMLElement>(`[data-cal-when="${key}"]`)) el.textContent = done ? `Done ${day(at)}` : 'Not done'
		for (const el of root.querySelectorAll<HTMLElement>(`[data-cal-desc="${key}"]`)) el.textContent = done ? `Done ${day(at)}` : NOT_DONE[key]
	}
}
