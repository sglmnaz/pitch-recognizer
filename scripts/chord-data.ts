// Training data for the learned chord recognizer (scripts/chord-train.py):
// runs the tune split through the same analyser stand-in as the benchmark
// (scripts/bench.ts evaluateChords: high-pass, 16384-point Blackman spectrum,
// 10 Hz hop with the analyser's smoothing) and the app's own logSpectrum, and
// dumps features with frame labels. Test-split items are never read.
//
//   node scripts/chord-data.ts --out <dir> [--conditions clean,phone-mid]
//
// Per condition, <dir>/<condition>.* holds: feat (uint8, LOG_BINS per frame,
// value × 255), notes (uint8 per analysed note, 1 sounding, 0 not, 255 no
// annotation), instr / perf (chord class: root * 8 + type, 96 no chord, 255
// unknown, from GuitarSet's instructed / performed annotation; IDMT has one),
// ref (bench reference: root, quality id), seg (int32 segment id for latency),
// and meta.json with the quality table.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logSpectrum, LOG_BINS } from '../ts/music/chords.ts'
import { appHighpass, CONDITIONS, decode, degrade, spectrumDb } from './audio.ts'
import { CHORD_FFT_SIZE, CHORD_HOP, CHORD_SMOOTHING, idmtChords, parseHarte, SAMPLE_RATE, splitOf, type Chord } from './bench.ts'

const LOW_NOTE = 36
const NOTES = 60
const N_CLASS = 96
const UNKNOWN = 255
// Notes count as sounding in a frame if they overlap the middle ±100 ms of the
// 370 ms Blackman window, where nearly all its weight is.
const NOTE_SPAN_S = 0.1

// Harte qualities -> app chord types (maj, m, 7, m7, maj7, 9, sus2, sus4).
// Sixths fold onto their triad, extended dominants onto 7, half-diminished
// onto m7 (same root and third); power chords, diminished and augmented have
// no app type and are left out of the chord loss.
const TYPE_OF: Record<string, number> = {
	maj: 0,
	maj6: 0,
	min: 1,
	min6: 1,
	'7': 2,
	'11': 2,
	'13': 2,
	'75b': 2,
	'713b': 2,
	'913': 2,
	'1113': 2,
	min7: 3,
	hdim7: 3,
	min9: 3,
	min11: 3,
	min13: 3,
	min75b: 3,
	maj7: 4,
	maj9: 4,
	maj13: 4,
	maj79: 4,
	'9': 5,
	sus2: 6,
	sus9: 6,
	sus4: 7,
}
const classOf = (chord: Chord) => (chord === null ? N_CLASS : chord.quality in TYPE_OF ? chord.root * 8 + TYPE_OF[chord.quality] : UNKNOWN)

interface Labelled {
	id: string
	load: () => Float32Array
	instr: { start: number; end: number; value: Chord }[]
	perf: { start: number; end: number; value: Chord }[]
	notes: { start: number; end: number; midi: number }[] | null
	solo: boolean
}

const GUITARSET = 'bench/data/guitarset'

function guitarSet(): Labelled[] {
	return (
		readdirSync(join(GUITARSET, 'annotation'))
			// The split is decided from the file name, so test-split annotations are never opened.
			.filter((file) => file.endsWith('.jams') && splitOf(`guitarset/${file.replace('.jams', '')}`) === 'tune')
			.sort()
			.map((file) => {
				const jams = JSON.parse(readFileSync(join(GUITARSET, 'annotation', file), 'utf8'))
				const base = file.replace('.jams', '')
				const [instructed, performed] = jams.annotations.filter((a: { namespace: string }) => a.namespace === 'chord')
				const segments = (a: { data: { time: number; duration: number; value: string }[] }) =>
					a.data.map((d) => ({ start: d.time, end: d.time + d.duration, value: parseHarte(d.value) }))
				const notes = jams.annotations
					.filter((a: { namespace: string }) => a.namespace === 'note_midi')
					.flatMap((a: { data: { time: number; duration: number; value: number }[] }) =>
						a.data.map((d) => ({ start: d.time, end: d.time + d.duration, midi: Math.round(d.value) }))
					)
				return {
					id: `guitarset/${base}`,
					load: () => decode(join(GUITARSET, 'audio_mono-mic', `${base}_mic.wav`), SAMPLE_RATE),
					instr: segments(instructed),
					perf: segments(performed),
					notes,
					solo: base.endsWith('_solo'),
				}
			})
	)
}

