// Settings → Metronome → Timing log (or ?debug): a timing log of a Changes In time or Tab session, summed up in a few
// lines to paste into a report. Field data instead of guesses: when the clicks
// are heard, when the mic hears strums and picks, how long the recognizer takes
// to name a chord, and what each judged change or note was off by.
import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'

const DEBUG = new URLSearchParams(location.search).has('debug')
/** Whether a session ends with its timing log shown (the log itself is always kept: a few entries a beat). */
export const probing = () => DEBUG || Settings.get().timingLog

/** Session times are the mic's (Mic delay already taken off); beats are BeatEvent.heardAt. */
export type ProbeEntry =
	| { kind: 'beat'; heardAt: number; stampedAt: number | null }
	| { kind: 'strum'; at: number }
	| { kind: 'named'; at: number; symbol: string; struck: number | null }
	| { kind: 'judged'; dt: number | null; mark: string }
	| { kind: 'pick'; at: number }
	| { kind: 'due'; at: number }

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
		if (named.length) {
			const dated = named.filter((n) => n.struck !== null)
			lines.push(`strums heard ${strums.length} · chords named ${named.length} · dated by a strum ${dated.length}`)
			lines.push(`named − dating strum (25/50/75%) ${quartiles(dated.map((n) => n.at - n.struck!))}`)
			lines.push('each named chord: ms back to the last 3 strums before it')
			for (const n of named.slice(0, 16)) {
				const back = strums
					.filter((t) => t <= n.at)
					.slice(-3)
					.reverse()
					.map((t) => ms(n.at - t))
				lines.push(`  ${n.symbol.padEnd(3)} ${n.struck === null ? 'fallback' : 'strum   '} ${back.join(' / ')}`)
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
	}
}

/** Shows `text` after `anchor` in a <pre> with a Copy button (one per anchor). */
export function showProbe(anchor: HTMLElement, text: string) {
	let box = anchor.nextElementSibling as HTMLElement | null
	if (!box?.classList.contains('probe')) {
		box = document.createElement('div')
		box.className = 'probe debug'
		const pre = document.createElement('pre')
		const copy = document.createElement('button')
		copy.type = 'button'
		copy.className = 'btn'
		copy.textContent = 'Copy timing log'
		copy.addEventListener('click', () => {
			navigator.clipboard?.writeText(pre.textContent ?? '').then(
				() => (copy.textContent = 'Copied'),
				() => (copy.textContent = 'Copy failed: select the text')
			)
		})
		box.append(pre, copy)
		anchor.after(box)
	}
	box.querySelector('pre')!.textContent = text
	box.querySelector('button')!.textContent = 'Copy timing log'
}
