// The calibration page (#calibration, no tab of its own): two guided steps,
// your ears (Audio delay, tapping) and the microphone (Mic delay, the phone
// hearing its own clicks), then Diagnostics: the field report, a live mic
// check, the last session's timeline and log, fine-tuning by hand. Opened from
// the Settings card and the CAL keys; Back returns where you came from.
import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import { clamp } from '../../core/math'
import { loadChordModel } from '../../music/chords'
import type { View } from '../../ui/view'
import { scoped } from '../../ui/dom'
import { setListening } from '../../ui/mic-block'
import { showCalibrationState } from '../../ui/cal-key'
import { heardChord, resetHeard, strummed } from '../trainer/changes.recognizer'
import type { ProbeEntry } from '../trainer/timing-probe'
import { MAX_FLATNESS, spectralFlatness } from '../../music/changes'
import { changesTimeline, lastSession, onSession, TIMELINE_AFTER, TIMELINE_BEFORE, type TimelineRow } from '../trainer/timing-probe'
import { createDelayCalibration, createMicCalibration } from './delay-calibration'
import * as FieldReport from './field-report'

const TAB_LABELS: Record<string, string> = {
	tuner: 'Tuner',
	chords: 'Chords',
	scales: 'Scales',
	trainer: 'Trainer',
	metronome: 'Metronome',
	settings: 'Settings',
}
// The delays' ranges (core/settings.ts load()).
const RANGES = { audioDelayMs: [-200, 400], micDelayMs: [-500, 1000] } as const
// A change further off than this is an outlier on the timeline (the on-time window is 120–200 ms).
const OUTLIER_MS = 200
// The mic check counts a strum once the sound this long after it shows pitch.
const TONAL_AFTER_MS = 80
// The mic check's level bar: dB over this range.
const LEVEL_FLOOR_DB = -80
const LEVEL_TOP_DB = -10

const dB = (rms: number) => (rms > 0 ? 20 * Math.log10(rms) : -Infinity)
const levelPercent = (db: number) => `${clamp((100 * (db - LEVEL_FLOOR_DB)) / (LEVEL_TOP_DB - LEVEL_FLOOR_DB), 0, 100).toFixed(0)}%`
const signed = (ms: number) => `${ms < 0 ? '−' : '+'}${Math.abs(Math.round(ms))}`

/** Mic check: the live level and room noise, each strum counted (with a lamp), the chord heard and how long naming it took. */
function createMicCheck(card: HTMLElement) {
	const { $ } = scoped(card)
	const button = $<HTMLButtonElement>('[data-start]')
	const level = $<HTMLElement>('[data-level]')
	const floor = $<HTMLElement>('[data-floor]')
	const levels = $<HTMLElement>('[data-levels]')
	const strumCount = $<HTMLElement>('[data-strums]')
	const chordText = $<HTMLElement>('[data-chord]')
	const namingText = $<HTMLElement>('[data-naming]')
	const strumLamp = $<HTMLElement>('[data-strum-lamp]')
	const soundingLamp = $<HTMLElement>('[data-sounding-lamp]')

	let on = false
	let strums = 0
	// Strums wait TONAL_AFTER_MS: one counts only if the sound then has pitch (not a breath or a blow).
	let pending: number[] = []
	let lastStrum: number | null = null
	let lastChord: string | null = null
	let lampTimer = 0
	// With Record sessions on, a run is a field report: every strum the detector fired, those counted.
	let entries: ProbeEntry[] = []

	function start() {
		on = true
		strums = 0
		pending = []
		entries = []
		lastStrum = null
		lastChord = null
		strumCount.textContent = '0'
		chordText.textContent = '–'
		namingText.textContent = '–'
		button.textContent = 'Stop'
		resetHeard()
		loadChordModel().catch(() => {}) // logged once by the loader
		setListening(true)
	}

	function stop() {
		if (!on) return
		on = false
		button.textContent = 'Start'
		const fired = entries.filter((e) => e.kind === 'strum').length
		const summary = `Mic check · ${strums} strums counted of ${fired} fired · noise floor ${Math.round(dB(Microphone.getStats().noiseFloor))} dB`
		FieldReport.sessionEnded({ entries, summary }, 'Mic check')
		setListening(false)
		soundingLamp.classList.remove('is-on')
	}

	button.addEventListener('click', () => (on ? stop() : start()))

	return {
		stop,
		frame() {
			if (!on) return
			const now = performance.now()
			const { volume, noiseFloor } = Microphone.getStats()
			level.style.setProperty('--level', levelPercent(dB(volume)))
			floor.style.left = levelPercent(dB(noiseFloor))
			levels.textContent = `${Math.round(dB(volume))} dB · ${Math.round(dB(noiseFloor))} dB`
			soundingLamp.classList.toggle('is-on', Microphone.isSounding())
			// The mic starts after Start: recording begins with its first frame.
			FieldReport.sessionStarted()
			if (strummed(now)) {
				pending.push(now)
				entries.push({ kind: 'strum', at: now })
			}
			const power = Microphone.getFramePower()
			const tonal = power !== null && spectralFlatness(power.power, power.binHz) < MAX_FLATNESS
			const due = pending.filter((t) => now - t >= TONAL_AFTER_MS)
			pending = pending.filter((t) => now - t < TONAL_AFTER_MS)
			if (due.length && tonal) {
				strums++
				lastStrum = due[0]
				entries.push({ kind: 'counted', at: due[0] })
				strumCount.textContent = String(strums)
				strumLamp.classList.add('is-on')
				clearTimeout(lampTimer)
				lampTimer = window.setTimeout(() => strumLamp.classList.remove('is-on'), 150)
			}
			const chord = heardChord(now)?.symbol ?? null
			if (chord && chord !== lastChord && lastStrum !== null) namingText.textContent = String(Math.round(now - lastStrum))
			if (chord !== lastChord) chordText.textContent = chord ?? '–'
			lastChord = chord
		},
	}
}

