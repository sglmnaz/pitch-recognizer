// Trainer → Changes: chord-change drills. One-minute changes (count every
// clean change in 30 s – 2 min, best and history per pair) and In time
// (change on the metronome's downbeat, each change marked). Logic lives in
// ts/music/changes.ts, the session state machine in ./changes.session.ts, the
// recognizer seam in ./changes.recognizer.ts; this view draws and wires them.
import * as Changes from '../../music/changes'
import * as Metronome from '../../core/metronome'
import * as Settings from '../../core/settings'
import { clamp } from '../../core/math'
import { loadChordModel } from '../../music/chords'
import { parseChordSymbol } from '../../music/chord-library'
import { chordShapes } from '../../music/chord-shapes'
import { chordDiagram, type ChordDiagram } from '../../ui/chord-diagram'
import type { View } from '../../ui/view'
import { bindSegmented, liveRegion, onBareKey, scoped } from '../../ui/dom'
import { reducedMotion } from '../../ui/media'
import { screenLock } from '../../ui/screen-lock'
import { focusMicButton } from '../../ui/mic-block'
import { faking, heardChord, installDebugHook, resetHeard, strummed } from './changes.recognizer'
import { showLed } from './led'
import { clockText, createChangesSession, verdict } from './changes.session'

// Screen readers hear the count at most this often (a change can come every 250 ms).
const ANNOUNCE_MS = 4000
// In time's meter: ±SCALE_MS full scale (index.html labels its ends), dots for the GHOSTS changes before the last.
const SCALE_MS = 500
const GHOSTS = 8

const MARK_TEXT: Record<Changes.Mark, string> = { hit: 'on time', early: 'early', late: 'late', miss: 'missed' }

const pairLabel = (sequence: string[]) => sequence.join('–')
// In time's LED shows the share of changes on time; its label carries the unit.
const ON_TIME_LABEL = 'On time %'

