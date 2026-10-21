// The timing log of a Changes In time or Tab session: field data instead of
// guesses. When the clicks are heard, when the mic hears strums and picks,
// which strums were changes and to what chord (and why the others were not),
// what each judged change or note was off by. Summed up in a few lines and drawn as a timeline on the
// calibration page (Diagnostics → Last session), saved whole in a field report.
import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'

/** Session times are the mic's (Mic delay already taken off); beats are BeatEvent.heardAt. */
export type ProbeEntry =
	| { kind: 'beat'; heardAt: number; stampedAt: number | null }
	| { kind: 'strum'; at: number }
	/** Mic check: a strum counted (the sound after it had pitch). */
	| { kind: 'counted'; at: number }
	/** Changes: a strum placed as a change to `symbol` (dated by the strum). */
	| { kind: 'named'; at: number; symbol: string }
	/**
	 * Changes: a strum that was no change. `none`: no drill chord in its sound;
	 * `same`: the chord ringing; `louder` / `clearer`: a strum after it took the
	 * change (the fingers leaving the old chord), see changes.session.ts.
	 */
	| { kind: 'passed'; at: number; symbol: string | null; why: 'none' | 'same' | 'louder' | 'clearer' }
	| { kind: 'judged'; dt: number | null; mark: string }
	| { kind: 'pick'; at: number }
	| { kind: 'due'; at: number }
	/** Changes: a chord's first beat, whose change is judged (`target` the chord due). */
	| { kind: 'slot'; downbeat: number; target: string }

/** The last session that ended, kept for the calibration page. */
export interface ProbeSession {
	exercise: 'changes' | 'tab'
	endedAt: number
	entries: ProbeEntry[]
	summary: string
}

let last: ProbeSession | null = null
const sessionListeners: (() => void)[] = []
export const lastSession = () => last
/** `listener` runs when a session ends (its log becomes lastSession()). */
export function onSession(listener: () => void) {
	sessionListeners.push(listener)
}

const median = (values: number[]) => {
	if (!values.length) return null
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[sorted.length >> 1]
}
const ms = (value: number | null | undefined) => (value === null || value === undefined ? '–' : `${Math.round(value)}`)
const quartiles = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b)
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
	return sorted.length ? `${ms(at(0.25))} / ${ms(at(0.5))} / ${ms(at(0.75))}` : '–'
}

