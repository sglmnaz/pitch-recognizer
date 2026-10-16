// Chord recognition from a magnitude spectrum: pitch class profile (chroma) +
// template matching, after Fujishima ("Realtime Chord Recognition of Musical
// Sound", ICMC 1999). Pure functions so scripts/chord-check.ts can run them in
// Node on synthetic strums.

/** Pitch-class names as guitarists usually spell them. */
export const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

export interface ChordMatch {
	/** Display name, e.g. `C`, `Am`, `G7`. */
	name: string
	/** Pitch classes of the chord, root first. */
	notes: string[]
	/** Cosine similarity between chroma and template, in [0, 1]. */
	score: number
}

// Chord types as intervals above the root, each with a penalty subtracted from
// its match score: simpler chords win unless the extra note is clearly there.
// Overtones of a chord's own notes spell extensions — the fifth's 5th harmonic
// and the third's 3rd harmonic are its major 7th, the fifth's 3rd harmonic its
// 9th — and a weak third (common on real recordings) turns any triad into a
// sus chord. Each note beyond a triad costs 0.03; maj7 and sus pay extra.
// Tuned with `npm run bench` on GuitarSet + IDMT-SMT-Guitar (sus 0.05 and maj7
// +0.03 gave +4 points majmin and +5 sevenths) while keeping every synthetic
// voicing in scripts/chord-check.ts recognised.
const CHORD_TYPES: { suffix: string; intervals: number[]; penalty: number }[] = [
	{ suffix: '', intervals: [0, 4, 7], penalty: 0 },
	{ suffix: 'm', intervals: [0, 3, 7], penalty: 0 },
	{ suffix: '7', intervals: [0, 4, 7, 10], penalty: 0.03 },
	{ suffix: 'm7', intervals: [0, 3, 7, 10], penalty: 0.03 },
	{ suffix: 'maj7', intervals: [0, 4, 7, 11], penalty: 0.06 },
	{ suffix: '9', intervals: [0, 4, 7, 10, 2], penalty: 0.06 },
	{ suffix: 'sus2', intervals: [0, 2, 7], penalty: 0.05 },
	{ suffix: 'sus4', intervals: [0, 5, 7], penalty: 0.05 },
]

// Chroma is compressed (value^CHROMA_EXPONENT) before matching. Guitar voicings
// double the root and fifth on two or three strings but put the colour note
// (the 7th, the minor third of an A-shape barre) on a single string; with raw
// magnitudes that note never weighs enough to beat the plain triad. Log-like
// compression is standard in chroma features for the same reason (Müller,
// "Fundamentals of Music Processing", §5.2).
const CHROMA_EXPONENT = 0.5

// Bass-note tiebreak: chords sharing their notes (Dsus2 = Asus4, Am7 = C6)
// differ only in root, and the lowest note played is usually the root.
const BASS_BONUS = 0.03
const BASS_RANGE_DB = 30

// Spectrum band folded into chroma. 75 Hz keeps the low E (82 Hz); above
// ~1.5 kHz guitar partials are mostly upper harmonics, which add the wrong
// pitch classes (the 5th harmonic of A is a C#), and FFT bins are already
// finer than a semitone from ~200 Hz up.
const MIN_HZ = 75
const MAX_HZ = 1500

// Spectral peaks more than this far below the loudest one are noise floor.
const PEAK_RANGE_DB = 40

// Approximate note transcription, a cheap stand-in for Mauch & Dixon's NNLS
// chroma (ISMIR 2010): a peak at an integer multiple (2–8) of a lower peak
// that is not much weaker (within HARMONIC_LEVEL_DB) is taken as that note's
// overtone. Overtones that add a different pitch class (3rd, 5th, 6th, 7th
// harmonic: fifth, major third, fifth, minor seventh) count only
// OVERTONE_WEIGHT in the chroma; octave harmonics fold onto their root anyway.
const MAX_HARMONIC = 8
const HARMONIC_TOLERANCE_CENTS = 35
const HARMONIC_LEVEL_DB = 20
const OVERTONE_WEIGHT = 0.25

// A chord needs at least this many distinct pitch classes among the peaks that
// are not overtones. Without it a single bright note — whose 3rd and 5th
// harmonics spell its own major triad — is named as a chord.
const MIN_NOTES = 3

// Below this cosine similarity nothing is named. 0.8 left real strums unnamed
// half the time (muted strings, partial voicings); 0.6 gained 10 points majmin
// on the benchmark while single notes stay rejected by MIN_NOTES.
const MIN_SCORE = 0.6

interface Peak {
	hz: number
	magnitude: number
}

/**
 * Local maxima of a dB magnitude spectrum (as AnalyserNode.getFloatFrequencyData
 * returns it) inside the analysis band, with parabolic interpolation of the
 * peak frequency so low notes land on the right semitone despite coarse bins.
 */
