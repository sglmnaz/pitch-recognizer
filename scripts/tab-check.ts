// Self-check for ts/music/tab.ts and the Trainer → Tab session: the generated
// exercises, the note follower, note judging, and whole sessions in Tempo and
// Wait played by a simulated guitarist against a fake metronome and clock.
// Run with `npm run check:tab`.
import * as Tab from '../ts/music/tab.ts'
import { createTabSession, type MetronomeControl, type TabSessionUi } from '../ts/features/trainer/tab.session.ts'
import type { BeatEvent } from '../ts/core/metronome.ts'
import { check, finish } from './check.ts'

const FRAME = 1000 / 60
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

/* Exercises -------------------------------------------------------------------- */
const all = Tab.exercises(new Date(2026, 9, 21))
check('nine exercises, unique ids', all.length === 9 && new Set(all.map((e) => e.id)).size === 9)
for (const e of all) {
	const bar = e.perBeat * Tab.BEATS_PER_BAR
	const ordered = e.notes.every((n, i) => i === 0 || n.step > e.notes[i - 1].step)
	const playable = e.notes.every((n) => n.string >= 1 && n.string <= 6 && n.fret >= 0 && n.fret <= 22 && Number.isInteger(n.step))
	check(
		`${e.id}: whole bars, notes in order inside the loop, playable`,
		e.steps % bar === 0 && ordered && playable && e.notes[e.notes.length - 1].step < e.steps
	)
}
const byId = (id: string) => all.find((e) => e.id === id)!
check('spider: 40 eighths, frets 5–8, up and back', byId('spider').notes.length === 40 && byId('spider').notes.every((n) => n.fret >= 5 && n.fret <= 8))
check('24 different permutations', new Set(Tab.PERMUTATIONS.map((p) => p.join())).size === 24)
check('a new permutation the next day', Tab.permutationOfDay(new Date(2026, 9, 21, 9)) !== Tab.permutationOfDay(new Date(2026, 9, 22, 9)))
check('the same permutation all day', Tab.permutationOfDay(new Date(2026, 9, 21, 0, 5)) === Tab.permutationOfDay(new Date(2026, 9, 21, 23, 55)))
const skip = byId('skipping')
const upHalf = skip.notes.slice(0, skip.notes.length / 2)
// Each group of six (three on the G string, three on the high E) rises, and each group starts a scale step higher.
const groups = Array.from({ length: upHalf.length / 6 }, (_, g) => upHalf.slice(g * 6, g * 6 + 6).map(Tab.midiOf))
check(
	'string skipping: only strings 1 and 3, in G major, each group rising a step',
	skip.notes.every((n) => n.string === 1 || n.string === 3) &&
		skip.notes.every((n) => [7, 9, 11, 0, 2, 4, 6].includes(Tab.midiOf(n) % 12)) &&
		groups.every((g, i) => g.every((m, j) => j === 0 || m > g[j - 1]) && (i === 0 || g[0] > groups[i - 1][0]))
)
check('trills: one pick per finger, the rest hammer-ons and pull-offs', byId('trills').notes.filter((n) => !n.tech).length === 3)
check('bend: B string fret 7 up a whole step reaches G#4 (fret 4 on high E)', Tab.targetMidi(byId('bends').notes[0]) === Tab.midiOf(byId('bends').notes[1]))