/** One row of the timeline: a strip from TIMELINE_BEFORE before the downbeat to TIMELINE_AFTER after it. */
function timelineRow(row: TimelineRow): HTMLElement {
	const x = (ms: number) => `${clamp(((ms + TIMELINE_BEFORE) / (TIMELINE_BEFORE + TIMELINE_AFTER)) * 100, 0, 100).toFixed(1)}%`
	const el = (tag: string, className: string, left?: number, text = '') => {
		const node = document.createElement(tag)
		node.className = className
		if (left !== undefined) node.style.left = x(left)
		node.textContent = text
		return node
	}
	const outlier = row.dt === null || Math.abs(row.dt) > OUTLIER_MS
	const line = el('div', outlier ? 'dg-tl dg-tl--out' : 'dg-tl')
	const label = el('span', 'dg-label')
	label.append(
		el('b', '', undefined, `${row.index} · ${row.target}`),
		el('span', '', undefined, row.chosen !== null ? 'strum' : row.named !== null ? 'naming' : 'not heard')
	)
	const track = el('span', 'lcd dg-track')
	track.append(el('span', 'dg-zone'), el('span', 'dg-zero'), ...row.strums.map((t) => el('span', 'dg-tick', t)))
	if (row.named !== null) track.append(el('span', 'dg-named', row.named, 'N'))
	if (row.chosen !== null) track.append(el('span', 'dg-chosen', row.chosen))
	const frame = el('span', 'window')
	frame.append(track)
	line.append(label, frame, el('span', outlier ? 'dg-dt off' : 'dg-dt hit', undefined, row.dt === null ? 'miss' : signed(row.dt)))
	return line
}