function idmt(): Labelled[] {
	return idmtChords((id) => splitOf(id) === 'tune').map((item) => ({
		id: item.id,
		load: item.load,
		instr: item.segments,
		perf: item.segments,
		notes: null,
		solo: false,
	}))
}

// --- synthetic strums ----------------------------------------------------------

// The recordings are mostly major and minor triads and dominant 7ths (GuitarSet
// instructs only maj, min, 7 and hdim7; sus, maj7 and 9 chords are rare), so a
// model trained on them alone learns to drop every colour note. Synthetic
// takes add every chord type equally often, as random guitar voicings with
// random timbre, plus single-note lines and silence labelled "no chord"
// (synthetic strumming data helped real-audio chord recognition in
// "Joint Transcription of Acoustic Guitar Strumming Directions and
// Chords", arXiv 2508.07973). Seeded, so every build is identical.
const OPEN_STRINGS = [40, 45, 50, 55, 59, 64]
const SYNTH_TYPES: { quality: string; intervals: number[] }[] = [
	{ quality: 'maj', intervals: [0, 4, 7] },
	{ quality: 'min', intervals: [0, 3, 7] },
	{ quality: '7', intervals: [0, 4, 7, 10] },
	{ quality: 'min7', intervals: [0, 3, 7, 10] },
	{ quality: 'maj7', intervals: [0, 4, 7, 11] },
	{ quality: '9', intervals: [0, 4, 7, 10, 2] },
	{ quality: 'sus2', intervals: [0, 2, 7] },
	{ quality: 'sus4', intervals: [0, 5, 7] },
	{ quality: '5', intervals: [0, 7] },
]

