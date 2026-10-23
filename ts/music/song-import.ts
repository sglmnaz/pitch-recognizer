// Trainer → Songs: a file the user imports (Guitar Pro 3–7, MusicXML) read by
// alphaTab (MPL-2.0, docs/adr/0012) into a Song. alphaTab is large, so it is
// loaded only here, on the first import, and only its importer is used: Pluck
// draws the strip and plays the notes itself. The Song is stored once read
// (songs.store.ts), so playing an imported song never needs alphaTab again.
import { assignPositions, STANDARD_TUNING, type Song, type SongBar, type SongNote, type SongTrack, type Tech } from './song.ts'

// alphaTab's ticks per quarter note (MidiUtils.QuarterTime).
const TICKS = 960

type AlphaTab = typeof import('@coderline/alphatab')

let library: Promise<AlphaTab> | null = null
// alphaTab hands MusicXML text back with no-break spaces; Finale quotes its titles.
const clean = (text: string | undefined) => (text ?? '').replace(/ /g, ' ').replace(/^["“”\s]+|["“”\s]+$/g, '')
const alphaTab = () => (library ??= import('@coderline/alphatab'))

/**
 * Tempo marks alphaTab misses: Finale writes the tempo as a bare <sound tempo>
 * in the measure, not in a <direction>, and alphaTab then plays at its 120.
 * Returns the tempo per measure (in order) where a measure has one.
 */
export function musicXmlTempos(text: string): Map<number, number> {
	const tempos = new Map<number, number>()
	let index = 0
	for (const [, body] of text.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)) {
		const tempo = body.match(/<sound\b[^>]*\btempo="([\d.]+)"/)
		if (tempo) tempos.set(index, Number(tempo[1]))
		index++
	}
	return tempos
}

/** Reads a Guitar Pro or MusicXML file; throws when it is neither (or broken). */
export async function importSong(bytes: Uint8Array, fileName: string, id: string): Promise<Song> {
	const at = await alphaTab()
	const settings = new at.Settings()
	// A file that is not a score is reported by the caller, not logged here.
	at.Logger.logLevel = at.LogLevel.None
	const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings)
	// Plain-text MusicXML: its own tempo marks win over alphaTab's.
	const head = new TextDecoder().decode(bytes.subarray(0, 512))
	const xmlTempos =
		/<score-(partwise|timewise)/.test(head) || head.trimStart().startsWith('<?xml') ? musicXmlTempos(new TextDecoder().decode(bytes)) : new Map()
	const isMusicXml = xmlTempos.size > 0 || /\.(xml|musicxml|mxl)$/i.test(fileName)

	let tempo = score.tempo || 120
	const bars: SongBar[] = score.masterBars.map((mb, i) => {
		tempo = xmlTempos.get(i) ?? mb.tempoAutomations?.[0]?.value ?? tempo
		return {
			beats: mb.timeSignatureNumerator,
			unit: mb.timeSignatureDenominator,
			tempo,
			...(mb.isRepeatStart ? { repeatStart: true } : {}),
			...(mb.repeatCount ? { repeatEnd: mb.repeatCount } : {}),
			...(mb.alternateEndings ? { endings: mb.alternateEndings } : {}),
			...(mb.section?.text ? { section: clean(mb.section.text) } : {}),
		}
	})

	const tracks: SongTrack[] = []
	for (const track of score.tracks) {
		const staff = track.staves[0]
		if (!staff || staff.isPercussion) continue
		const tuning = staff.stringTuning?.tunings?.length ? [...staff.stringTuning.tunings] : STANDARD_TUNING
		const strings = tuning.length
		// alphaTab counts strings from the lowest (1); Pluck from the highest (1 = high E).
		const ours = (string: number) => strings + 1 - string
		// Per bar, per beat: the notes and, for a score without tab, their pitch and finger.
		const perBar: { note: SongNote; finger?: number; beat: number }[][] = []
		let needsPositions = false
		let beatIndex = 0
		for (const bar of staff.bars) {
			const notes: { note: SongNote; finger?: number; beat: number }[] = []
			for (const voice of bar.voices)
				for (const beat of voice.beats) {
					if (beat.isRest || !beat.notes.length) continue
					beatIndex++
					const at = beat.playbackStart / TICKS
					const length = beat.playbackDuration / TICKS
					beat.notes.forEach((n, k) => {
						const next = beat.nextBeat?.notes.find((m) => m.string === n.string) ?? beat.nextBeat?.notes[0]
						let tech: Tech | undefined
						if (n.isDead) tech = 'x'
						else if (n.isHammerPullOrigin && next) tech = next.realValue > n.realValue ? 'h' : 'p'
						else if (n.slideOutType && next) tech = next.realValue >= n.realValue ? '/' : '\\'
						const bend = n.hasBend && n.maxBendPoint ? Math.round(n.maxBendPoint.value / 2) : 0
						if (n.string < 1) needsPositions = true
						// MusicXML fingering comes in one lower (its 0, an open string, reads -1 = none).
						const lhf = n.leftHandFinger
						const finger = lhf === -2 ? undefined : isMusicXml ? lhf + 1 : lhf
						notes.push({
							note: {
								at,
								length,
								string: n.string >= 1 ? ours(n.string) : 0,
								fret: n.fret,
								midi: n.realValue,
								...(tech ? { tech } : {}),
								...(bend ? { bend } : {}),
								...(n.isTieDestination ? { tied: true } : {}),
							},
							finger,
							beat: beatIndex * 16 + k,
						})
					})
				}
			notes.sort((a, b) => a.note.at - b.note.at || a.note.string - b.note.string)
			perBar.push(notes)
		}
		if (needsPositions) {
			// Group by beat (notes struck together), in time order.
			const groups = new Map<number, { note: SongNote; finger?: number }[]>()
			for (const notes of perBar)
				for (const item of notes) {
					const key = Math.floor(item.beat / 16)
					if (!groups.has(key)) groups.set(key, [])
					groups.get(key)!.push(item)
				}
			const beats = [...groups.values()]
			const placed = assignPositions(
				beats.map((g) => g.map(({ note, finger }) => ({ midi: note.midi, finger }))),
				tuning
			)
			beats.forEach((g, i) =>
				g.forEach((item, k) => {
					item.note.string = placed[i][k].string
					item.note.fret = placed[i][k].fret
				})
			)
		}
		const songBars = perBar.map((notes) => notes.map(({ note }) => note).filter((note) => note.string >= 1))
		if (!songBars.some((notes) => notes.length)) continue
		tracks.push({ name: clean(track.name) || `Track ${tracks.length + 1}`, tuning, bars: songBars })
	}
	if (!tracks.length) throw new Error('No playable track')

	// No section marks: a score's words over a bar ("Verse", "Canto") stand in for them.
	// ponytail: every word counts, so a "rit." can show up as a section too.
	if (!bars.some((bar) => bar.section))
		for (const bar of score.tracks[0]?.staves[0]?.bars ?? []) {
			const text = bar.voices[0]?.beats.find((beat) => beat.text)?.text
			if (text && bars[bar.index]) bars[bar.index].section = clean(text)
		}

	const title = clean(score.title) || fileName.replace(/\.[^.]+$/, '')
	return { id, title, artist: clean(score.artist || score.music || score.words), bars, tracks }
}