export function createCalibrationView(root: HTMLElement, from: () => string | null): View {
	const { $, $$ } = scoped(root)
	const steps = { audio: $<HTMLElement>('[data-step="audio"]'), mic: $<HTMLElement>('[data-step="mic"]') }
	const ready = $<HTMLElement>('[data-cal-ready]')
	const backLabel = $<HTMLElement>('[data-back-label]')
	const backLink = $<HTMLElement>('.cb-back')

	// A step finished: once both are done, the way back to the exercise comes up.
	function stepDone() {
		render()
		const s = Settings.get()
		ready.hidden = !(s.audioCalibratedAt && s.micCalibratedAt)
	}
	const audio = createDelayCalibration(steps.audio, stepDone)
	const mic = createMicCalibration(steps.mic, stepDone)
	const check = createMicCheck($('[data-mic-check]'))

	for (const button of $$<HTMLElement>('[data-action="calibration-back"]')) {
		button.addEventListener('click', () => {
			location.hash = `#${from() ?? 'settings'}`
		})
	}

	/* Field report ------------------------------------------------------------ */
	const arm = $<HTMLInputElement>('[data-report-arm]')
	const armed = $<HTMLElement>('[data-report-armed]')
	const files = $<HTMLElement>('[data-reports]')
	arm.addEventListener('change', () => FieldReport.arm(arm.checked))

	function renderReports() {
		arm.checked = FieldReport.isArmed()
		armed.textContent = FieldReport.isArmed() ? 'On: every session is recorded, up to 3 minutes each; the last 3 are kept' : 'Off'
		files.replaceChildren(
			...FieldReport.getReports().map((report) => {
				const row = document.createElement('div')
				row.className = 'dg-file'
				const text = document.createElement('span')
				const title = document.createElement('b')
				title.textContent = report.title
				const meta = document.createElement('span')
				const seconds = Math.round(report.durationMs / 1000)
				meta.textContent = `${report.when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · audio + ${report.events} events · ${((report.audio.size + report.log.size) / 1e6).toFixed(1)} MB`
				text.append(title, meta)
				const keys = document.createElement('span')
				keys.className = 'dg-file__keys'
				keys.append(
					key('Download', () => FieldReport.downloadReport(report)),
					key('Share', () => FieldReport.shareReport(report)),
					key('✕', () => FieldReport.deleteReport(report), `Delete the report ${report.title}`)
				)
				row.append(text, keys)
				return row
			})
		)
		const count = FieldReport.getReports().length
		all.hidden = count < 2
		allLabel.textContent = `All ${count} reports`
	}
	const all = $<HTMLElement>('[data-reports-all]')
	const allLabel = $<HTMLElement>('[data-reports-all-label]')
	$('[data-action="reports-share-all"]').addEventListener('click', () => FieldReport.shareAll())
	$('[data-action="reports-download-all"]').addEventListener('click', () => FieldReport.downloadAll())

	function key(label: string, onClick: () => void, ariaLabel?: string) {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'key'
		button.textContent = label
		if (ariaLabel) button.setAttribute('aria-label', ariaLabel)
		button.addEventListener('click', onClick)
		return button
	}
	FieldReport.onReports(renderReports)

	/* Last session ------------------------------------------------------------ */
	const sessionSub = $<HTMLElement>('[data-session-sub]')
	const timeline = $<HTMLElement>('[data-timeline]')
	const rows = $<HTMLElement>('[data-timeline-rows]')
	const log = $<HTMLElement>('[data-session-log]')
	const logButton = $<HTMLButtonElement>('[data-action="session-log"]')
	const copyButton = $<HTMLButtonElement>('[data-action="copy-log"]')

	function renderSession() {
		const session = lastSession()
		logButton.disabled = copyButton.disabled = !session
		if (!session) return
		const timelineRows = session.exercise === 'changes' ? changesTimeline(session.entries) : []
		const outliers = timelineRows.filter((r) => r.dt === null || Math.abs(r.dt) > OUTLIER_MS).length
		const name = session.exercise === 'changes' ? 'Changes · In time' : 'Tab'
		const at = new Date(session.endedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
		sessionSub.textContent = timelineRows.length ? `${name} · ${at} · ${timelineRows.length} changes · ${outliers} outliers in red` : `${name} · ${at}`
		timeline.hidden = !timelineRows.length
		rows.replaceChildren(...timelineRows.map(timelineRow))
		log.textContent = session.summary
	}
	onSession(renderSession)
	logButton.addEventListener('click', () => {
		log.hidden = !log.hidden
		logButton.textContent = log.hidden ? 'Show log' : 'Hide log'
	})
	copyButton.addEventListener('click', () => {
		const text = lastSession()?.summary ?? ''
		navigator.clipboard?.writeText(text).then(
			() => (copyButton.textContent = 'Copied'),
			() => {
				// No clipboard: show the log to select by hand.
				log.hidden = false
				copyButton.textContent = 'Select the log'
			}
		)
	})

	/* Fine-tune by hand, device -------------------------------------------------- */
	for (const button of $$<HTMLElement>('[data-nudge]')) {
		button.addEventListener('click', () => {
			const [key, step] = button.dataset.nudge!.split(':') as [keyof typeof RANGES, string]
			const [min, max] = RANGES[key]
			Settings.update({ [key]: clamp(Settings.get()[key] + Number(step), min, max) })
		})
	}
	const device = $<HTMLElement>('[data-device]')

	function render() {
		const s = Settings.get()
		showCalibrationState(root)
		for (const [key, step] of Object.entries(steps)) {
			const start = step.querySelector<HTMLElement>('[data-start]')!
			start.dataset.label = (key === 'audio' ? s.audioCalibratedAt : s.micCalibratedAt) ? 'Redo' : 'Start'
			// The key keeps saying Cancel while its run goes on.
			if (start.textContent !== 'Cancel') start.textContent = start.dataset.label
			start.classList.toggle('key--hot', start.dataset.label === 'Start')
		}
		for (const el of $$<HTMLElement>('[data-fine]')) {
			const ms = s[el.dataset.fine as keyof typeof RANGES]
			el.textContent = `${ms < 0 ? '−' : ms > 0 ? '+' : ''}${Math.abs(ms)} MS`
		}
		const latency = Metronome.latencies()
		const track = Microphone.getStream()?.getAudioTracks()[0]?.getSettings() as { latency?: number; sampleRate?: number } | undefined
		device.textContent = `Browser: output ${latency.outputMs === null ? '– (play a click first)' : `${Math.round(latency.outputMs)} ms`} · mic ${track?.latency === undefined ? '–' : `${Math.round(track.latency * 1000)} ms`}${track?.sampleRate ? ` · ${track.sampleRate / 1000} kHz` : ''}`
	}
	Settings.subscribe(() => {
		if (!root.hidden) render()
	})

	return {
		onActivate() {
			const label = `◀ Back to ${TAB_LABELS[from() ?? 'settings'] ?? 'Settings'}`
			backLink.textContent = label
			backLabel.textContent = label.replace('◀ ', '')
			ready.hidden = true
			render()
			renderReports()
			renderSession()
		},
		onReading() {
			mic.frame()
			check.frame()
		},
		// Leaving the page stops what it runs (its clicks would follow you, the mic would stay on).
		reset() {
			audio.cancel()
			mic.cancel()
			check.stop()
		},
		// Only the mic step and the mic check listen, and they turn the mic on themselves.
		wantsMic: () => false,
	}
}