/* Note follower ------------------------------------------------------------------- */
{
	const f = Tab.createNoteFollower()
	const got: Tab.NoteEvent[] = []
	const feed = (from: number, to: number, midi: number | null, attackAt?: number) => {
		for (let t = from; t < to; t += FRAME) {
			const e = f.feed(t, midi, attackAt !== undefined && t >= attackAt && t < attackAt + FRAME)
			if (e) got.push(e)
		}
	}
	feed(0, 100, null)
	feed(100, 300, 60, 100)
	check('picked note: one event, dated at the attack', got.length === 1 && got[0].midi === 60 && Math.abs(got[0].at - (100 - Tab.ATTACK_LATENCY_MS)) < FRAME)
	feed(300, 500, 60, 300)
	check('the same note picked again counts again', got.length === 2 && Math.abs(got[1].at - (300 - Tab.ATTACK_LATENCY_MS)) < FRAME)
	feed(500, 700, 62)
	check(
		'hammer-on (pitch moves, no attack): dated back by the legato latency',
		got.length === 3 && got[2].midi === 62 && Math.abs(got[2].at - (500 - Tab.LEGATO_LATENCY_MS)) < FRAME
	)
	feed(700, 700 + FRAME, 65)
	feed(700 + FRAME, 900, 62)
	check('one stray frame is not a note', got.length === 3)
	feed(900, 1100, null)
	feed(1100, 1300, 62)
	check('after silence the same note is new', got.length === 4)
	// During the attack blank the pipeline repeats the old note.
	feed(1300, 1300 + 40, 62, 1300)
	feed(1340, 1500, 64)
	check(
		'the old note held over the attack blank is not counted',
		got.length === 5 && got[4].midi === 64 && Math.abs(got[4].at - (1300 - Tab.ATTACK_LATENCY_MS)) < FRAME
	)
}

/* Judging -------------------------------------------------------------------- */
{
	const w = Tab.noteWindow(500)
	check('slow steps: on time within 110 ms', w.hit === Tab.HIT_MS && w.reach === 250)
	check('fast steps: never under the floor', Tab.noteWindow(100).hit === Tab.HIT_FLOOR_MS && Tab.noteWindow(100).reach === Tab.HIT_FLOOR_MS)
	const events: Tab.NoteEvent[] = [
		{ midi: 60, at: 1000 },
		{ midi: 62, at: 1680 },
		{ midi: 64, at: 1900 },
	]
	const used = new Set<number>()
	check('judge: on time', Tab.judgeNote(1030, 60, 500, events, used) === 'hit')
	check('judge: late', Tab.judgeNote(1500, 62, 500, events, used) === 'late')
	check('judge: wrong pitch is a miss', Tab.judgeNote(2000, 65, 500, events, used) === 'miss')
	check('judge: an event counts once', Tab.judgeNote(1050, 60, 500, events, used) === 'miss')
}

/* Sessions --------------------------------------------------------------------- */
interface Ui extends TabSessionUi {
	marks: Tab.Mark[]
	loops: boolean[]
	waits: [number, number | null][]
	tempos: number[]
}
function ui(): Ui {
	const u: Ui = {
		marks: [],
		loops: [],
		waits: [],
		tempos: [],
		countIn() {},
		marked: (_i, mark) => void u.marks.push(mark),
		looped: (_n, clean) => void u.loops.push(clean),
		tempo: (bpm) => void u.tempos.push(bpm),
		waiting: (i, wrong) => void u.waits.push([i, wrong]),
		announce() {},
	}
	return u
}

function fakeMetronome() {
	const m = { bpm: 0, running: false }
	const control: MetronomeControl = {
		configure() {},
		setTempo: (bpm: number) => {
			m.bpm = bpm
		},
		start: () => {
			m.running = true
		},
		stop: () => {
			m.running = false
		},
		getState: () => ({ running: m.running, bpm: m.bpm, bar: 0, beat: 0 }),
	}
	return { m, control }
}

/** What the player sounds: from `start`, `midi` (picked unless legato), until the next sound. Bends glide to `bendTo`. */
interface Sound {
	start: number
	midi: number
	legato?: boolean
	bendTo?: number
}

/** The mic's view of the sounds at time t: the frequency read (null = none) and whether this frame is an attack. */
function hear(sounds: Sound[], t: number, frame: number): { frequency: number | null; attack: boolean } {
	const i = sounds.findLastIndex((s) => s.start <= t)
	if (i < 0) return { frequency: null, attack: false }
	const s = sounds[i]
	const before = sounds[i - 1]
	const attack = !s.legato && t >= s.start + Tab.ATTACK_LATENCY_MS && t < s.start + Tab.ATTACK_LATENCY_MS + frame
	// Picked: the old reading is held through the attack blank. Legato: the median lags.
	const lag = s.legato ? Tab.LEGATO_LATENCY_MS : 40
	if (t < s.start + lag) return { frequency: before ? hz(before.midi) : null, attack }
	if (s.bendTo === undefined) return { frequency: hz(s.midi), attack }
	const k = Math.min(1, (t - s.start - lag) / 200)
	return { frequency: hz(s.midi + k * (s.bendTo - s.midi)), attack }
}

