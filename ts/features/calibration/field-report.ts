// Calibration → Diagnostics → Field report: while on (fieldReport), the mic of
// every Changes In time or Tab session, recorded exactly as the app hears it
// (voice processing off), with the session's whole timing log, the settings
// and the device. Downloaded or shared as two files (or every report, zipped
// or in one share), it is replayed offline through the same code (npm run
// replay) to see what went wrong on someone's phone instead of guessing from
// summaries. The last KEEP live until the app closes.
import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import { zip } from '../../core/zip'
import type { ProbeSession } from '../trainer/timing-probe'

// A longer session keeps its log; the recording stops here (a few MB).
const MAX_RECORD_MS = 180_000
// Reports kept (older ones dropped): a few MB each, in memory.
const KEEP = 3

export interface FieldReport {
	title: string
	when: Date
	durationMs: number
	audio: Blob
	log: Blob
	events: number
}

let recording: { recorder: MediaRecorder; chunks: Blob[]; startedAt: number; stopTimer: number } | null = null
const reports: FieldReport[] = []
const listeners: (() => void)[] = []
const changed = () => {
	for (const listener of listeners) listener()
}

export const isArmed = () => Settings.get().fieldReport
export const getReports = (): readonly FieldReport[] => reports
/** `listener` runs when arming changes or a report is ready. */
export function onReports(listener: () => void) {
	listeners.push(listener)
}

export function arm(on: boolean) {
	Settings.update({ fieldReport: on })
	changed()
}

/** A Changes In time, Tab or Mic check session started: record it if armed and the mic is on (else nothing; safe to call again). */
export function sessionStarted() {
	const stream = Microphone.getStream()
	if (!isArmed() || recording || !stream || typeof MediaRecorder === 'undefined') return
	const recorder = new MediaRecorder(stream)
	const chunks: Blob[] = []
	recorder.ondataavailable = (event) => chunks.push(event.data)
	recorder.start()
	recording = { recorder, chunks, startedAt: performance.now(), stopTimer: window.setTimeout(() => recorder.stop(), MAX_RECORD_MS) }
}

/** The session ended: its report is the recording plus `session`'s log. */
export function sessionEnded(session: Pick<ProbeSession, 'entries' | 'summary'>, title: string) {
	const run = recording
	if (!run) return
	recording = null
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
		reports.length = Math.min(reports.length, KEEP)
		changed()
	}
	if (run.recorder.state === 'inactive') finished()
	else {
		run.recorder.onstop = finished
		run.recorder.stop()
	}
}

const extension = (type: string) => (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm')

/**
 * The report's two files. The log goes as .txt: Android Chrome shares only
 * text, audio, video, images and PDF, not .json (nor .zip); replay reads either.
 */
function filesOf(report: FieldReport) {
	const stamp = report.when.toISOString().replace(/[:.]/g, '-')
	// Without the codecs parameter: Chrome checks the bare type against its share list,
	// and 'audio/webm;codecs=opus' failed there (Share did nothing on a Xiaomi).
	const type = report.audio.type.split(';')[0]
	return [
		new File([report.audio], `pluck-report-${stamp}.${extension(type)}`, { type }),
		new File([report.log], `pluck-report-${stamp}.txt`, { type: 'text/plain' }),
	]
}

function download(file: File) {
	const link = document.createElement('a')
	link.href = URL.createObjectURL(file)
	link.download = file.name
	link.click()
	setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

/** Sends `files` to an app (the system share sheet); downloads them where sharing them fails. */
async function share(files: File[], title: string) {
	if (navigator.canShare?.({ files })) {
		try {
			await navigator.share({ files, title })
			return
		} catch (error) {
			// Dismissed: nothing to do. Refused (canShare does not check what the browser then rejects): download.
			if (error instanceof DOMException && error.name === 'AbortError') return
		}
	}
	for (const file of files) download(file)
}

export function downloadReport(report: FieldReport) {
	for (const file of filesOf(report)) download(file)
}

export const shareReport = (report: FieldReport) => share(filesOf(report), `Pluck report · ${report.title}`)

/** Every kept report in one share. */
export const shareAll = () => share(reports.flatMap(filesOf), `Pluck reports · ${reports.length}`)

/** Every kept report in one .zip. */
export async function downloadAll() {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	download(new File([await zip(reports.flatMap(filesOf))], `pluck-reports-${stamp}.zip`, { type: 'application/zip' }))
}

export function deleteReport(report: FieldReport) {
	const i = reports.indexOf(report)
	if (i >= 0) reports.splice(i, 1)
	changed()
}