function spectralPeaks(spectrumDb: Float32Array, binHz: number): Peak[] {
	const first = Math.max(1, Math.floor(MIN_HZ / binHz))
	const last = Math.min(spectrumDb.length - 2, Math.ceil(MAX_HZ / binHz))
	let loudest = -Infinity
	for (let i = first; i <= last; i++) loudest = Math.max(loudest, spectrumDb[i])

	const peaks: Peak[] = []
	for (let i = first; i <= last; i++) {
		const [a, b, c] = [spectrumDb[i - 1], spectrumDb[i], spectrumDb[i + 1]]
		if (b <= a || b < c || b < loudest - PEAK_RANGE_DB) continue
		const denominator = a - 2 * b + c
		const offset = denominator === 0 ? 0 : (0.5 * (a - c)) / denominator
		peaks.push({ hz: (i + offset) * binHz, magnitude: 10 ** (b / 20) })
	}
	return peaks
}

/** Harmonic number (2..MAX_HARMONIC) of `peak` over some lower peak, or 1 if none. */
function harmonicNumber(peak: Peak, peaks: Peak[]): number {
	for (const lower of peaks) {
		if (lower.hz >= peak.hz || 20 * Math.log10(peak.magnitude / lower.magnitude) > HARMONIC_LEVEL_DB) continue
		const h = Math.round(peak.hz / lower.hz)
		if (h >= 2 && h <= MAX_HARMONIC && Math.abs(1200 * Math.log2(peak.hz / (lower.hz * h))) < HARMONIC_TOLERANCE_CENTS) {
			return h
		}
	}
	return 1
}

function pitchClassOf(hz: number): { pitchClass: number; inTune: number } {
	const midi = 69 + 12 * Math.log2(hz / 440)
	const nearest = Math.round(midi)
	// Peaks between two semitones (noise, inharmonic partials) count less.
	return { pitchClass: ((nearest % 12) + 12) % 12, inTune: Math.cos(Math.PI * (midi - nearest)) ** 2 }
}

export interface ChordAnalysis {
	/** 12-bin chroma (C..B), scaled so the strongest bin is 1; all zeros if silent. */
	chroma: number[]
	/** Best-matching chord, or null when no chord is clearly being played. */
	chord: ChordMatch | null
}

export function recognizeChord(spectrumDb: Float32Array, binHz: number): ChordAnalysis {
	const chroma = new Array<number>(12).fill(0)
	const played = new Set<number>()
	const peaks = spectralPeaks(spectrumDb, binHz)
	const loudest = Math.max(0, ...peaks.map((peak) => peak.magnitude))
	let bass: number | null = null

	for (const peak of peaks) {
		const h = harmonicNumber(peak, peaks)
		const { pitchClass, inTune } = pitchClassOf(peak.hz)
		if (h === 1 && inTune > 0.5) {
			played.add(pitchClass)
			// Peaks come in rising frequency, so the first loud enough one is the bass.
			if (bass === null && 20 * Math.log10(peak.magnitude / loudest) > -BASS_RANGE_DB) bass = pitchClass
		}
		const octaveOfRoot = (h & (h - 1)) === 0 // 1, 2, 4, 8
		chroma[pitchClass] += peak.magnitude * inTune * (octaveOfRoot ? 1 : OVERTONE_WEIGHT)
	}

	const max = Math.max(...chroma)
	const normalized = max > 0 ? chroma.map((value) => value / max) : chroma
	return { chroma: normalized, chord: played.size >= MIN_NOTES ? matchChord(normalized, bass) : null }
}

/** Best-matching chord for a chroma vector, or null when nothing fits well. */
function matchChord(chroma: number[], bass: number | null): ChordMatch | null {
	const compressed = chroma.map((value) => value ** CHROMA_EXPONENT)
	const norm = Math.hypot(...compressed)
	if (norm === 0) return null

	let best: ChordMatch | null = null
	let bestRank = -Infinity
	for (let root = 0; root < 12; root++) {
		for (const { suffix, intervals, penalty } of CHORD_TYPES) {
			let dot = 0
			for (const interval of intervals) dot += compressed[(root + interval) % 12]
			// Cosine with a binary template: dot / (|chroma| * sqrt(#notes)).
			const score = dot / (norm * Math.sqrt(intervals.length))
			const rank = score + (root === bass ? BASS_BONUS : 0) - penalty
			if (rank > bestRank) {
				bestRank = rank
				best = {
					name: PITCH_CLASSES[root] + suffix,
					notes: intervals.map((interval) => PITCH_CLASSES[(root + interval) % 12]),
					score,
				}
			}
		}
	}
	return best && best.score >= MIN_SCORE ? best : null
}
