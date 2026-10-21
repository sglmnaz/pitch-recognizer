// Calibration → Diagnostics → Field report: the mic of the next Changes In time
// or Tab session, recorded exactly as the app hears it (voice processing off),
// with the session's whole timing log, the settings and the device. Shared as
// two files, it can be replayed offline through the same code to see what went
// wrong on someone's phone instead of guessing from summaries. The reports live
// until the app closes.
import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import type { ProbeSession } from '../trainer/timing-probe'

// A longer session keeps its log; the recording stops here (a few MB).
const MAX_RECORD_MS = 180_000

export interface FieldReport {
	title: string
	when: Date
	durationMs: number
	audio: Blob
	log: Blob
	events: number
}

let armed = false
let recording: { recorder: MediaRecorder; chunks: Blob[]; startedAt: number; stopTimer: number } | null = null
const reports: FieldReport[] = []
const listeners: (() => void)[] = []
const changed = () => {
	for (const listener of listeners) listener()
}

export const isArmed = () => armed
export const getReports = (): readonly FieldReport[] => reports
/** `listener` runs when arming changes or a report is ready. */
export function onReports(listener: () => void) {
	listeners.push(listener)
}

export function arm(on: boolean) {
	armed = on
	changed()
}

/** A Changes In time or Tab session started: record it if armed (the mic is on by then). */
export function sessionStarted() {
	const stream = Microphone.getStream()
	if (!armed || recording || !stream || typeof MediaRecorder === 'undefined') return
	const recorder = new MediaRecorder(stream)
	const chunks: Blob[] = []
	recorder.ondataavailable = (event) => chunks.push(event.data)
	recorder.start()
	recording = { recorder, chunks, startedAt: performance.now(), stopTimer: window.setTimeout(() => recorder.stop(), MAX_RECORD_MS) }
}

/** The session ended: its report is the recording plus `session`'s log. */
export function sessionEnded(session: ProbeSession, title: string) {
	const run = recording
	if (!run) return
	recording = null
	armed = false
	clearTimeout(run.stopTimer)
	const finished = () => {
		const audio = new Blob(run.chunks, { type: run.recorder.mimeType })
		const s = Settings.get()
		const log = {
			version: 1,
			title,
			userAgent: navigator.userAgent,
			// Times in the log are performance.now(); the recording starts at recordStartedAt.
			recordStartedAt: run.startedAt,
			recordMimeType: run.recorder.mimeType,
			latency: Metronome.latencies(),
			micTrack: Microphone.getStream()?.getAudioTracks()[0]?.getSettings() ?? null,
			settings: {
				audioDelayMs: s.audioDelayMs,
				micDelayMs: s.micDelayMs,
				a4: s.a4,
				changesBpm: s.changesBpm,
				changesBeats: s.changesBeats,
				changesChords: s.changesChords,
			},
			summary: session.summary,
			entries: session.entries,
		}
		reports.unshift({
			title,
			when: new Date(),
			durationMs: performance.now() - run.startedAt,
			audio,
			log: new Blob([JSON.stringify(log)], { type: 'application/json' }),
			events: session.entries.length,
		})
		changed()
	}
	if (run.recorder.state === 'inactive') finished()
	else {
		run.recorder.onstop = finished
		run.recorder.stop()
	}
}

const extension = (type: string) => (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm')

/** Shares the report's two files (the system sheet), or downloads them where sharing files is not supported. */
export async function shareReport(report: FieldReport) {
	const stamp = report.when.toISOString().replace(/[:.]/g, '-')
	const files = [
		new File([report.audio], `pluck-report-${stamp}.${extension(report.audio.type)}`, { type: report.audio.type }),
		new File([report.log], `pluck-report-${stamp}.json`, { type: 'application/json' }),
	]
	if (navigator.canShare?.({ files })) {
		try {
			await navigator.share({ files, title: `Pluck report · ${report.title}` })
			return
		} catch {
			// Dismissed, or not allowed: download instead.
		}
	}
	for (const file of files) {
		const link = document.createElement('a')
		link.href = URL.createObjectURL(file)
		link.download = file.name
		link.click()
		setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
	}
}

export function deleteReport(report: FieldReport) {
	const i = reports.indexOf(report)
	if (i >= 0) reports.splice(i, 1)
	changed()
}
