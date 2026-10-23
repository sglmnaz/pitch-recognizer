// Trainer → Tab: technique exercises on a strip of tab paper. The strings and
// the red playhead stay still and only the notes move, so
// nobody has to scroll while playing: in Tempo the strip slides with the
// metronome, in Wait it steps to each note once the mic has heard the one
// before. Exercises and judging live in ts/music/tab.ts, the session in
// ./tab.session.ts; this view draws and wires them.
import * as Tab from '../../music/tab'
import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import { clamp } from '../../core/math'
import type { View } from '../../ui/view'
import { bindSegmented, liveRegion, onBareKey, scoped, setPressed } from '../../ui/dom'
import { reducedMotion } from '../../ui/media'
import { screenLock } from '../../ui/screen-lock'
import { focusMicButton } from '../../ui/mic-block'
import { createTabSession, type TabResult } from './tab.session'
import { createProbe } from './timing-probe'
import { noteName } from '../../music/note-names'
import * as FieldReport from '../calibration/field-report'
import { plural, t } from '../../core/i18n'
import { bindTempoKeys, numberField } from '../../ui/tempo'
import { placeStrip as place, stringY, stripParts } from '../../ui/tab-strip'
import { createScoreScreen, type ScoreNote, unitPxFor, type VerticalScore } from '../../ui/vertical-score'
import { STANDARD_TUNING } from '../../music/song'

// One beat takes this much paper whatever the subdivision, so 16ths sit
// closer than 8ths and a bar always reads as a bar.
const BEAT_PX = 112
const TAPE_MARKS = 16
// Full screen: paper per step, at least room for one token (34 px) and a gap.
const SCORE_STEP_PX = 40

const MARK_GLYPH: Record<Tab.Mark, string> = { hit: '✓', early: '←', late: '→', miss: '×' }
const STRING_NOTE = ['', 'E', 'B', 'G', 'D', 'A', 'E']
/** 'high E', 'B'…, 'low E', named in the chosen system. */
const stringName = (string: number) =>
	string === 1 ? t('high {note}', { note: noteName('E') }) : string === 6 ? t('low {note}', { note: noteName('E') }) : noteName(STRING_NOTE[string])
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const pitchName = (midi: number) => noteName(`${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`)

/** How far off a wrong note is, in frets on the string being played. */
function offBy(heard: number, wanted: number): string {
	const d = heard - wanted
	if (Math.abs(d) === 12) return t('an octave off')
	const n = Math.abs(d)
	return d > 0 ? plural(n, '{n} fret high', '{n} frets high') : plural(n, '{n} fret low', '{n} frets low')
}