/**
 * Plays `exercise` in Tempo for `beats` beats: `player(note, dueAt)` returns the
 * sound to make for each note (or null to skip it). Returns the UI log and metronome.
 */
function tempoSession(exercise: Tab.TabExercise, beats: number, player: (note: Tab.TabNote, at: number) => Sound | null, loop = true, speedUp = true) {
	const u = ui()
	const { m, control } = fakeMetronome()
	const session = createTabSession(u, control)
	session.start({ exercise, follow: 'tempo', bpm: 60, loop, speedUp, volume: 0, a4: 440 })
	const sounds: Sound[] = []
	let nextBeat = 500
	let beat = 0
	let beatBpm = m.bpm
	let ended = false
	const positions: number[] = []
	for (let t = 0; t < 500 + beats * 1100 && !ended; t += FRAME) {
		if (t >= nextBeat && beat < beats) {
			beatBpm = m.bpm
			const event: BeatEvent = { time: 0, bar: Math.floor(beat / 4), beat: beat % 4, sub: 0, accent: beat % 4 ? 1 : 2, bpm: beatBpm, heardAt: nextBeat }
			session.beat(event, nextBeat)
			const inLoop = (beat - 4) % (exercise.steps / exercise.perBeat)
			if (beat >= 4) {
				const stepMs = 60000 / beatBpm / exercise.perBeat
				for (const note of exercise.notes) {
					if (Math.floor(note.step / exercise.perBeat) !== inLoop) continue
					const sound = player(note, nextBeat + (note.step % exercise.perBeat) * stepMs)
					if (sound) sounds.push(sound)
				}
				sounds.sort((a, b) => a.start - b.start)
			}
			positions.push(session.position(nextBeat))
			beat++
			nextBeat += 60000 / m.bpm
		}
		const { frequency, attack } = hear(sounds, t, FRAME)
		ended = session.frame(t, frequency, attack)
	}
	return { u, m, session, positions, ended }
}

const spiderEx = byId('spider')
const clean = (note: Tab.TabNote, at: number): Sound => ({
	start: at,
	midi: Tab.midiOf(note),
	legato: note.tech !== undefined,
	bendTo: note.bend ? Tab.targetMidi(note) : undefined,
})
{
	// Spider at 60 BPM: 20 beats a loop; count-in 4 + 2 loops + spare.
	const run = tempoSession(spiderEx, 4 + 40 + 4, clean)
	check(
		'tempo: every note of a clean player is on time',
		run.u.marks.length >= 80 && run.u.marks.slice(0, 80).every((m) => m === 'hit'),
		`${Tab.accuracy(run.u.marks)}% · ${run.u.marks
			.map((m, i) => (m === 'hit' ? '' : `${i}:${m}`))
			.filter(Boolean)
			.join(' ')}`
	)
	check('tempo: two clean loops, then +5 BPM', run.u.loops.slice(0, 2).every(Boolean) && run.u.tempos[0] === 65 && run.m.bpm === 65)
	check('tempo: the tab counts in from four beats before the top', run.positions[0] === -8 && run.positions[4] === 0 && run.positions[5] === 2)
}
{
	const late = tempoSession(spiderEx, 4 + 20 + 2, (n, at) => clean(n, at + 160))
	check(
		'tempo: 160 ms behind at 60 BPM eighths is late',
		late.u.marks.slice(0, 20).every((m) => m === 'late'),
		late.u.marks.slice(0, 6).join(' ')
	)
	const wrong = tempoSession(spiderEx, 4 + 20 + 2, (n, at) => ({ ...clean(n, at), midi: Tab.midiOf(n) + 1 }))
	check(
		'tempo: a fret off is a miss',
		wrong.u.marks.slice(0, 20).every((m) => m === 'miss')
	)
	const once = tempoSession(spiderEx, 4 + 40, clean, false)
	check('tempo without loop: ends after one pass', once.ended && once.u.marks.length === 40 && once.u.loops.length === 1)
}
{
	const run = tempoSession(byId('trills'), 4 + 8 + 2, clean)
	check(
		'tempo: hammer-ons and pull-offs count without a pick',
		run.u.marks.slice(0, 24).every((m) => m === 'hit'),
		run.u.marks.slice(0, 24).join(' ')
	)
	const bursts = tempoSession(byId('bursts'), 4 + 12 + 2, clean)
	check(
		'tempo: repeated notes on one fret count one by one',
		bursts.u.marks.slice(0, byId('bursts').notes.length).every((m) => m === 'hit'),
		`${Tab.accuracy(bursts.u.marks)}% · ${bursts.u.marks
			.map((m, i) => (m === 'hit' ? '' : `${i}:${m}`))
			.filter(Boolean)
			.join(' ')}`
	)
	const bends = tempoSession(byId('bends'), 4 + 8 + 2, clean)
	const bendsLow = tempoSession(byId('bends'), 4 + 8 + 2, (n, at) => ({ ...clean(n, at), bendTo: n.bend ? Tab.targetMidi(n) - 0.5 : undefined }))
	check(
		'tempo: a bend that reaches its note is on time, one short of it is a miss',
		bends.u.marks.slice(0, 4).every((m) => m === 'hit') && bendsLow.u.marks[0] === 'miss' && bendsLow.u.marks[2] === 'miss'
	)
}

