// Trainer → Tab: technique exercises on a strip of tab paper. The strings,
// the TAB clef and the red playhead stay still and only the notes move, so
// nobody has to scroll while playing: in Tempo the strip slides with the
// metronome, in Wait it steps to each note once the mic has heard the one
// before. Exercises and judging live in ts/music/tab.ts, the session in
// ./tab.session.ts; this view draws and wires them.
import * as Tab from '../../music/tab'
import * as Metronome from '../../core/metronome'
import * as Microphone from '../../core/microphone'
import * as Settings from '../../core/settings'
import type { PitchReading } from '../../core/microphone'
import type { View } from '../../ui/view'
import { bindSegmented, liveRegion, onBareKey, scoped, setPressed } from '../../ui/dom'
import { reducedMotion } from '../../ui/media'
import { screenLock } from '../../ui/screen-lock'
import { focusMicButton } from '../../ui/mic-block'
import { createTabSession, type TabResult } from './tab.session'

// One beat takes this much paper whatever the subdivision, so 16ths sit
// closer than 8ths and a bar always reads as a bar.
const BEAT_PX = 112
// Where the playhead stands on the paper (trainer.css .tab-now) and where the
// moving track starts (after the clef).
const PLAYHEAD_X = 96
const TRACK_X = 40
// The top string and the gap between strings (trainer.css .tab-strings).
const STRING_TOP = 24
const STRING_GAP = 16
const TAPE_MARKS = 16