function synthItem(index: number): Labelled {
	let state = 7919 * (index + 1)
	const random = () => (state = (state * 16807) % 2147483647) / 2147483647
	const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]
	const length = 30 * SAMPLE_RATE
	const signal = new Float32Array(length)
	const segments: Labelled['instr'] = []
	const notes: { start: number; end: number; midi: number }[] = []

	/** One plucked string: random pluck position, brightness, decay and inharmonicity. */
	function pluck(midi: number, at: number, until: number, level: number) {
		const f0 = 440 * 2 ** ((midi - 69 + (random() - 0.5) * 0.06) / 12)
		const beta = 0.08 + 0.27 * random()
		// Down to bright, slowly damped strings whose overtones spell a maj7 or a 9.
		const tilt = 0.3 + 1.2 * random()
		const decay = 0.5 + 2.5 * random()
		const damping = 0.02 + 0.78 * random()
		const inharmonicity = 4e-4 * random()
		const from = Math.round(at * SAMPLE_RATE)
		const to = Math.min(length, Math.round(until * SAMPLE_RATE))
		for (let h = 1; h <= 12; h++) {
			const fh = h * f0 * Math.sqrt(1 + inharmonicity * h * h)
			if (fh > 8000) break
			const amplitude = (level * Math.abs(Math.sin(h * Math.PI * beta))) / h ** tilt
			const rate = decay * (1 + h * damping)
			const phase = random() * 2 * Math.PI
			const w = (2 * Math.PI * fh) / SAMPLE_RATE
			for (let i = from; i < to; i++) {
				const t = (i - from) / SAMPLE_RATE
				// Release: a 30 ms fade when the next event damps the string.
				const release = i > to - 1323 ? (to - i) / 1323 : 1
				signal[i] += amplitude * release * Math.exp(-rate * t) * Math.sin(w * (i - from) + phase)
			}
		}
	}

	/** A random voicing in a 4-fret window, root in the bass most of the time. */
	function voicing(root: number, intervals: number[]): number[] | null {
		const tones = new Set(intervals.map((i) => (root + i) % 12))
		for (let attempt = 0; attempt < 100; attempt++) {
			const position = Math.floor(random() * 10)
			const choices = OPEN_STRINGS.map((open) => {
				const frets = [0, ...[0, 1, 2, 3].map((f) => position + f)].filter((f, i, all) => f >= 0 && all.indexOf(f) === i)
				return frets.map((f) => open + f).filter((m) => tones.has(m % 12))
			})
			const bassString = choices.findIndex((c) => c.some((m) => m % 12 === root))
			if (bassString < 0 || bassString > 2) continue
			const midis = [pick(choices[bassString].filter((m) => m % 12 === root))]
			for (let s = bassString + 1; s < 6; s++) if (choices[s].length && random() > 0.12) midis.push(pick(choices[s]))
			// Inversions now and then: the bass is not always the root.
			if (random() < 0.15 && midis.length > 3) midis.shift()
			const present = new Set(midis.map((m) => m % 12))
			const needed = [...tones].filter((pc) => intervals.length < 4 || pc !== (root + 7) % 12)
			if (midis.length >= 3 && needed.every((pc) => present.has(pc))) return midis
			if (intervals.length === 2 && midis.length >= 2) return midis
		}
		return null
	}

	let t = 0.3
	while (t < 29) {
		const kind = random()
		const span = Math.min(29.5 - t, 0.8 + 2.4 * random())
		const level = 0.03 + 0.12 * random()
		if (kind < 0.7) {
			const root = Math.floor(random() * 12)
			const type = random() < 0.06 ? SYNTH_TYPES[8] : SYNTH_TYPES[Math.floor(random() * 8)]
			const midis = voicing(root, type.intervals)
			if (!midis) continue
			// Strummed (repeatedly or once) or picked one string at a time.
			const arpeggio = random() < 0.3
			const period = arpeggio ? 0.12 + 0.2 * random() : random() < 0.5 ? span : 0.3 + 0.7 * random()
			const spread = 0.06 * random()
			const order = random() < 0.5 ? midis : [...midis].reverse()
			for (let at = t, n = 0; at < t + span - 0.05; at += period, n++) {
				if (arpeggio) {
					pluck(order[n % order.length], at, t + span, level * (0.5 + 0.5 * random()))
				} else {
					order.forEach((m, s) => pluck(m, at + (s * spread) / order.length, Math.min(at + period, t + span), level * (0.5 + 0.5 * random())))
				}
			}
			segments.push({ start: t, end: t + span, value: { root, quality: type.quality } })
			for (const midi of midis) notes.push({ start: t, end: t + span, midi })
		} else if (kind < 0.84) {
			// A single-note line: not a chord.
			const register = 40 + Math.floor(random() * 30)
			for (let at = t; at < t + span - 0.1; ) {
				const d = Math.min(t + span - at, 0.15 + 0.45 * random())
				const midi = register + Math.floor(random() * 10)
				pluck(midi, at, at + d, level)
				notes.push({ start: at, end: at + d, midi })
				at += d
			}
			segments.push({ start: t, end: t + span, value: null })
		} else if (kind < 0.95) {
			// One ringing note, mostly low: its 3rd and 5th harmonics spell its own major triad.
			const midi = 40 + Math.floor(random() * random() * 30)
			pluck(midi, t, t + span, level)
			notes.push({ start: t, end: t + span, midi })
			segments.push({ start: t, end: t + span, value: null })
		} else {
			segments.push({ start: t, end: t + span, value: null })
		}
		t += span
	}
	// A little hiss so silence is not digital silence.
	for (let i = 0; i < length; i++) signal[i] += 1e-4 * (random() - 0.5)
	return { id: `synth/${index}`, load: () => signal, instr: segments, perf: segments, notes, solo: false }
}