/* Wait ------------------------------------------------------------------------- */
function waitSession(exercise: Tab.TabExercise, sounds: Sound[], until: number, loop = true) {
	const u = ui()
	const session = createTabSession(u, fakeMetronome().control)
	session.start({ exercise, follow: 'wait', bpm: 60, loop, speedUp: false, volume: 0, a4: 440 })
	let ended = false
	for (let t = 0; t < until && !ended; t += FRAME) {
		const { frequency, attack } = hear(sounds, t, FRAME)
		ended = session.frame(t, frequency, attack)
	}
	return { u, session, ended }
}
{
	const first = spiderEx.notes[0]
	const second = spiderEx.notes[1]
	const right = waitSession(
		spiderEx,
		[
			{ start: 300, midi: Tab.midiOf(first) },
			{ start: 2000, midi: Tab.midiOf(second) + 1 },
			{ start: 2600, midi: Tab.midiOf(second) },
		],
		3200
	)
	check('wait: the right note moves on, marked clean', right.u.marks[0] === 'hit' && right.session.position(3200) === spiderEx.notes[2].step)
	check(
		'wait: a wrong note is reported and the tab waits',
		right.u.waits.some(([i, w]) => i === 1 && w === Tab.midiOf(second) + 1)
	)
	check('wait: the note after a wrong one is marked', right.u.marks[1] === 'miss')
	const bend = byId('bends')
	const b = waitSession(bend, [{ start: 300, midi: Tab.midiOf(bend.notes[0]), bendTo: Tab.targetMidi(bend.notes[0]) }], 1200)
	const bShort = waitSession(bend, [{ start: 300, midi: Tab.midiOf(bend.notes[0]), bendTo: Tab.targetMidi(bend.notes[0]) - 0.5 }], 1200)
	check('wait: a bend that reaches its note moves on, one short waits', b.u.marks[0] === 'hit' && !bShort.u.marks.length)
	const all4 = bend.notes.map((n, i): Sound => ({ start: 300 + i * 900, midi: Tab.midiOf(n), bendTo: n.bend ? Tab.targetMidi(n) : undefined }))
	const once = waitSession(bend, all4, 5000, false)
	check('wait without loop: ends after the last note', once.ended && once.u.marks.length === 4 && once.u.loops.length === 1)
}

/* Records ------------------------------------------------------------------------- */
// No storage in Node: defaults, never a throw.
check('records: no storage reads the defaults', Tab.loadRecord(spiderEx).best === 0 && Tab.loadRecord(spiderEx).bpm === spiderEx.startBpm)

finish('All tab checks passed')
