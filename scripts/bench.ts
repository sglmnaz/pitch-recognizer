// Benchmark: runs the app's own note and chord detection over labelled guitar
// audio, under simulated phone conditions, and reports mir_eval-style
// metrics, so different approaches can be compared on the same data.
//
//   npm run bench                     # default subset, all conditions
//   npm run bench -- --full           # every item
//   npm run bench -- --task notes     # or chords
//   npm run bench -- --limit 20 --conditions clean,phone-mid   # quick iteration
//   npm run bench -- --task notes --source guitarset --by-note   # acoustic notes, per note
//   npm run bench -- --json out.json  # save results to diff two versions
//
// Sources (any that are present): bench/audio (your own labelled files, see
// bench/README.md), bench/data/idmt (IDMT-SMT-Guitar), bench/data/guitarset.
// Datasets are local test data only: git-ignored, never bundled.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FFT_SIZE, processFrame, stop } from '../ts/microphone.ts'
import { recognizeChord } from '../ts/chords.ts'
import { appBand, appHighpass, CONDITIONS, decode, degrade, rms, spectrumDb } from './audio.ts'

const SAMPLE_RATE = 44100
const HOP = Math.round(SAMPLE_RATE / 60) // one rAF frame
// Same analyser settings as ts/microphone.ts (filters via appBand/appHighpass).
const CHORD_FFT_SIZE = 16384
// Chords are scored at 10 Hz to keep runs short; AnalyserNode's 0.8 smoothing
// per 60 Hz frame is 0.8^6 per 10 Hz step.
const CHORD_HOP = 6 * HOP
const CHORD_SMOOTHING = 0.8 ** 6
// Note frames are scored from this long after the onset (attack not scored).
const SETTLE_S = 0.3
// Default subset size per task and source; --full runs everything.
const DEFAULT_LIMIT = 60

// --- labels -----------------------------------------------------------------