const MARK_GLYPH: Record<Tab.Mark, string> = { hit: '✓', early: '←', late: '→', miss: '×' }
const STRING_NAME = ['', 'high E', 'B', 'G', 'D', 'A', 'low E']
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`

/** How far off a wrong note is, in frets on the string being played. */
function offBy(heard: number, wanted: number): string {
	const d = heard - wanted
	if (Math.abs(d) === 12) return 'an octave off'
	const n = Math.abs(d)
	return `${n} ${n === 1 ? 'fret' : 'frets'} ${d > 0 ? 'high' : 'low'}`
}

export function createTabView(root: HTMLElement): View {
	const { $ } = scoped(root)
	const stage = $<HTMLElement>('.tab-stage')
	const setup = $<HTMLElement>('.tab-setup')
	const goalText = $<HTMLElement>('.tab-goal')
	const title = $<HTMLElement>('.tab-title')
	const how = $<HTMLElement>('.tab-how')
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
	const tempoValue = $<HTMLElement>('.tab-tempo')
	const speedUp = $<HTMLInputElement>('.tab-speedup .switch__input')
	const goalsBox = $<HTMLElement>('.tab-goals')
	const list = $<HTMLElement>('.tab-list')

	// Readings arrive every frame while the mic runs and reset() runs when it stops.
	let micLive = false
	let wasAttack = false

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
		const parts: HTMLElement[] = []
		noteEls = []
		const el = (cls: string, left: number, text = '', top?: number) => {
			const span = document.createElement('span')
			span.className = cls
			span.style.left = `${left}px`
			if (top !== undefined) span.style.top = `${top}px`
			span.textContent = text
			parts.push(span)
			return span
		}
		for (let c = 0; c < copies; c++) {
			const x0 = c * loopPx
			const bar = ex.perBeat * Tab.BEATS_PER_BAR
			for (let step = 0; step < ex.steps; step += ex.perBeat) {
				if (step % bar === 0 && (step || c)) el('tab-bar', x0 + step * sp - sp / 2)
				el('tab-beat', x0 + step * sp, String(((step / ex.perBeat) % Tab.BEATS_PER_BAR) + 1))
			}
			noteEls.push(
				ex.notes.map((note) => {
					const x = x0 + note.step * sp
					const y = STRING_TOP + (note.string - 1) * STRING_GAP
					if (note.tech) el('tab-tech', x - sp / 2, note.tech, y - 15)
					return el('tab-n', x, note.bend ? `${note.fret}b${note.fret + note.bend}` : String(note.fret), y)
				})
			)
		}
		strip.style.width = `${copies * loopPx}px`
		strip.replaceChildren(...parts)
	}

	/** Puts step `pos` of the loop under the playhead (negative: still to come). */
	function placeStrip(pos: number, ex: Tab.TabExercise, smooth: boolean) {
		const wrapped = pos < 0 ? pos : pos % ex.steps
		strip.classList.toggle('tab-strip--step', smooth && !reducedMotion.matches)
		strip.style.transform = `translateX(${(PLAYHEAD_X - TRACK_X - wrapped * stepPx(ex)).toFixed(1)}px)`
	}

	function clearMarks(copy?: number) {
		for (const [c, els] of noteEls.entries()) {
			if (copy !== undefined && c !== copy) continue
			for (const n of els) delete n.dataset.mark
		}
	}

	/* Setup ---------------------------------------------------------------- */
	goalsBox.replaceChildren(
		...[{ id: 'all', label: 'All' }, ...Tab.GOALS].map((goal) => {
			const chip = document.createElement('button')
			chip.type = 'button'
			chip.className = 'chip'
			chip.dataset.goal = goal.id
			chip.textContent = goal.label
			chip.addEventListener('click', () => Settings.update({ tabGoal: goal.id as Settings.Settings['tabGoal'] }))
			return chip
		})
	)

	function renderList() {
		const s = Settings.get()
		const rows = Tab.exercises().filter((ex) => s.tabGoal === 'all' || ex.goal === s.tabGoal)
		list.replaceChildren(
			...rows.map((ex) => {
				const li = document.createElement('li')
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'tab-ex'
				button.setAttribute('aria-pressed', String(ex.id === s.tabExercise))
				const { best } = Tab.loadRecord(ex)
				const goal = Tab.GOALS.find((g) => g.id === ex.goal)!.label
				button.innerHTML =
					'<span class="lamp" aria-hidden="true"></span><span class="tab-ex__text"><span class="tab-ex__name"></span><span class="tab-ex__from"></span></span>' +
					'<span class="tab-ex__best"><span class="silk"></span><span class="window"><span class="lcd"></span></span></span>'
				button.querySelector('.lamp')!.classList.toggle('is-on', ex.id === s.tabExercise)
				button.querySelector('.tab-ex__name')!.textContent = ex.name
				button.querySelector('.tab-ex__from')!.textContent = ex.from
				button.querySelector('.tab-ex__best .silk')!.textContent = goal
				button.querySelector('.tab-ex__best .lcd')!.textContent = best ? `${best} BPM` : '—'
				button.setAttribute('aria-label', `${ex.name}, ${goal}${best ? `, best ${best} BPM` : ''}`)
				button.addEventListener('click', () => Settings.update({ tabExercise: ex.id }))
				li.append(button)
				return li
			})
		)
	}

	const showFollow = bindSegmented(root, 'data-tab-follow', (value) => Settings.update({ tabFollow: value as Settings.Settings['tabFollow'] }))
	loopKey.addEventListener('click', () => Settings.update({ tabLoop: !Settings.get().tabLoop }))
	speedUp.addEventListener('change', () => Settings.update({ tabSpeedUp: speedUp.checked }))

	function setBpm(bpm: number) {
		const ex = exercise()
		const record = Tab.loadRecord(ex)
		Tab.saveRecord(ex, { ...record, bpm: Math.min(Tab.MAX_BPM, Math.max(Tab.MIN_BPM, bpm)) })
		renderSetup()
		renderIdle()
	}
	for (const button of setup.querySelectorAll<HTMLButtonElement>('[data-tab-bpm]')) {
		button.addEventListener('click', () => setBpm(Tab.loadRecord(exercise()).bpm + Number(button.dataset.tabBpm)))
	}

	function renderSetup() {
		const s = Settings.get()
		showFollow(s.tabFollow)
		setPressed([loopKey], () => s.tabLoop)
		speedUp.checked = s.tabSpeedUp
		speedUp.disabled = s.tabFollow === 'wait'
		tempoValue.textContent = `${Tab.loadRecord(exercise()).bpm} BPM`
		for (const chip of goalsBox.querySelectorAll<HTMLButtonElement>('[data-goal]')) chip.setAttribute('aria-pressed', String(chip.dataset.goal === s.tabGoal))
		renderList()
	}

	/* Stage ------------------------------------------------------------------ */
	function showStatus(main: string, side = '') {
		if (statusMain.textContent !== main) statusMain.textContent = main
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
		tape.setAttribute('aria-label', marks.length ? `${hits} of ${marks.length} notes clean` : 'No notes yet')
		tally.textContent = marks.length ? `${Tab.accuracy(marks)}%` : ''
	}

	function waitingText(index: number, wrong: number | null) {
		const note = exercise().notes[index]
		if (!note) return
		const want = Tab.targetMidi(note)
		const where = `${STRING_NAME[note.string]} string · fret ${note.fret}${note.bend ? ` bend to ${note.fret + note.bend}` : ''}`
		showStatus(`${where} · ${noteName(want)}`, wrong === null ? 'Waiting' : `${noteName(wrong)} · ${offBy(wrong, want)}`)
	}

	function renderIdle() {
		const ex = exercise()
		const s = Settings.get()
		const goal = Tab.GOALS.find((g) => g.id === ex.goal)!.label
		goalText.textContent = goal
		title.textContent = ex.name
		how.textContent = `${ex.how} ${ex.from}.`
		paper.setAttribute('aria-label', `Tab: ${ex.name}. ${ex.how}`)
		drawStrip(ex, s.tabLoop ? 2 : 1)
		clearMarks()
		const wait = s.tabFollow === 'wait'
		// The first note waits under the playhead; Start backs the strip up a bar for the count-in.
		placeStrip(0, ex, false)
		const { bpm, best } = Tab.loadRecord(ex)
		showStatus(wait ? 'Wait: the tab moves when you play each note' : `♩ = ${bpm} · ${Tab.subdivisionName(ex.perBeat)}`, best ? `Best ${best} BPM` : '')
		startButton.disabled = false
	}

	function setRunningUi(running: boolean) {
		stage.dataset.phase = session.phase()
		setup.hidden = running
		root.classList.toggle('trainer--running', running)
		startButton.textContent = running ? 'Stop' : session.phase() === 'done' ? 'Start again' : 'Start'
		startButton.classList.toggle('key--hot', !running)
	}

	// Marks arrive loop by loop in order: the first of a loop clears the copy
	// it will be drawn on next time round.
	let marksSeen = 0
	const session = createTabSession(
		{
			countIn: (left) => showStatus(`Count-in · ${left}`, `♩ = ${Metronome.getState().bpm || Tab.loadRecord(exercise()).bpm}`),
			marked(index, mark, marks) {
				const n = exercise().notes.length
				const loop = Math.floor((marks.length - 1) / n)
				const copy = noteEls.length > 1 ? loop % 2 : 0
				if (index === 0 && marks.length > marksSeen && noteEls.length > 1) clearMarks((loop + 1) % 2)
				marksSeen = marks.length
				const el = noteEls[copy]?.[index]
				if (el) el.dataset.mark = mark
				renderTape(marks)
			},
			looped(loops, clean) {
				if (session.config()?.follow === 'wait') {
					announce(`Loop ${loops}${clean ? ', all clean' : ''}`)
					return
				}
				announce(clean ? `Loop ${loops} clean` : `Loop ${loops}`)
			},
			tempo: (bpm) => announce(`${bpm} BPM`),
			waiting(index, wrong) {
				waitingText(index, wrong)
				placeStrip(exercise().notes[index]?.step ?? 0, exercise(), true)
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
		if (pos >= 0) {
			const bar = Math.floor((pos % ex.steps) / (ex.perBeat * Tab.BEATS_PER_BAR)) + 1
			const bars = ex.steps / (ex.perBeat * Tab.BEATS_PER_BAR)
			const loop = Math.floor(pos / ex.steps) + 1
			showStatus(`Bar ${bar} / ${bars}${config.loop ? ` · loop ${loop}` : ''}`, `♩ = ${Metronome.getState().bpm} · ${Tab.subdivisionName(ex.perBeat)}`)
		}
		frameId = requestAnimationFrame(animate)
	}

	function start() {
		if (!micLive) {
			message.textContent = 'The microphone is off. Press Listen, then Start.'
			focusMicButton()
			return
		}
		const s = Settings.get()
		const ex = exercise()
		message.textContent = ''
		marksSeen = 0
		drawStrip(ex, s.tabLoop ? 2 : 1)
		clearMarks()
		renderTape([])
		session.resetHearing()
		session.start({ exercise: ex, follow: s.tabFollow, bpm: Tab.loadRecord(ex).bpm, loop: s.tabLoop, speedUp: s.tabSpeedUp, volume: s.metroVolume, a4: s.a4 })
		setRunningUi(true)
		wakeLock.hold()
		if (s.tabFollow === 'tempo' && !frameId) frameId = requestAnimationFrame(animate)
	}

	function finish(reason = '') {
		const ex = session.config()?.exercise ?? exercise()
		const ended = session.end()
		wakeLock.release()
		if (frameId) cancelAnimationFrame(frameId)
		frameId = 0
		if (ended) report(ex, ended)
		else showStatus('Stopped')
		message.textContent = reason
		setRunningUi(false)
		renderSetup()
	}

	function report(ex: Tab.TabExercise, ended: TabResult) {
		const { marks } = ended
		const pct = Tab.accuracy(marks)
		const clean = marks.filter((m) => m === 'hit').length
		if (ended.follow === 'wait') {
			showStatus(`${clean} of ${marks.length} notes clean`, `${ended.loops} ${ended.loops === 1 ? 'loop' : 'loops'}`)
			announce(`${clean} of ${marks.length} notes clean.`, true)
			return
		}
		const before = Tab.loadRecord(ex)
		const best = Math.max(before.best, ended.cleanBpm)
		// The next session starts where this one ended (the speed-up included).
		Tab.saveRecord(ex, { best, bpm: ended.bpm })
		const record = ended.cleanBpm > before.best ? `New best ${ended.cleanBpm} BPM` : best ? `Best ${best} BPM` : 'No clean loop yet'
		showStatus(`${pct}% on time · ended at ${ended.bpm} BPM`, record)
		announce(`${pct} percent on time. ${record}.`, true)
	}

	startButton.addEventListener('click', () => (isRunning() ? finish() : start()))
	onBareKey([root, stage], ['Space'], () => startButton.click())

	// Hidden page or locked screen: the mic and the timers stall, so no mark from here on would mean anything.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden && isRunning()) finish('Stopped: the page was hidden.')
	})

	// heardAt: when the click is heard, not when this callback runs (up to a frame later).
	Metronome.onBeat((event) => session.beat(event, event.heardAt))

	Settings.subscribe(() => {
		if (Settings.get().trainerExercise !== 'tab' || isRunning()) return
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
			micLive = false
			session.resetHearing()
			if (isRunning()) finish('Stopped: the microphone went off.')
		},

		onReading(reading: PitchReading | null) {
			micLive = true
			// The pipeline flags 'attack' for every frame of its blank: only the first is the pick.
			const attackNow = Microphone.getStats().reason === 'attack'
			const attack = attackNow && !wasAttack
			wasAttack = attackNow
			if (session.frame(performance.now(), reading?.frequency ?? null, attack)) finish()
		},
	}
}