export function createTabView(root: HTMLElement): View {
	const { $ } = scoped(root)
	const stage = $<HTMLElement>('.tab-stage')
	const setup = $<HTMLElement>('.tab-setup')
	const goalText = $<HTMLElement>('.tab-goal')
	const title = $<HTMLElement>('.tab-title')
	const how = $<HTMLElement>('.tab-how')
	const credit = $<HTMLElement>('.tab-by')
	const paper = $<HTMLElement>('.tab-paper')
	const strip = $<HTMLElement>('.tab-strip')
	const statusMain = $<HTMLElement>('.tab-status__main')
	const statusSide = $<HTMLElement>('.tab-status__side')
	const tape = $<HTMLElement>('.tab-marks')
	const tally = $<HTMLElement>('.tab-tally')
	const startButton = $<HTMLButtonElement>('[data-action="tab-start"]')
	const loopKey = $<HTMLButtonElement>('.tab-loop')
	const message = $<HTMLElement>('.tab-message')
	const announce = liveRegion($('.tab-live'), { throttleMs: 4000 })
	const tempoInput = $<HTMLInputElement>('.tab-tempo .lcd-number')
	const slider = $<HTMLInputElement>('.tab-slider')
	const speedUp = $<HTMLInputElement>('.tab-speedup .switch__input')
	const goalsBox = $<HTMLElement>('.tab-goals')
	const levelsBox = $<HTMLElement>('.tab-levels')
	const list = $<HTMLElement>('.tab-list')

	// Readings arrive every frame while the mic runs and reset() runs when it stops.
	let micLive = false
	// Picks, from the energy of the newest samples (Tab.createOnsetDetector).
	const onsets = Tab.createOnsetDetector()

	const exercise = () => Tab.exerciseById(Settings.get().tabExercise)
	const stepPx = (ex: Tab.TabExercise) => BEAT_PX / ex.perBeat

	/* The strip ---------------------------------------------------------------- */
	// Note elements per copy of the loop: [copy][note index]. Two copies side by
	// side when looping, so sliding one loop left joins up seamlessly.
	let noteEls: HTMLElement[][] = []
	let drawnKey = ''

	function drawStrip(ex: Tab.TabExercise, copies: number) {
		const key = `${ex.id}:${ex.notes.map((n) => n.fret).join()}:${copies}`
		if (key === drawnKey) return
		drawnKey = key
		const sp = stepPx(ex)
		const loopPx = ex.steps * sp
		const { parts, el, mark } = stripParts()
		noteEls = []
		for (let c = 0; c < copies; c++) {
			const x0 = c * loopPx
			const bar = ex.perBeat * Tab.BEATS_PER_BAR
			for (let step = 0; step < ex.steps; step += ex.perBeat) {
				if (step % bar === 0 && (step || c)) el('tab-bar', x0 + step * sp - sp / 2)
				el('tab-beat', x0 + step * sp, String(((step / ex.perBeat) % Tab.BEATS_PER_BAR) + 1))
			}
			// The note before on each string: h / p are drawn from it; a tap's T over its own note.
			const before = new Map<number, number>()
			noteEls.push(
				ex.notes.map((note) => {
					const x = x0 + note.step * sp
					const y = stringY(note.string)
					const from = before.get(note.string)
					if (note.tech === 't') el('tab-tech', x, 'T', y - 15)
					else if (note.tech && from !== undefined) mark(note.tech, from, x, y)
					if (note.bend) mark('b', x, x, y, note.fret + note.bend)
					before.set(note.string, x)
					return el('tab-n', x, String(note.fret), y)
				})
			)
		}
		strip.style.width = `${copies * loopPx}px`
		strip.replaceChildren(...parts)
		if (screen.isOpen()) drawScore(ex, copies)
	}

	/** Puts step `pos` of the loop under the playhead (negative: still to come). */
	function placeStrip(pos: number, ex: Tab.TabExercise, smooth: boolean) {
		const wrapped = pos < 0 ? pos : pos % ex.steps
		place(strip, wrapped * stepPx(ex), smooth)
		score?.place(wrapped, isRunning())
	}

	function clearMarks(copy?: number) {
		for (const [c, els] of noteEls.entries()) {
			if (copy !== undefined && c !== copy) continue
			for (const n of els) delete n.dataset.mark
		}
	}

	// The note to play now, circled in red like the sounding note on the
	// approved tab strip: the player sees which note the click belongs to.
	let lit: HTMLElement | null = null
	function light(el: HTMLElement | null) {
		if (el === lit) return
		lit?.classList.remove('tab-n--now')
		el?.classList.add('tab-n--now')
		lit = el
	}

	/**
	 * Tempo: the note within half a step of the playhead at `pos`. placeStrip
	 * wraps every loop back onto the first copy, so the playhead runs over
	 * copy 0; the second copy only shows the next loop coming in.
	 */
	function noteAt(pos: number, ex: Tab.TabExercise): HTMLElement | null {
		if (pos < -0.5) return null
		// Where the playhead is on the strip, as placeStrip puts it; just before
		// the wrap the next loop's first note is on copy 1, right after copy 0.
		const at = pos < 0 ? pos : pos % ex.steps
		for (const [copy, els] of noteEls.entries()) {
			const index = ex.notes.findIndex((n) => Math.abs(n.step + copy * ex.steps - at) <= 0.5)
			if (index >= 0) return els[index] ?? null
		}
		return null
	}

	// Tempo: the loop the strip is showing (floor of position / loop length).
	// A new loop wipes the marks off copy 0 before its notes come round again.
	let shownLoop = 0

	/* Full screen: the exercise upright, Start and Loop under it ------------------- */
	const screenStart = document.createElement('button')
	screenStart.type = 'button'
	screenStart.className = 'btn btn--large key--hot'
	screenStart.textContent = t('Start')
	screenStart.addEventListener('click', () => startButton.click())
	const screenLoop = document.createElement('button')
	screenLoop.type = 'button'
	screenLoop.className = 'key key--lit'
	screenLoop.textContent = t('Loop')
	screenLoop.addEventListener('click', () => loopKey.click())
	const screen = createScoreScreen(
		[
			{ el: screenStart, grow: 2.4 },
			{ el: screenLoop, place: 'top' },
		],
		{
			onClose: () => {
				score = null
			},
			onTempo: (by) => setBpm(Settings.get().tabBpm + by),
		}
	)
	let score: VerticalScore | null = null

	/** The exercise on the upright score: two loops one after the other when looping (as on the strip). */
	function drawScore(ex: Tab.TabExercise, copies: number) {
		const bar = ex.perBeat * Tab.BEATS_PER_BAR
		const notes: ScoreNote[] = []
		const bars: { at: number; label: string }[] = []
		for (let c = 0; c < copies; c++) {
			const x0 = c * ex.steps
			for (let step = 0; step < ex.steps; step += bar) bars.push({ at: x0 + step, label: String(step / bar + 1) })
			for (const [i, note] of ex.notes.entries()) {
				const next = ex.notes[i + 1]?.step ?? ex.steps + (ex.notes[0]?.step ?? 0)
				notes.push({
					at: x0 + note.step,
					length: next - note.step,
					string: note.string,
					label: String(note.fret),
					...(note.tech ? { tech: note.tech === 't' ? 'T' : note.tech } : {}),
					...(note.bend ? { bentTo: note.fret + note.bend } : {}),
				})
			}
		}
		score = screen.setScores([ex.name])[0]
		score.draw({ notes, bars, tuning: STANDARD_TUNING, unitPx: unitPxFor(notes, Math.max(SCORE_STEP_PX, 120 / ex.perBeat)) })
	}

	$('.tab-full').addEventListener('click', () => {
		const ex = session.config()?.exercise ?? exercise()
		drawScore(ex, (session.config()?.loop ?? Settings.get().tabLoop) ? 2 : 1)
		screen.open()
		score?.place(isRunning() && session.config()?.follow === 'tempo' ? Math.max(0, session.position(performance.now())) % ex.steps : 0, isRunning())
		screen.setText(statusMain.textContent ?? '')
	})

	/* Setup ---------------------------------------------------------------- */
	// Two filters over one list: a goal and a level, each with All first.
	function filterChips(box: HTMLElement, options: { id: string; label: string }[], pick: (id: string) => void) {
		box.replaceChildren(
			...[{ id: 'all', label: 'filter|All' }, ...options].map((option) => {
				const chip = document.createElement('button')
				chip.type = 'button'
				chip.className = 'chip'
				chip.dataset.filter = option.id
				chip.textContent = t(option.label)
				chip.addEventListener('click', () => pick(option.id))
				return chip
			})
		)
	}
	filterChips(goalsBox, Tab.GOALS, (id) => Settings.update({ tabGoal: id as Settings.Settings['tabGoal'] }))
	filterChips(levelsBox, Tab.LEVELS, (id) => Settings.update({ tabLevel: id as Settings.Settings['tabLevel'] }))
	const levelOf = (ex: Tab.TabExercise) => t(Tab.LEVELS.find((l) => l.id === ex.level)!.label)

	// One row per exercise; its ▶ key loads it and brings the tab up, ready to start.
	function renderList() {
		const s = Settings.get()
		const rows = Tab.exercises().filter((ex) => (s.tabGoal === 'all' || ex.goal === s.tabGoal) && (s.tabLevel === 'all' || ex.level === s.tabLevel))
		list.replaceChildren(
			...rows.map((ex) => {
				const on = ex.id === s.tabExercise
				const li = document.createElement('li')
				li.className = 'tab-ex'
				li.classList.toggle('is-on', on)
				li.innerHTML =
					'<span class="tab-ex__text"><span class="tab-ex__head"><span class="tab-ex__name"></span><span class="tab-tag"></span></span><span class="tab-ex__meta"></span></span>' +
					'<button class="key key--dark tab-ex__load" type="button">▶</button>'
				const { best } = Tab.loadRecord(ex)
				const goal = t(Tab.GOALS.find((g) => g.id === ex.goal)!.label)
				li.querySelector('.tab-ex__name')!.textContent = ex.name
				li.querySelector('.tab-tag')!.textContent = goal
				const meta = li.querySelector('.tab-ex__meta')!
				meta.textContent = `${levelOf(ex)} · ${Tab.subdivisionName(ex.perBeat)}`
				if (best) {
					const record = document.createElement('b')
					record.textContent = t('Best {bpm} BPM', { bpm: best })
					meta.append(' · ', record)
				}
				const load = li.querySelector<HTMLButtonElement>('.tab-ex__load')!
				load.setAttribute('aria-pressed', String(on))
				load.setAttribute('aria-label', t('Load {name}', { name: ex.name }))
				load.addEventListener('click', () => {
					Settings.update({ tabExercise: ex.id })
					window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' })
				})
				return li
			})
		)
	}

	const showFollow = bindSegmented(root, 'data-tab-follow', (value) => Settings.update({ tabFollow: value as Settings.Settings['tabFollow'] }))
	loopKey.addEventListener('click', () => Settings.update({ tabLoop: !Settings.get().tabLoop }))
	speedUp.addEventListener('change', () => Settings.update({ tabSpeedUp: speedUp.checked }))

	// The tempo, set as on the Metronome: −10 − + +10 (held, they repeat), the fader, or typed.
	const setBpm = (bpm: number) => Settings.update({ tabBpm: clamp(Math.round(bpm), Tab.MIN_BPM, Tab.MAX_BPM) })
	bindTempoKeys(setup.querySelectorAll<HTMLElement>('[data-tempo]'), (by) => setBpm(Settings.get().tabBpm + by))
	slider.addEventListener('input', () => setBpm(Number(slider.value)))
	const tempoField = numberField(tempoInput, () => Settings.get().tabBpm, setBpm)

	function renderSetup() {
		const s = Settings.get()
		showFollow(s.tabFollow)
		setPressed([loopKey, screenLoop], () => s.tabLoop)
		speedUp.checked = s.tabSpeedUp
		speedUp.disabled = s.tabFollow === 'wait'
		tempoField.show(s.tabBpm)
		slider.value = String(s.tabBpm)
		screen.setTempo(`♩ = ${s.tabBpm}`, '', !isRunning())
		for (const chip of goalsBox.querySelectorAll<HTMLButtonElement>('[data-filter]'))
			chip.setAttribute('aria-pressed', String(chip.dataset.filter === s.tabGoal))
		for (const chip of levelsBox.querySelectorAll<HTMLButtonElement>('[data-filter]'))
			chip.setAttribute('aria-pressed', String(chip.dataset.filter === s.tabLevel))
		renderList()
	}

	/* Stage ------------------------------------------------------------------ */
	function showStatus(main: string, side = '') {
		if (statusMain.textContent !== main) statusMain.textContent = main
		screen.setText(main)
		if (statusSide.textContent !== side) statusSide.textContent = side
	}

	function renderTape(marks: Tab.Mark[]) {
		tape.replaceChildren(
			...marks.slice(-TAPE_MARKS).map((mark) => {
				const li = document.createElement('li')
				li.className = `tab-mark tab-mark--${mark}`
				li.textContent = MARK_GLYPH[mark]
				return li
			})
		)
		const hits = marks.filter((m) => m === 'hit').length
		tape.setAttribute('aria-label', marks.length ? t('{clean} of {total} notes clean', { clean: hits, total: marks.length }) : t('No notes yet'))
		tally.textContent = marks.length ? `${Tab.accuracy(marks)}%` : ''
	}

	function waitingText(index: number, wrong: number | null) {
		const note = exercise().notes[index]
		if (!note) return
		const want = Tab.targetMidi(note)
		const where = `${t('{string} string · fret {fret}', { string: stringName(note.string), fret: note.fret })}${note.bend ? ` ${t('bend to {fret}', { fret: note.fret + note.bend })}` : ''}`
		showStatus(`${where} · ${pitchName(want)}`, wrong === null ? t('Waiting') : `${pitchName(wrong)} · ${offBy(wrong, want)}`)
	}

	function renderIdle() {
		const ex = exercise()
		const s = Settings.get()
		const goal = t(Tab.GOALS.find((g) => g.id === ex.goal)!.label)
		goalText.textContent = `${goal} · ${levelOf(ex)}`
		title.textContent = ex.name
		how.textContent = ex.how
		credit.textContent = ex.credit ?? ''
		credit.hidden = !ex.credit
		paper.setAttribute('aria-label', t('Tab: {name}. {how}', { name: ex.name, how: ex.how }))
		drawStrip(ex, s.tabLoop ? 2 : 1)
		clearMarks()
		const wait = s.tabFollow === 'wait'
		// The first note waits under the playhead; Start backs the strip up a bar for the count-in.
		placeStrip(0, ex, false)
		const bpm = s.tabBpm
		const { best } = Tab.loadRecord(ex)
		showStatus(
			wait ? t('Wait: the tab moves when you play each note') : `♩ = ${bpm} · ${Tab.subdivisionName(ex.perBeat)}`,
			best ? t('Best {bpm} BPM', { bpm: best }) : ''
		)
		startButton.disabled = false
	}

	function setRunningUi(running: boolean) {
		stage.dataset.phase = session.phase()
		setup.hidden = running
		root.classList.toggle('trainer--running', running)
		// The tempo is set before Start, as on the page (its stepper hides while running).
		screen.setTempo(`♩ = ${Settings.get().tabBpm}`, '', !running)
		for (const key of [startButton, screenStart]) {
			key.textContent = running ? t('Stop') : session.phase() === 'done' ? t('Start again') : t('Start')
			key.classList.toggle('key--hot', !running)
		}
	}

	// Marks arrive loop by loop, in order, a little after each note.
	const probe = createProbe()
	const session = createTabSession(
		{
			probe: probe.log,
			countIn: (left) => showStatus(t('Count-in · {n}', { n: left }), `♩ = ${Metronome.getState().bpm || Settings.get().tabBpm}`),
			marked(index, mark, marks) {
				const n = exercise().notes.length
				const loop = Math.floor((marks.length - 1) / n)
				// The strip always shows the loop on copy 0 (placeStrip wraps). Wait
				// starts a loop at its first note; in Tempo a late mark of the loop
				// before must not land on notes still to come.
				if (session.config()?.follow === 'wait') {
					if (index === 0) clearMarks(0)
				} else if (loop !== shownLoop) {
					renderTape(marks)
					return
				}
				const el = noteEls[0]?.[index]
				if (el) el.dataset.mark = mark
				renderTape(marks)
			},
			looped(loops, clean) {
				if (session.config()?.follow === 'wait') {
					announce(clean ? t('Loop {n}, all clean', { n: loops }) : t('Loop {n}', { n: loops }))
					return
				}
				announce(clean ? t('Loop {n} clean', { n: loops }) : t('Loop {n}', { n: loops }))
			},
			tempo: (bpm) => announce(`${bpm} BPM`),
			waiting(index, wrong) {
				waitingText(index, wrong)
				placeStrip(exercise().notes[index]?.step ?? 0, exercise(), true)
				light(noteEls[0]?.[index] ?? null)
			},
			announce,
		},
		Metronome
	)
	const isRunning = session.running
	const wakeLock = screenLock(isRunning)

	/* Run ------------------------------------------------------------------- */
	let frameId = 0
	function animate() {
		frameId = 0
		const config = session.config()
		if (!isRunning() || !config || config.follow !== 'tempo') return
		const ex = config.exercise
		const pos = session.position(performance.now())
		placeStrip(pos, ex, false)
		const loopNow = Math.max(0, Math.floor(pos / ex.steps))
		if (loopNow !== shownLoop) {
			shownLoop = loopNow
			clearMarks(0)
		}
		light(noteAt(pos, ex))
		if (pos >= 0) {
			const bar = Math.floor((pos % ex.steps) / (ex.perBeat * Tab.BEATS_PER_BAR)) + 1
			const bars = ex.steps / (ex.perBeat * Tab.BEATS_PER_BAR)
			const loop = Math.floor(pos / ex.steps) + 1
			showStatus(
				`${t('Bar {n} / {bars}', { n: bar, bars })}${config.loop ? ` · ${t('loop {n}', { n: loop })}` : ''}`,
				`♩ = ${Metronome.getState().bpm} · ${Tab.subdivisionName(ex.perBeat)}`
			)
		}
		frameId = requestAnimationFrame(animate)
	}

	function start() {
		if (!micLive) {
			message.textContent = t('The microphone is off. Press Listen, then Start.')
			// Full screen hides the mic key and this message: leave it, so both show.
			if (screen.isOpen()) screen.close()
			focusMicButton()
			return
		}
		const s = Settings.get()
		const ex = exercise()
		message.textContent = ''
		shownLoop = 0
		drawStrip(ex, s.tabLoop ? 2 : 1)
		clearMarks()
		renderTape([])
		light(null)
		session.resetHearing()
		onsets.reset()
		probe.clear()
		session.start({ exercise: ex, follow: s.tabFollow, bpm: s.tabBpm, loop: s.tabLoop, speedUp: s.tabSpeedUp, volume: s.metroVolume, a4: s.a4 })
		setRunningUi(true)
		wakeLock.hold()
		if (s.tabFollow === 'tempo' && !frameId) frameId = requestAnimationFrame(animate)
		FieldReport.sessionStarted()
	}

	function finish(reason = '') {
		const ex = session.config()?.exercise ?? exercise()
		const ended = session.end()
		FieldReport.sessionEnded(probe.finish('tab'), `Tab · ${ex.name}`)
		wakeLock.release()
		if (frameId) cancelAnimationFrame(frameId)
		frameId = 0
		light(null)
		if (ended) report(ex, ended)
		else showStatus(t('Stopped'))
		message.textContent = reason
		setRunningUi(false)
		renderSetup()
	}

	function report(ex: Tab.TabExercise, ended: TabResult) {
		const { marks } = ended
		const pct = Tab.accuracy(marks)
		const clean = marks.filter((m) => m === 'hit').length
		if (ended.follow === 'wait') {
			showStatus(t('{clean} of {total} notes clean', { clean, total: marks.length }), plural(ended.loops, '{n} loop', '{n} loops'))
			announce(`${t('{clean} of {total} notes clean', { clean, total: marks.length })}.`, true)
			return
		}
		const before = Tab.loadRecord(ex)
		const best = Math.max(before.best, ended.cleanBpm)
		// The next session starts where this one ended (the speed-up included).
		Tab.saveRecord(ex, { best })
		// Quietly: the subscriber below would dismiss this report.
		quiet = true
		Settings.update({ tabBpm: ended.bpm })
		quiet = false
		const record =
			ended.cleanBpm > before.best ? t('New best {bpm} BPM', { bpm: ended.cleanBpm }) : best ? t('Best {bpm} BPM', { bpm: best }) : t('No clean loop yet')
		showStatus(t('{pct}% on time · ended at {bpm} BPM', { pct, bpm: ended.bpm }), record)
		announce(t('{pct} percent on time. {record}.', { pct, record }), true)
	}

	startButton.addEventListener('click', () => (isRunning() ? finish() : start()))
	onBareKey([root, stage], ['Space'], () => startButton.click())

	// Hidden page or locked screen: the mic and the timers stall, so no mark from here on would mean anything.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden && isRunning()) finish(t('Stopped: the page was hidden.'))
	})

	// heardAt: when the click is heard, not when this callback runs (up to a frame later).
	Metronome.onBeat((event) => session.beat(event, event.heardAt))

	// Set while a finished session saves the tempo it reached.
	let quiet = false
	Settings.subscribe(() => {
		if (quiet || Settings.get().trainerExercise !== 'tab' || isRunning()) return
		if (session.phase() === 'done') {
			session.dismiss()
			setRunningUi(false)
		}
		// Hidden (e.g. edited on the Settings tab): onActivate renders.
		if (root.hidden) return
		renderSetup()
		renderIdle()
	})

	return {
		onActivate() {
			message.textContent = ''
			renderSetup()
			renderIdle()
			renderTape([])
			setRunningUi(false)
		},

		// The mic stopped, the exercise or the tab changed: a session cannot go on.
		reset() {
			screen.close()
			micLive = false
			session.resetHearing()
			onsets.reset()
			if (isRunning()) finish(t('Stopped: the microphone went off.'))
		},

		// The reading itself goes unused: it is smoothed for the tuner, which lags
		// a fast line and glides through the notes in between. The session reads
		// the frame's own pitch, the picks and the frame's pitch-class profile.
		onReading() {
			micLive = true
			const now = performance.now()
			const wave = Microphone.getWaveform()
			const attack = wave ? onsets.feed(now, Tab.newestEnergy(wave)) : false
			if (!isRunning()) return
			const { pitch, clarity } = Microphone.getStats()
			const frequency = pitch && clarity >= Tab.MIN_CLARITY ? pitch : null
			const power = Microphone.getFramePower()
			const chroma = power ? Tab.chromaOf(power.power, power.binHz, Settings.get().a4) : null
			// The session gets the time it was played: the mic hears it Mic delay later (Settings).
			const { volume, noiseFloor } = Microphone.getStats()
			if (session.frame(now - Settings.get().micDelayMs, frequency, attack, chroma, volume, noiseFloor)) finish()
		},
	}
}