const NOTE_NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const rootOf = (letter: string, accidental = '') =>
	(NOTE_NAMES[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12

/** `E2`, `F#3`, `Bb3` -> MIDI number. */
function parseNote(name: string): number | null {
	const match = /^([A-G])(#|b)?(-?\d)$/.exec(name)
	return match ? rootOf(match[1], match[2]) + 12 * (Number(match[3]) + 1) : null
}

type Chord = { root: number; quality: string } | null // null = no chord

/** App names (`Am`, `F#m7`, `Bbmaj7`, `Dsus2`) -> root + Harte quality. */
const APP_QUALITIES: Record<string, string> = { '': 'maj', m: 'min', '7': '7', m7: 'min7', maj7: 'maj7', '9': '9', sus2: 'sus2', sus4: 'sus4' }
function parseAppChord(name: string): Chord | undefined {
	const match = /^([A-G])(#|b)?(.*)$/.exec(name)
	if (!match || !(match[3] in APP_QUALITIES)) return undefined
	return { root: rootOf(match[1], match[2]), quality: APP_QUALITIES[match[3]] }
}

/** Harte labels (`D#:maj`, `A:min7/b3`, `N`) -> root + quality (bass and extensions dropped). */
function parseHarte(label: string): Chord {
	if (label === 'N' || label === 'X') return null
	const [root, rest = 'maj'] = label.split(':')
	const match = /^([A-G])(#|b)?$/.exec(root)!
	return { root: rootOf(match[1], match[2]), quality: rest.split('/')[0].split('(')[0] || 'maj' }
}

// MIREX-style reductions, as mir_eval.chord: references outside a level's
// vocabulary are left out of that level's score.
const MAJMIN: Record<string, string> = { maj: 'maj', '7': 'maj', maj7: 'maj', '9': 'maj', maj6: 'maj', min: 'min', min7: 'min', min6: 'min' }
const SEVENTHS: Record<string, string> = { maj: 'maj', maj6: 'maj', min: 'min', min6: 'min', '7': '7', '9': '7', maj7: 'maj7', min7: 'min7' }
function same(reference: Chord, estimate: Chord, level: Level): boolean | undefined {
	if (!reference) return undefined
	if (level === 'root') return estimate?.root === reference.root
	const map = level === 'majmin' ? MAJMIN : SEVENTHS
	if (!(reference.quality in map)) return undefined
	return !!estimate && estimate.root === reference.root && map[estimate.quality] === map[reference.quality]
}

// --- items ------------------------------------------------------------------

interface Segment<T> {
	start: number
	end: number
	value: T
}
interface Item<T> {
	id: string
	load: () => Float32Array
	segments: Segment<T>[]
}

/** Evenly spaced selection, so the default subset covers the whole source. */
function spread<T>(items: T[], limit: number): T[] {
	if (items.length <= limit) return items
	const step = items.length / limit
	return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)])
}

/** From the first frame at half the peak level until it decays to a tenth. */
function soundingSpan(signal: Float32Array): { start: number; end: number } {
	const levels: number[] = []
	for (let end = HOP; end <= signal.length; end += HOP) levels.push(rms(signal, end - HOP, end))
	const peak = Math.max(...levels)
	const onset = levels.findIndex((level) => level >= 0.5 * peak)
	let decay = levels.length
	for (let i = onset; i < levels.length; i++) {
		if (levels[i] < 0.1 * peak) {
			decay = i
			break
		}
	}
	return { start: (onset * HOP) / SAMPLE_RATE, end: (decay * HOP) / SAMPLE_RATE }
}

/** Own recordings in bench/audio: one sound per file, named note-E2-… / chord-Am-…. */
function ownItems<T>(kind: 'note' | 'chord', parse: (label: string) => T | null | undefined): Item<T>[] {
	const dir = 'bench/audio'
	if (!existsSync(dir)) return []
	const items: Item<T>[] = []
	for (const file of readdirSync(dir).sort()) {
		const label = new RegExp(`^${kind}-([^-.]+)`).exec(file)?.[1]
		const value = label === undefined ? undefined : parse(label)
		if (value === null || value === undefined) continue
		const signal = decode(join(dir, file), SAMPLE_RATE)
		const { start, end } = soundingSpan(signal)
		items.push({ id: `own/${file}`, load: () => signal, segments: [{ start, end, value }] })
	}
	return items
}

/**
 * GuitarSet solo excerpts (acoustic guitar through a microphone): notes that
 * last at least 0.45 s and overlap no other note, from the per-string MIDI
 * annotations.
 */
function guitarSetNotes(): Item<number>[] {
	const dir = 'bench/data/guitarset'
	if (!existsSync(join(dir, 'audio_mono-mic'))) return []
	const items: Item<number>[] = []
	for (const file of readdirSync(join(dir, 'annotation')).filter((f) => f.endsWith('_solo.jams')).sort()) {
		const jams = JSON.parse(readFileSync(join(dir, 'annotation', file), 'utf8'))
		const notes: Segment<number>[] = jams.annotations
			.filter((a: { namespace: string }) => a.namespace === 'note_midi')
			.flatMap((a: { data: { time: number; duration: number; value: number }[] }) =>
				a.data.map((d) => ({ start: d.time, end: d.time + d.duration, value: Math.round(d.value) })),
			)
		const segments = notes.filter((n) => n.end - n.start >= 0.45 && !notes.some((o) => o !== n && o.start < n.end && n.start < o.end))
		const base = file.replace('.jams', '')
		if (segments.length) items.push({ id: `guitarset/${base}`, load: () => decode(join(dir, 'audio_mono-mic', `${base}_mic.wav`), SAMPLE_RATE), segments })
	}
	return items
}

/** GuitarSet comping excerpts with their instructed chords. */
function guitarSetChords(): Item<Chord>[] {
	const dir = 'bench/data/guitarset'
	if (!existsSync(join(dir, 'audio_mono-mic'))) return []
	return readdirSync(join(dir, 'annotation'))
		.filter((file) => file.endsWith('_comp.jams'))
		.sort()
		.map((file) => {
			const jams = JSON.parse(readFileSync(join(dir, 'annotation', file), 'utf8'))
			const instructed = jams.annotations.find((a: { namespace: string }) => a.namespace === 'chord')
			const base = file.replace('.jams', '')
			return {
				id: `guitarset/${base}`,
				load: () => decode(join(dir, 'audio_mono-mic', `${base}_mic.wav`), SAMPLE_RATE),
				segments: instructed.data.map((d: { time: number; duration: number; value: string }) => ({
					start: d.time,
					end: d.time + d.duration,
					value: parseHarte(d.value),
				})),
			}
		})
}

const IDMT = 'bench/data/idmt/IDMT-SMT-GUITAR_V2'

/**
 * IDMT-SMT-Guitar dataset 2: runs of single notes with XML onset/offset/pitch.
 * Only plainly plucked notes (picked or finger-style, no muting, bends,
 * vibrato, slides, harmonics or dead notes) that do not overlap another note.
 */
function idmtNotes(): Item<number>[] {
	const dir = join(IDMT, 'dataset2')
	if (!existsSync(dir)) return []
	const items: Item<number>[] = []
	for (const file of readdirSync(join(dir, 'annotation')).sort()) {
		const xml = readFileSync(join(dir, 'annotation', file), 'utf8')
		const events = [...xml.matchAll(/<event>([\s\S]*?)<\/event>/g)].map(([, body]) => {
			const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? ''
			return { start: Number(field('onsetSec')), end: Number(field('offsetSec')), value: Number(field('pitch')), plain: ['PK', 'FS'].includes(field('excitationStyle')) && field('expressionStyle') === 'NO' }
		})
		const segments = events.filter((e) => e.plain && !events.some((o) => o !== e && o.start < e.end && e.start < o.end))
		if (segments.length === 0) continue
		const wav = join(dir, 'audio', file.replace(/\.xml$/, '.wav'))
		// A few annotations have no matching audio file in the archive.
		if (existsSync(wav)) items.push({ id: `idmt/${file}`, load: () => decode(wav, SAMPLE_RATE), segments: segments.map(({ start, end, value }) => ({ start, end, value })) })
	}
	return items
}

// IDMT chord qualities -> Harte. Extended dominants (9, 13) score as 7ths;
// power chords (5), sus and diminished qualities only count towards the root.
const IDMT_QUALITIES: Record<string, string> = { '': 'maj', min: 'min', '7': '7', '13': '7', '79': '7', '713': '7', '7913': '7', '79b': '7', min7: 'min7', min79: 'min7', maj7: 'maj7' }

/** IDMT-SMT-Guitar dataset 4, acoustic guitar through a microphone: chord changes per beat. */
function idmtChords(): Item<Chord>[] {
	const root = join(IDMT, 'dataset4', 'acoustic_mic')
	if (!existsSync(root)) return []
	const items: Item<Chord>[] = []
	for (const tempo of readdirSync(root).sort()) {
		for (const genre of readdirSync(join(root, tempo)).sort()) {
			const annotations = join(root, tempo, genre, 'annotation', 'chords')
			if (!existsSync(annotations)) continue
			for (const file of readdirSync(annotations).sort()) {
				// Rows are `time,bar.beat[:chord]`; a chord lasts until the next labelled beat.
				const rows = readFileSync(join(annotations, file), 'utf8')
					.split(/\r?\n/)
					.map((line) => line.split(','))
					.filter(([time, beat]) => /^\d+(\.\d+)?$/.test(time) && /^\d+\.\d+/.test(beat ?? ''))
				const changes = rows.filter(([, beat]) => beat.includes(':'))
				const lastBeat = Number(rows[rows.length - 1]?.[0] ?? 0)
				const segments = changes.map(([time, beat], i) => {
					const label = beat.split(':')[1].split('/')[0]
					const match = /^([A-G])(#|b)?(.*)$/.exec(label)
					const value: Chord = match ? { root: rootOf(match[1], match[2]), quality: IDMT_QUALITIES[match[3]] ?? match[3] } : null
					const end = i + 1 < changes.length ? Number(changes[i + 1][0]) : lastBeat + 0.5
					return { start: Number(time), end, value }
				})
				const wav = join(root, tempo, genre, 'audio', file.replace(/\.csv$/, '.wav'))
				if (existsSync(wav)) items.push({ id: `idmt/${tempo}/${genre}/${file}`, load: () => decode(wav, SAMPLE_RATE), segments })
			}
		}
	}
	return items
}

// --- evaluation -------------------------------------------------------------

interface NoteScore {
	/** Per MIDI note: scored frames, right pitch, right pitch class. */
	byNote: Map<number, { frames: number; pitchHits: number; chromaHits: number }>
	frames: number
	pitchHits: number
	chromaHits: number
	voiced: number
	offsets: number[]
	firstCorrect: number[]
}

function evaluateNotes(item: Item<number>, signal: Float32Array, score: NoteScore) {
	const filtered = appBand(signal, SAMPLE_RATE)
	stop()
	const firstSeen = new Map<Segment<number>, number>()
	for (let end = FFT_SIZE; end <= filtered.length; end += HOP) {
		const t = end / SAMPLE_RATE
		const reading = processFrame(filtered.subarray(end - FFT_SIZE, end), SAMPLE_RATE, t * 1000)
		// A reading describes the newest audio: score it against the note sounding then.
		const segment = item.segments.find((s) => t >= s.start && t < s.end)
		if (!segment) continue
		const cents = reading ? 1200 * Math.log2(reading.frequency / (440 * 2 ** ((segment.value - 69) / 12))) : NaN
		if (Math.abs(cents) < 50 && !firstSeen.has(segment)) firstSeen.set(segment, t - segment.start)
		if (t < segment.start + SETTLE_S) continue
		const note = score.byNote.get(segment.value) ?? { frames: 0, pitchHits: 0, chromaHits: 0 }
		score.byNote.set(segment.value, note)
		score.frames++
		note.frames++
		if (!reading) continue
		score.voiced++
		if (Math.abs(cents - 1200 * Math.round(cents / 1200)) < 50) {
			score.chromaHits++
			note.chromaHits++
		}
		if (Math.abs(cents) < 50) {
			score.pitchHits++
			note.pitchHits++
			score.offsets.push(cents)
		}
	}
	score.firstCorrect.push(...[...firstSeen.values()].map((s) => s * 1000))
}

type Level = 'root' | 'majmin' | 'sevenths'
type ChordScore = Record<Level, { hits: number; frames: number }> & { confusions: Map<string, number>; latencies: number[] }

function evaluateChords(item: Item<Chord>, signal: Float32Array, score: ChordScore) {
	const filtered = appHighpass(signal, SAMPLE_RATE)
	const state = { smoothing: CHORD_SMOOTHING }
	const recognised = new Set<Segment<Chord>>()
	for (let end = CHORD_FFT_SIZE; end <= filtered.length; end += CHORD_HOP) {
		const spectrum = spectrumDb(filtered.subarray(end - CHORD_FFT_SIZE, end), state)
		// The analyser window spans ~370 ms: score it against the chord at its centre.
		const t = (end - CHORD_FFT_SIZE / 2) / SAMPLE_RATE
		const segment = item.segments.find((s) => t >= s.start && t < s.end)
		if (!segment) continue
		const match = recognizeChord(spectrum, SAMPLE_RATE / CHORD_FFT_SIZE).chord
		const estimate = match ? (parseAppChord(match.name) ?? null) : null
		// Latency: from the chord change until the analyser first names it (majmin
		// level), timed at the window's end — when the app could show it.
		if (!recognised.has(segment) && same(segment.value, estimate, 'majmin')) {
			recognised.add(segment)
			score.latencies.push((end / SAMPLE_RATE - segment.start) * 1000)
		}
		for (const level of ['root', 'majmin', 'sevenths'] as Level[]) {
			const ok = same(segment.value, estimate, level)
			if (ok === undefined) continue
			score[level].frames++
			if (ok) score[level].hits++
			else if (level === 'sevenths') score.confusions.set(match?.name ?? '—', (score.confusions.get(match?.name ?? '—') ?? 0) + 1)
		}
	}
}

// --- main -------------------------------------------------------------------

const args = process.argv.slice(2)
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const limit = args.includes('--full') ? Infinity : Number(option('--limit') ?? DEFAULT_LIMIT)
const conditions = option('--conditions')?.split(',')
const activeConditions = CONDITIONS.filter((c) => !conditions || conditions.includes(c.name))
const task = option('--task')
const jsonPath = option('--json')

const pct = (hits: number, total: number) => (total ? `${((100 * hits) / total).toFixed(1)}%` : '-').padStart(6)
const quantile = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] : NaN)
const results: Record<string, unknown> = { date: new Date().toISOString(), limit }

if (task !== 'chords') {
	const sources = option('--source')
	const items = [
		...ownItems('note', parseNote),
		...(sources && !sources.includes('idmt') ? [] : spread(idmtNotes(), limit)),
		...(sources && !sources.includes('guitarset') ? [] : spread(guitarSetNotes(), limit)),
	]
	console.log(`\nNOTES — ${items.length} items (RPA right note; RCA octave ignored; RCA−RPA = octave errors)`)
	console.log('condition        RPA     RCA  voiced  IQR¢  first-ok')
	for (const condition of activeConditions) {
		const score: NoteScore = { byNote: new Map(), frames: 0, pitchHits: 0, chromaHits: 0, voiced: 0, offsets: [], firstCorrect: [] }
		items.forEach((item, i) => evaluateNotes(item, degrade(item.load(), SAMPLE_RATE, condition, i + 1), score))
		const iqr = quantile(score.offsets, 0.75) - quantile(score.offsets, 0.25)
		const firstOk = quantile(score.firstCorrect, 0.5)
		console.log(
			`${condition.name.padEnd(13)} ${pct(score.pitchHits, score.frames)}  ${pct(score.chromaHits, score.frames)}  ${pct(score.voiced, score.frames)}  ${iqr.toFixed(1).padStart(4)}  ${firstOk.toFixed(0).padStart(5)}ms`,
		)
		if (args.includes('--by-note')) {
			const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
			const rows = [...score.byNote.entries()].sort((a, b) => a[0] - b[0]).filter(([, n]) => n.frames >= 20)
			console.log(
				'   ' + rows.map(([midi, n]) => `${names[midi % 12]}${Math.floor(midi / 12) - 1} ${pct(n.pitchHits, n.frames).trim()}${n.chromaHits > n.pitchHits ? ` (oct ${pct(n.chromaHits - n.pitchHits, n.frames).trim()})` : ''}`).join(' · '),
			)
		}
		const { offsets, firstCorrect, byNote, ...counts } = score
		results[`notes/${condition.name}`] = { ...counts, iqr, firstOk }
	}
}

if (task !== 'notes') {
	const items = [...ownItems('chord', parseAppChord), ...spread(idmtChords(), limit), ...spread(guitarSetChords(), limit)]
	console.log(`\nCHORDS — ${items.length} items (frame-level chord symbol recall, MIREX reductions)`)
	console.log('condition       root  majmin sevenths  latency  top confusions (sevenths)')
	for (const condition of activeConditions) {
		const score: ChordScore = { root: { hits: 0, frames: 0 }, majmin: { hits: 0, frames: 0 }, sevenths: { hits: 0, frames: 0 }, confusions: new Map(), latencies: [] }
		items.forEach((item, i) => evaluateChords(item, degrade(item.load(), SAMPLE_RATE, condition, i + 1), score))
		const top = [...score.confusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(' ')
		const latency = quantile(score.latencies, 0.5)
		console.log(`${condition.name.padEnd(13)} ${pct(score.root.hits, score.root.frames)} ${pct(score.majmin.hits, score.majmin.frames)}  ${pct(score.sevenths.hits, score.sevenths.frames)}  ${latency.toFixed(0).padStart(5)}ms  ${top}`)
		const { confusions, latencies, ...levels } = score
		results[`chords/${condition.name}`] = { ...levels, latency }
	}
}

if (jsonPath) writeFileSync(jsonPath, JSON.stringify(results, null, '\t'))