export function createProbe() {
	let entries: ProbeEntry[] = []
	const of = <K extends ProbeEntry['kind']>(kind: K) => entries.filter((e): e is Extract<ProbeEntry, { kind: K }> => e.kind === kind)

	function summary(): string {
		const s = Settings.get()
		const latency = Metronome.latencies()
		const track = Microphone.getStream()?.getAudioTracks()[0]?.getSettings() as { latency?: number; sampleRate?: number } | undefined
		const lines = [
			`Pluck timing · ${new Date().toISOString()}`,
			`audio delay ${s.audioDelayMs} · mic delay ${s.micDelayMs} · output latency ${ms(latency.outputMs)} · base ${ms(latency.baseMs)} · mic track latency ${track?.latency === undefined ? '–' : ms(track.latency * 1000)} · ${track?.sampleRate ?? '–'} Hz`,
		]
		const beats = of('beat')
		const stamped = beats.filter((b) => b.stampedAt !== null).map((b) => b.heardAt - b.stampedAt!)
		lines.push(`beats ${beats.length} · heardAt − outputTimestamp median ${ms(median(stamped))}`)
		const strums = of('strum').map((e) => e.at)
		const named = of('named')
		const passed = of('passed')
		if (named.length || passed.length) {
			const why = (reason: string) => passed.filter((p) => p.why === reason).length
			lines.push(
				`strums heard ${strums.length} · changes ${named.length} · not changes: no drill chord ${why('none')} · the chord ringing ${why('same')} · a louder strum after ${why('louder')} · a clearer one after ${why('clearer')}`
			)
			// The strums that gave way to a later one: where a change can land on the wrong strum.
			const gave = passed.filter((p) => p.why === 'louder' || p.why === 'clearer')
			if (gave.length) lines.push('gave way: the strum, why, and the change after it (ms later)')
			for (const p of gave.slice(0, 16)) {
				const next = named.find((n) => n.at > p.at)
				lines.push(`  ${(p.symbol ?? '–').padEnd(3)} ${p.why.padEnd(7)} ${next ? `${next.symbol.padEnd(3)} +${ms(next.at - p.at)}` : '–'}`)
			}
		}
		const judged = of('judged')
		if (judged.length) {
			const count = (mark: string) => judged.filter((j) => j.mark === mark).length
			const dts = judged.filter((j) => j.dt !== null).map((j) => j.dt!)
			lines.push(
				`judged ${judged.length}: hit ${count('hit')} · early ${count('early')} · late ${count('late')} · miss ${count('miss')} · dt (25/50/75%) ${quartiles(dts)}`
			)
		}
		const picks = of('pick').map((e) => e.at)
		const due = of('due').map((e) => e.at)
		if (due.length && picks.length) {
			// The nearest pick to each note due, within a second.
			const offsets = due.flatMap((at) => {
				const near = picks.reduce((best, p) => (Math.abs(p - at) < Math.abs(best - at) ? p : best), picks[0])
				return Math.abs(near - at) < 1000 ? [near - at] : []
			})
			lines.push(`tab: picks ${picks.length} · notes due ${due.length} · nearest pick − note (25/50/75%) ${quartiles(offsets)}`)
		}
		return lines.join('\n')
	}

	return {
		log(entry: ProbeEntry) {
			entries.push(entry)
		},
		clear() {
			entries = []
		},
		summary,
		/** The session ended: its log becomes lastSession(). */
		finish(exercise: ProbeSession['exercise']): ProbeSession {
			last = { exercise, endedAt: Date.now(), entries: [...entries], summary: summary() }
			for (const listener of sessionListeners) listener()
			return last
		},
	}
}

/** One judged change on the timeline, times in ms from its downbeat. */
export interface TimelineRow {
	index: number
	target: string
	strums: number[]
	/** The strum that dated it (null: missed). */
	chosen: number | null
	dt: number | null
	mark: string
}

// A change's strip: from TIMELINE_BEFORE before its downbeat to TIMELINE_AFTER after.
export const TIMELINE_BEFORE = 1000
export const TIMELINE_AFTER = 1500

/** Changes: each judged change with what was heard around its downbeat. */
export function changesTimeline(entries: ProbeEntry[]): TimelineRow[] {
	const slots = entries.filter((e): e is Extract<ProbeEntry, { kind: 'slot' }> => e.kind === 'slot')
	const judged = entries.filter((e): e is Extract<ProbeEntry, { kind: 'judged' }> => e.kind === 'judged')
	const strums = entries.filter((e): e is Extract<ProbeEntry, { kind: 'strum' }> => e.kind === 'strum').map((e) => e.at)
	const named = entries.filter((e): e is Extract<ProbeEntry, { kind: 'named' }> => e.kind === 'named')
	const near = (t: number, d: number) => t >= d - TIMELINE_BEFORE && t <= d + TIMELINE_AFTER
	// Slots are judged in order, one mark each.
	return judged.map((j, i) => {
		const slot = slots[i]
		if (!slot) return { index: i + 1, target: '?', strums: [], chosen: null, dt: j.dt, mark: j.mark }
		const d = slot.downbeat
		const naming = named.find((n) => n.symbol === slot.target && near(n.at, d))
		return {
			index: i + 1,
			target: slot.target,
			strums: strums.filter((t) => near(t, d)).map((t) => t - d),
			chosen: naming ? naming.at - d : null,
			dt: j.dt,
			mark: j.mark,
		}
	})
}