const args = process.argv.slice(2)
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const out = option('--out')
if (!out) throw new Error('--out <dir> is required')
const only = option('--conditions')?.split(',')
const synth = Number(option('--synth') ?? 0)
mkdirSync(out, { recursive: true })

// --synth N builds N synthetic takes instead of the recordings (files prefixed synth-).
const items = synth ? Array.from({ length: synth }, (_, i) => synthItem(i)) : [...guitarSet(), ...idmt()].filter((item) => splitOf(item.id) === 'tune')
const qualities: string[] = []
const qualityId = (q: string) => (qualities.includes(q) ? qualities.indexOf(q) : qualities.push(q) - 1)

CONDITIONS.forEach((condition, c) => {
	if (only && !only.includes(condition.name)) return
	const feat: number[] = []
	const notes: number[] = []
	const instr: number[] = []
	const perf: number[] = []
	const ref: number[] = []
	const seg: number[] = []
	const itemOf: number[] = []
	const log = new Float32Array(LOG_BINS)
	let segments = 0
	items.forEach((item, i) => {
		const signal = appHighpass(degrade(item.load(), SAMPLE_RATE, condition, 1000 + 100 * c + i), SAMPLE_RATE)
		const state = { smoothing: CHORD_SMOOTHING }
		const segBase = segments
		segments += item.instr.length
		for (let end = CHORD_FFT_SIZE; end <= signal.length; end += CHORD_HOP) {
			const spectrum = spectrumDb(signal.subarray(end - CHORD_FFT_SIZE, end), state)
			const t = (end - CHORD_FFT_SIZE / 2) / SAMPLE_RATE
			const s = item.instr.findIndex((x) => t >= x.start && t < x.end)
			// Same frames the benchmark scores, plus solo excerpts (single-note lines: "no chord").
			if (s < 0 && !item.solo) continue
			logSpectrum(spectrum, SAMPLE_RATE / CHORD_FFT_SIZE, 440, log)
			for (let j = 0; j < LOG_BINS; j++) feat.push(Math.round(log[j] * 255))
			const sounding = item.notes?.filter((n) => n.start < t + NOTE_SPAN_S && n.end > t - NOTE_SPAN_S) ?? null
			for (let k = 0; k < NOTES; k++) notes.push(sounding ? (sounding.some((n) => n.midi === LOW_NOTE + k) ? 1 : 0) : UNKNOWN)
			if (item.solo) {
				const classes = new Set(sounding!.map((n) => n.midi % 12))
				const label = classes.size < 3 ? N_CLASS : UNKNOWN
				instr.push(label)
				perf.push(label)
				ref.push(-1, UNKNOWN)
				seg.push(-1)
			} else {
				const reference = item.instr[s].value
				instr.push(classOf(reference))
				const p = item.perf.find((x) => t >= x.start && t < x.end)
				perf.push(p ? classOf(p.value) : UNKNOWN)
				ref.push(reference ? reference.root : -1, reference ? qualityId(reference.quality) : UNKNOWN)
				seg.push(segBase + s)
			}
			itemOf.push(i)
		}
		if (i % 20 === 0) console.log(`${condition.name}: ${i + 1}/${items.length} items, ${instr.length} frames`)
	})
	const base = join(out, (synth ? 'synth-' : '') + condition.name)
	writeFileSync(`${base}.feat`, Uint8Array.from(feat))
	writeFileSync(`${base}.notes`, Uint8Array.from(notes))
	writeFileSync(`${base}.instr`, Uint8Array.from(instr))
	writeFileSync(`${base}.perf`, Uint8Array.from(perf))
	writeFileSync(`${base}.ref`, Int16Array.from(ref))
	writeFileSync(`${base}.seg`, Int32Array.from(seg))
	writeFileSync(`${base}.item`, Int16Array.from(itemOf))
	writeFileSync(
		`${base}.meta.json`,
		JSON.stringify({ frames: instr.length, bins: LOG_BINS, notes: NOTES, lowNote: LOW_NOTE, qualities, items: items.map((x) => x.id) })
	)
	console.log(`${condition.name}: ${instr.length} frames written`)
})