export function createChangesView(root: HTMLElement): View {
	const { $ } = scoped(root)
	const stage = $<HTMLElement>('.changes-stage')
	const setup = $<HTMLElement>('.changes-setup')
	const clock = $<HTMLElement>('.changes-clock')
	const countValue = $<HTMLElement>('.changes-count__value')
	const countLabel = $<HTMLElement>('.changes-count__label')
	const target = $<HTMLElement>('.changes-target')
	const next = $<HTMLElement>('.changes-next')
	const upcoming = $<HTMLElement>('.changes-upcoming')
	const beatsBox = $<HTMLElement>('.changes-beats')
	const heardText = $<HTMLElement>('.changes-heard span')
	const timing = $<HTMLElement>('.changes-timing')
	const meter = $<HTMLElement>('.changes-meter')
	const meterValue = $<HTMLElement>('.changes-meter__value')
	const scale = $<HTMLElement>('.changes-scale')
	const zone = $<HTMLElement>('.changes-zone')
	const ghosts = $<HTMLElement>('.changes-ghosts')
	const needle = $<HTMLElement>('.changes-needle')
	const missLamp = $<HTMLElement>('.changes-miss .lamp')
	const tally = $<HTMLElement>('.changes-tally')
	const result = $<HTMLElement>('.changes-result')
	const shapesBox = $<HTMLElement>('.changes-shapes')
	const startButton = $<HTMLButtonElement>('[data-action="changes-start"]')
	const status = $<HTMLElement>('.changes-status')
	// Screen readers hear the count at most every ANNOUNCE_MS; starts, ends and results are forced.
	const announce = liveRegion($('.changes-live'), { throttleMs: ANNOUNCE_MS })
	const presetsBox = $<HTMLElement>('.changes-presets')
	const chipsBox = $<HTMLElement>('.changes-chips')
	const order = $<HTMLElement>('.changes-order')
	const summary = $<HTMLElement>('.changes-summary')
	const tempo = $<HTMLElement>('.changes-tempo')
	const tempoValue = $<HTMLElement>('.changes-tempo__value')

	// Readings arrive every frame while the mic runs and reset() runs when it stops.
	let micLive = false

	const selection = () => Settings.get().changesChords
	const valid = () => selection().length >= 2

	/* Chord diagrams ------------------------------------------------------- */
	let shapes: { symbol: string; figure: HTMLElement; diagram: ChordDiagram }[] = []
	let shapesKey = ''

	function renderShapes(sequence: string[]) {
		const key = sequence.join()
		if (key === shapesKey) return
		shapesKey = key
		for (const shape of shapes) shape.diagram.destroy()
		shapes = sequence.map((symbol) => {
			// The setting only holds Changes.CHANGE_CHORDS, all parseable.
			const { rootPc, type } = parseChordSymbol(symbol)!
			const figure = document.createElement('figure')
			figure.className = 'changes-shape'
			// autoRender: redrawn when left-handed or the board theme changes. Three
			// or four across a phone are too small for degree labels: plain dots.
			const diagram = chordDiagram(rootPc, type, chordShapes(rootPc, type, { limit: 1 })[0], {
				autoRender: true,
				fluid: true,
				labels: sequence.length > 2 ? 'none' : 'degrees',
				fingers: false,
			})
			const caption = document.createElement('figcaption')
			caption.textContent = symbol
			figure.append(diagram.el, caption)
			diagram.render()
			return { symbol, figure, diagram }
		})
		shapesBox.replaceChildren(...shapes.map((shape) => shape.figure))
		shapesBox.style.setProperty('--n', String(Math.max(2, shapes.length)))
		// Four across a narrow phone are ~54 px: the stylesheet wraps them 2 × 2.
		shapesBox.dataset.n = String(shapes.length)
	}

	function markTargetShape(symbol: string | null) {
		for (const shape of shapes) shape.figure.classList.toggle('changes-shape--target', shape.symbol === symbol)
	}

	/* Setup ---------------------------------------------------------------- */
	presetsBox.replaceChildren(
		...Changes.PRESETS.map((preset) => {
			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'chip changes-preset'
			button.dataset.preset = preset.join()
			button.textContent = pairLabel(preset)
			button.setAttribute('aria-label', preset.join(', '))
			button.addEventListener('click', () => Settings.update({ changesChords: [...preset] }))
			return button
		})
	)

	// Chips: tap adds a chord to the end of the sequence, tap again takes it out.
	chipsBox.replaceChildren(
		...Changes.CHANGE_CHORDS.map((symbol) => {
			const chip = document.createElement('button')
			chip.type = 'button'
			chip.className = 'chip'
			chip.dataset.chord = symbol
			chip.textContent = symbol
			chip.addEventListener('click', () => {
				const chords = selection()
				if (chords.includes(symbol)) Settings.update({ changesChords: chords.filter((c) => c !== symbol) })
				else if (chords.length < Changes.MAX_CHORDS) Settings.update({ changesChords: [...chords, symbol] })
			})
			return chip
		})
	)

	const showMode = bindSegmented(root, 'data-changes-mode', (value) => Settings.update({ changesMode: value as 'minute' | 'time' }))

	// In time's tempo in 5 BPM steps, within the setting's 40–160 (Settings → Trainer → Changes has the exact field).
	for (const button of tempo.querySelectorAll<HTMLButtonElement>('[data-changes-bpm]')) {
		button.addEventListener('click', () => Settings.update({ changesBpm: clamp(Settings.get().changesBpm + Number(button.dataset.changesBpm), 40, 160) }))
	}

	/** The last sessions traced in pen on chart paper (trainer.css draws the grid): the best dashed, the latest dot in red. */
	function sparkline(history: number[], best: number): string {
		if (history.length < 2) return ''
		const w = 300
		const h = 80
		const pad = 10
		// Headroom above the best, so the trace never runs along the paper's edge.
		const top = Math.max(best, 1) * 1.1
		const x = (i: number) => pad + (i * (w - 2 * pad)) / (history.length - 1)
		const y = (n: number) => h - pad - (n / top) * (h - 2 * pad)
		const points = history.map((n, i) => [x(i).toFixed(1), y(n).toFixed(1)])
		const last = history.length - 1
		const dots = points.map(([cx, cy], i) =>
			i === last ? `<circle class="spark__dot spark__dot--last" cx="${cx}" cy="${cy}" r="3.5"/>` : `<circle class="spark__dot" cx="${cx}" cy="${cy}" r="2"/>`
		)
		return (
			`<span class="silk">Last ${history.length} sessions</span>` +
			'<span class="window"><span class="paper chart">' +
			`<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Last ${history.length} sessions: ${history.join(', ')}">` +
			`<line class="spark__best" x1="${pad}" x2="${w - pad}" y1="${y(best).toFixed(1)}" y2="${y(best).toFixed(1)}"/>` +
			`<polyline class="spark__line" points="${points.join(' ')}"/>${dots.join('')}</svg></span></span>`
		)
	}

	function renderSummary() {
		const s = Settings.get()
		if (!valid()) {
			summary.textContent = 'Pick 2 to 4 chords.'
			return
		}
		if (s.changesMode === 'time') {
			// Numbers only in the markup. Through a speaker the mic hears the clicks too.
			summary.innerHTML =
				`<span>${s.changesBeats} ${s.changesBeats === 1 ? 'beat' : 'beats'} per chord${s.changesSpeedUp ? ' · speeds up' : ''}</span>` +
				'<span>Headphones work best: the mic can hear the clicks.</span>'
			return
		}
		const { best, history } = Changes.loadRecord(selection(), s.changesDuration)
		const length = s.changesDuration < 60 ? `${s.changesDuration} s` : `${s.changesDuration / 60} min`
		summary.innerHTML = history.length
			? `<span class="silk">Best · <b>${best}</b> in ${length}</span>${sparkline(history, best)}`
			: `<span>No ${length} sessions of ${pairLabel(selection())} yet.</span>`
	}

	function renderSetup() {
		const s = Settings.get()
		const chords = selection()
		showMode(s.changesMode)
		tempo.hidden = s.changesMode !== 'time'
		tempoValue.textContent = `${s.changesBpm} BPM`
		for (const button of presetsBox.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
			button.setAttribute('aria-pressed', String(button.dataset.preset === chords.join()))
		}
		for (const chip of chipsBox.querySelectorAll<HTMLButtonElement>('[data-chord]')) {
			const on = chords.includes(chip.dataset.chord!)
			chip.setAttribute('aria-pressed', String(on))
			// Four chosen: the rest cannot be added (aria-disabled keeps them focusable).
			chip.setAttribute('aria-disabled', String(!on && chords.length >= Changes.MAX_CHORDS))
		}
		order.textContent = chords.length ? chords.join(' → ') : ''
		renderSummary()
	}

	/* Stage ------------------------------------------------------------------ */
	// The chords in play: the running session's, else the chosen ones (never repeated, see the chips).
	const sequence = () => (isRunning() ? session.config().sequence : selection())

	function setTarget(symbol: string, then: string) {
		target.textContent = symbol
		target.classList.remove('changes-target--count')
		next.textContent = then
		const seq = sequence()
		upcoming.textContent = seq[(seq.indexOf(symbol) + 1) % seq.length]
		markTargetShape(symbol)
	}

	/** In time: a segment per beat of the chord, numbered, none lit. */
	function renderBeats(count: number) {
		beatsBox.style.setProperty('--beats', String(count))
		beatsBox.replaceChildren(
			...Array.from({ length: count }, (_, i) => {
				const beat = document.createElement('i')
				beat.className = 'changes-beat'
				beat.textContent = String(i + 1)
				return beat
			})
		)
	}

	function lightBeat(index: number | null) {
		beatsBox.querySelectorAll('.changes-beat').forEach((beat, i) => beat.classList.toggle('is-on', i === index))
	}

	// One minute: the change count is the hero, a big LED. In time: the on-time
	// percentage sits in the row at the height of the tempo beside it.
	const sizeCounter = (big: boolean) => countValue.classList.toggle('led--big', big)

	function renderIdle() {
		const s = Settings.get()
		const chords = selection()
		// data-drill, not data-mode: that attribute is the theme's light/dark (ts/ui/theme.ts) and resets the LCD colours.
		stage.dataset.drill = s.changesMode
		timing.hidden = s.changesMode !== 'time'
		renderBeats(s.changesBeats)
		sizeCounter(s.changesMode !== 'time')
		if (s.changesMode === 'time') {
			clock.textContent = `${s.changesBpm} BPM`
			countLabel.textContent = ON_TIME_LABEL
			showLed(countValue, null)
		} else {
			clock.textContent = clockText(s.changesDuration * 1000)
			countLabel.textContent = 'Changes'
			showLed(countValue, 0)
		}
		if (valid()) {
			renderShapes(chords)
			setTarget(chords[0], s.changesMode === 'time' ? `then ${chords[1]}` : `Start on ${chords[0]}, change to ${chords[1]}`)
		} else {
			renderShapes(chords)
			target.textContent = '–'
			next.textContent = ''
			upcoming.textContent = ''
		}
		startButton.disabled = !valid()
	}

	function setRunningUi(running: boolean) {
		// done: the result takes the place of the clock, count and target.
		stage.dataset.phase = session.phase()
		setup.hidden = running
		root.classList.toggle('trainer--running', running)
		startButton.textContent = running ? 'Stop' : session.phase() === 'done' ? 'Start again' : 'Start'
		// The hot key starts; Stop is an ordinary key.
		startButton.classList.toggle('key--hot', !running)
	}

	function showHeard(symbol: string | null) {
		const text = symbol ?? '—'
		if (heardText.textContent !== text) heardText.textContent = text
	}

	function flash() {
		// The count and the strip already say it; reduced motion gets no flash.
		if (reducedMotion.matches) return
		stage.classList.remove('changes-stage--flash')
		// Restart the animation on every counted change.
		void stage.offsetWidth
		stage.classList.add('changes-stage--flash')
	}
	stage.addEventListener('animationend', () => stage.classList.remove('changes-stage--flash'))

	const signed = (ms: number) => `${ms < 0 ? '−' : '+'}${Math.abs(ms)} ms`
	// % of the meter's half scale, pinned to its ends.
	const onScale = (ms: number) => clamp((ms / SCALE_MS) * 100, -100, 100).toFixed(1)

	/** In time: the needle on the last change, dots on the ones before, the Miss lamp and the tally. */
	function renderMeter(marks: Changes.Mark[], offsets: (number | null)[], hitMs: number) {
		const last = marks.length - 1
		const mark = marks[last]
		const dt = offsets[last] ?? null
		const shown = dt === null ? null : Math.round(dt)
		if (mark) meter.dataset.mark = mark
		else delete meter.dataset.mark
		zone.style.setProperty('--hit', onScale(hitMs))
		meterValue.textContent = !mark ? '—' : shown === null ? 'Missed' : `${signed(shown)} · ${MARK_TEXT[mark]}`
		needle.hidden = shown === null
		if (shown !== null) needle.style.setProperty('--x', onScale(shown))
		const before = offsets.slice(Math.max(0, last - GHOSTS), Math.max(0, last))
		ghosts.replaceChildren(
			...before.flatMap((ms, i) => {
				if (ms === null) return []
				const dot = document.createElement('i')
				dot.className = 'changes-ghost'
				dot.dataset.mark = marks[last - before.length + i]
				dot.style.setProperty('--x', onScale(ms))
				// Older fainter: up to 0.7 for the one just before the needle.
				dot.style.setProperty('--o', (0.25 + (0.45 * (i + 1)) / before.length).toFixed(2))
				return [dot]
			})
		)
		missLamp.classList.toggle('is-on', mark === 'miss')
		const hits = marks.filter((m) => m === 'hit').length
		const misses = marks.filter((m) => m === 'miss').length
		tally.textContent = marks.length ? `On time ${hits} / ${marks.length}${misses ? ` · ${misses} missed` : ''}` : ''
		const lastText = shown === null ? 'missed' : `${MARK_TEXT[mark]}, ${Math.abs(shown)} ms ${shown < 0 ? 'before' : 'after'} the beat`
		scale.setAttribute('aria-label', mark ? `Last change ${lastText}. ${hits} of ${marks.length} changes on time.` : 'No changes yet')
	}

	function showCount(left: number, first: string) {
		target.textContent = String(left)
		target.classList.add('changes-target--count')
		next.textContent = `Get ready on ${first}`
		upcoming.textContent = first
	}

	const session = createChangesSession(
		{
			heard: showHeard,
			countIn: showCount,
			target: setTarget,
			beat: lightBeat,
			clock: (text) => (clock.textContent = text),
			counted(count) {
				showLed(countValue, count)
				flash()
				announce(`${count} ${count === 1 ? 'change' : 'changes'}`)
			},
			marked(marks, offsets, hitMs) {
				renderMeter(marks, offsets, hitMs)
				showLed(countValue, Changes.accuracy(marks))
				if (marks[marks.length - 1] === 'hit') flash()
			},
			announce,
		},
		Metronome
	)
	const isRunning = session.running

	// A phone that sleeps mid-session stops the mic.
	const wakeLock = screenLock(isRunning)

	/* Run ------------------------------------------------------------------- */
	function start() {
		if (!valid()) return
		if (!micLive && !faking()) {
			status.textContent = 'The microphone is off. Press Listen, then Start.'
			focusMicButton()
			return
		}
		const s = Settings.get()
		const mode = s.changesMode
		resetHeard()
		result.hidden = true
		status.textContent = ''
		stage.dataset.drill = mode
		timing.hidden = mode !== 'time'
		renderMeter([], [], Changes.hitWindow((s.changesBeats * 60000) / s.changesBpm))
		renderBeats(s.changesBeats)
		sizeCounter(mode === 'minute')
		if (mode === 'minute') {
			showLed(countValue, 0)
			countLabel.textContent = 'Changes'
			clock.textContent = clockText(s.changesDuration * 1000)
		} else {
			showLed(countValue, null)
			countLabel.textContent = ON_TIME_LABEL
			clock.textContent = `${s.changesBpm} BPM`
		}
		session.start(
			{
				mode,
				sequence: [...selection()],
				seconds: s.changesDuration,
				beats: s.changesBeats,
				bpm: s.changesBpm,
				speedUp: s.changesSpeedUp,
				countIn: s.changesCountIn,
				volume: s.metroVolume,
			},
			performance.now()
		)
		setRunningUi(true)
		wakeLock.hold()
	}

	/** Ends the session; `finished` = ran its course (stored), otherwise stopped. */
	function finish(finished: boolean, reason = '') {
		const wasTime = session.config().mode === 'time'
		const ended = session.end(finished)
		wakeLock.release()
		if (ended?.mode === 'minute') {
			const { count, before } = ended
			const said = verdict(count, before)
			showResult(String(count), count === 1 ? 'change' : 'changes', [said, `Best ${Math.max(before.best, count)}`])
			announce(`Time. ${count} changes. ${said}.`, true)
			status.textContent = ''
		} else if (ended?.mode === 'time') {
			const { marks } = ended
			const pct = Changes.accuracy(marks)
			const n = (m: Changes.Mark) => marks.filter((x) => x === m).length
			showResult(`${pct}%`, 'on time', [
				`${n('hit')} of ${marks.length} changes`,
				`${n('late')} late · ${n('early')} early · ${n('miss')} missed`,
				`Ended at ${ended.bpm} BPM`,
			])
			announce(`${pct} percent on time, ${n('hit')} of ${marks.length} changes.`, true)
			// Stopped by the page, not the player: say why under the result.
			status.textContent = reason
		} else {
			result.hidden = true
			status.textContent = reason || (wasTime ? 'Stopped.' : 'Stopped. Sessions count only when the time runs out.')
			renderIdle()
		}
		setRunningUi(false)
		renderSummary()
	}

	function showResult(big: string, unit: string, lines: string[]) {
		result.innerHTML = '<p class="changes-result__big"><span></span> <small></small></p><ul class="changes-result__lines"></ul>'
		result.querySelector('span')!.textContent = big
		result.querySelector('small')!.textContent = unit
		result.querySelector('ul')!.replaceChildren(
			...lines.map((line) => {
				const li = document.createElement('li')
				li.textContent = line
				return li
			})
		)
		result.hidden = false
	}

	startButton.addEventListener('click', () => (isRunning() ? finish(false) : start()))

	// Space starts and stops, only where it does nothing else (the bare page).
	onBareKey([root, stage], ['Space'], () => startButton.click())

	// Hidden page or locked screen: the mic and the timers stall, so no count
	// or mark from here on would mean anything. End it rather than pause it.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden && isRunning()) finish(false, 'Stopped: the page was hidden.')
	})

	// In time: downbeats from the metronome.
	Metronome.onBeat((event) => session.beat(event, performance.now()))

	/* Per frame ----------------------------------------------------------------- */
	function frame() {
		const now = performance.now()
		// The session gets the time it was played: the mic hears it Mic delay later (Settings).
		if (session.frame(now - Settings.get().micDelayMs, strummed(now), heardChord(now)?.symbol ?? null)) finish(true)
	}

	// ?debug: fake chords drive frames while the mic is off.
	installDebugHook(() => {
		if (!micLive && !root.hidden) frame()
	})

	Settings.subscribe(() => {
		if (Settings.get().trainerExercise !== 'changes' || isRunning()) return
		// A finished session's result stays on screen until the setup changes.
		if (session.phase() === 'done') {
			session.dismiss()
			result.hidden = true
			setRunningUi(false)
		}
		// Hidden (e.g. edited on the Settings tab): onActivate renders and reads the record.
		if (root.hidden) return
		renderSetup()
		renderIdle()
	})

	return {
		onActivate() {
			// ~100 KB of weights, loaded on first use: start now so they are ready by Start.
			loadChordModel().catch(() => {}) // logged once by the loader
			status.textContent = ''
			renderSetup()
			renderIdle()
			setRunningUi(false)
		},

		// The mic stopped, the exercise or the tab changed: a session cannot go on.
		reset() {
			micLive = false
			resetHeard()
			session.resetHearing()
			showHeard(null)
			if (isRunning()) finish(false, 'Stopped: the microphone went off.')
		},

		onReading() {
			micLive = true
			frame()
		},
	}
}
