// Trainer → Changes: chord-change drills. One-minute changes (count every
// clean change in 30 s – 2 min, best and history per pair) and In time
// (change on the metronome's downbeat, each change marked). Logic lives in
// ts/changes.ts; this wires the DOM, the mic and the metronome.
import * as Changes from '../changes'
import * as Metronome from '../metronome'
import * as Microphone from '../microphone'
import * as Settings from '../settings'
import { createChordTracker, loadChordModel, PITCH_CLASSES } from '../chords'
import { chordType } from '../chord-theory'
import { chordShapes, voicingSpec } from '../chord-shapes'
import { createFretboard, type Fretboard } from '../fretboard'
import type { View } from './view'

/* Chord adapter ------------------------------------------------------------ */

/**
 * What the recognizer hears right now. Contract: `symbol` spelt like
 * Changes.CHANGE_CHORDS (a PITCH_CLASSES root + a chord-theory symbol: 'C',
 * 'Am', 'G7'), `rootPc` 0–11 (C = 0), `type` the symbol after the root ('',
 * 'm', '7'), `confidence` 0–1; null = no chord. Called once per mic frame
 * with the frame's time: the HMM tracker smooths over time.
 */
export interface HeardChord {
	symbol: string
	rootPc: number
	type: string
	confidence?: number
}

// Our own tracker (ts/chords.ts): the Chords view's smoother never shares state with it.
const tracker = createChordTracker()
// Like the Chords view: forget the tracked chord after this much continuous
// silence (not on every silent frame, a strum's gaps are part of it), so the
// HMM never carries a chord across a long gap.
const SILENCE_RESET_MS = 300
let silentSince: number | null = null

// ?debug: chords fed by hand from the console (the mic is often unavailable
// where the UI is tested). undefined = off, null = "no chord". Each fed
// chord counts as strummed once.
let fake: string | null | undefined
let fakeStrum = false

export function heardChord(now: number): HeardChord | null {
	if (fake !== undefined) {
		const root = fake?.match(/^[A-G][#b]?/)?.[0]
		return fake && root ? { symbol: fake, rootPc: PITCH_CLASSES.indexOf(root), type: fake.slice(root.length) } : null
	}
	// Same silence gate as the Chords view. Until the model has loaded the
	// tracker answers "no chord" (and starts the load itself).
	const spectrum = Microphone.getSpectrum()
	const analysis = spectrum && Microphone.isSounding() ? tracker.track(spectrum.spectrumDb, spectrum.binHz, now, Settings.get().a4) : null
	if (analysis) silentSince = null
	else {
		silentSince ??= now
		if (now - silentSince >= SILENCE_RESET_MS) tracker.reset()
	}
	const chord = analysis?.chord
	if (!chord) return null
	const root = chord.notes[0]
	return { symbol: chord.name, rootPc: PITCH_CLASSES.indexOf(root), type: chord.name.slice(root.length), confidence: chord.score }
}

/** Forgets what the recognizer was following, so a new session (or a mic restart) starts clean. */
export function resetHeard() {
	tracker.reset()
	silentSince = null
}

/** A strum's attack this frame (the pitch pipeline's onset detector): what tells a played chord from a recognizer flip. */
function strummed(): boolean {
	if (fake !== undefined) {
		const strum = fakeStrum
		fakeStrum = false
		return strum
	}
	return Microphone.getStats().reason === 'attack'
}

/* View --------------------------------------------------------------------- */

// The tracker names a chord this long after it was strummed (its 370 ms
// spectrum has to fill with the new chord and the HMM has to be convinced),
// so an onset is dated this much earlier before it is judged against a
// downbeat. 283 ms = the benchmark's median from a real chord change to its
// first naming (bench/README.md); check:chords' synthetic strums read 205 ms
// for a change after a pause, 372 ms from cold. Calibration knob: raise it
// if clean changes read late on real guitars.
const RECOGNITION_LATENCY_MS = 283
// From a chord's (backdated) onset to the frame it is confirmed stable.
const CONFIRM_MS = RECOGNITION_LATENCY_MS + Changes.STABLE_MS + Changes.FLICKER_MS
const COUNT_IN_S = 3
// In time: one bar of 4 clicks, a whole number of chords at 1, 2 or 4 beats each.
const COUNT_IN_BEATS = 4
// Screen readers hear the count at most this often (a change can come every 250 ms).
const ANNOUNCE_MS = 4000
const STRIP_MARKS = 12
// Onsets older than this cannot fall in any slot still waiting to be judged.
const ONSET_KEEP_MS = 10_000
// In time: through a speaker the mic hears each click as an attack. One within
// this of the last click heard is the click, not a strum (a chord change on the
// beat still counts: another name came between). Calibration knob: widen it if
// clicks still read as strums on a phone with a slow input path.
const CLICK_MASK_MS = 40

type Phase = 'idle' | 'countin' | 'running' | 'done'

const MARK_GLYPH: Record<Changes.Mark, string> = { hit: '●', early: '‹', late: '›', miss: '×' }
const MARK_TEXT: Record<Changes.Mark, string> = { hit: 'on time', early: 'early', late: 'late', miss: 'missed' }

const pairLabel = (sequence: string[]) => sequence.join('–')
const clockText = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function createChangesView(root: HTMLElement): View {
	const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!
	const stage = $<HTMLElement>('.changes-stage')
	const setup = $<HTMLElement>('.changes-setup')
	const clock = $<HTMLElement>('.changes-clock')
	const countValue = $<HTMLElement>('.changes-count__value')
	const countLabel = $<HTMLElement>('.changes-count__label')
	const target = $<HTMLElement>('.changes-target')
	const next = $<HTMLElement>('.changes-next')
	const heardText = $<HTMLElement>('.changes-heard span')
	const strip = $<HTMLElement>('.changes-strip')
	const result = $<HTMLElement>('.changes-result')
	const shapesBox = $<HTMLElement>('.changes-shapes')
	const startButton = $<HTMLButtonElement>('[data-action="changes-start"]')
	const status = $<HTMLElement>('.changes-status')
	const live = $<HTMLElement>('.changes-live')
	const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-changes-mode]'))
	const presetsBox = $<HTMLElement>('.changes-presets')
	const chipsBox = $<HTMLElement>('.changes-chips')
	const order = $<HTMLElement>('.changes-order')
	const summary = $<HTMLElement>('.changes-summary')

	let phase: Phase = 'idle'
	// Frozen at Start: a session runs on the settings it started with.
	let session = { mode: 'minute' as 'minute' | 'time', sequence: [] as string[], seconds: 60, beats: 4, bpm: 60, speedUp: false, countIn: true }
	let stabilizer = Changes.createStabilizer()
	let counter = Changes.createChangeCounter([])
	let goAt = 0
	let endsAt = 0
	let lastAnnounce = 0
	// In time.
	let slot = -1
	let marks: Changes.Mark[] = []
	let pending: { downbeat: number; slotMs: number; target: string }[] = []
	let onsets: Changes.Onset[] = []
	let clean = 0
	// A speed-up waits for the next chord's first beat, so a slot never changes tempo halfway.
	let pendingBpm = 0
	let clicking = false
	// performance.now() of the last click heard (Metronome.onBeat fires then).
	let lastClickAt = -Infinity
	const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
	// Readings arrive every frame while the mic runs and reset() runs when it stops.
	let micLive = false
	let wakeLock: WakeLockSentinel | null = null

	const selection = () => Settings.get().changesChords
	const valid = () => selection().length >= 2
	const isRunning = () => phase === 'countin' || phase === 'running'

	/* Chord diagrams ------------------------------------------------------- */
	let shapes: { symbol: string; figure: HTMLElement; board: Fretboard }[] = []
	let shapesKey = ''

	function renderShapes(sequence: string[]) {
		const key = sequence.join()
		if (key === shapesKey) return
		shapesKey = key
		for (const shape of shapes) shape.board.destroy()
		shapes = sequence.map((symbol) => {
			const rootName = symbol.match(/^[A-G][#b]?/)![0]
			const rootPc = PITCH_CLASSES.indexOf(rootName)
			const type = chordType(symbol.slice(rootName.length))!
			const figure = document.createElement('figure')
			figure.className = 'changes-shape'
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
			svg.classList.add('neck')
			const caption = document.createElement('figcaption')
			caption.textContent = symbol
			figure.append(svg, caption)
			// autoRender: redrawn when left-handed or the board theme changes.
			const board = createFretboard(svg, null, { autoRender: true })
			const voicing = chordShapes(rootPc, type, { limit: 1 })[0]
			// Three or four across a phone are too small for degree labels: plain dots.
			if (voicing) board.render(voicingSpec(voicing, rootPc, type, { fingers: false, labels: sequence.length > 2 ? 'none' : 'degrees' }))
			return { symbol, figure, board }
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

	for (const button of modeButtons) {
		button.addEventListener('click', () => Settings.update({ changesMode: button.dataset.changesMode as 'minute' | 'time' }))
	}

	function sparkline(history: number[], best: number): string {
		if (history.length < 2) return ''
		const w = 96
		const h = 24
		const top = Math.max(best, 1)
		const x = (i: number) => (i * (w - 4)) / (history.length - 1) + 2
		const y = (n: number) => h - 3 - (n / top) * (h - 6)
		const points = history.map((n, i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(' ')
		const last = history.length - 1
		return (
			`<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Last ${history.length} sessions: ${history.join(', ')}">` +
			`<line class="spark__best" x1="2" x2="${w - 2}" y1="${y(best)}" y2="${y(best)}"/>` +
			`<polyline class="spark__line" points="${points}"/>` +
			`<circle class="spark__dot" cx="${x(last)}" cy="${y(history[last])}" r="2.5"/></svg>`
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
				`<span>${s.changesBpm} BPM · ${s.changesBeats} ${s.changesBeats === 1 ? 'beat' : 'beats'} per chord${s.changesSpeedUp ? ' · speeds up' : ''}</span>` +
				'<span>Headphones work best: the mic can hear the clicks.</span>'
			return
		}
		const { best, history } = Changes.loadRecord(selection(), s.changesDuration)
		const length = s.changesDuration < 60 ? `${s.changesDuration} s` : `${s.changesDuration / 60} min`
		summary.innerHTML = history.length
			? `<span>Best <b>${best}</b> in ${length}</span>${sparkline(history, best)}`
			: `<span>No ${length} sessions of ${pairLabel(selection())} yet.</span>`
	}

	function renderSetup() {
		const s = Settings.get()
		const chords = selection()
		for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.changesMode === s.changesMode))
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
	function setTarget(symbol: string, then: string) {
		target.textContent = symbol
		target.classList.remove('changes-target--count')
		next.textContent = then
		markTargetShape(symbol)
	}

	function renderIdle() {
		const s = Settings.get()
		const chords = selection()
		stage.dataset.mode = s.changesMode
		strip.hidden = s.changesMode !== 'time'
		if (s.changesMode === 'time') {
			clock.textContent = `${s.changesBpm} BPM`
			countLabel.textContent = 'on time'
			countValue.textContent = '–'
		} else {
			clock.textContent = clockText(s.changesDuration * 1000)
			countLabel.textContent = 'changes'
			countValue.textContent = '0'
		}
		if (valid()) {
			renderShapes(chords)
			setTarget(chords[0], s.changesMode === 'time' ? `then ${chords[1]}` : `Start on ${chords[0]}, change to ${chords[1]}`)
		} else {
			renderShapes(chords)
			target.textContent = '–'
			next.textContent = ''
		}
		startButton.disabled = !valid()
	}

	function setRunningUi(running: boolean) {
		// done: the result takes the place of the clock, count and target.
		stage.dataset.phase = phase
		setup.hidden = running
		root.classList.toggle('trainer--running', running)
		startButton.textContent = running ? 'Stop' : phase === 'done' ? 'Start again' : 'Start'
		startButton.classList.toggle('btn--solid', !running)
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

	function announce(text: string, force = false) {
		const now = performance.now()
		if (!force && now - lastAnnounce < ANNOUNCE_MS) return
		lastAnnounce = now
		live.textContent = text
	}

	function renderStrip() {
		strip.replaceChildren(
			...marks.slice(-STRIP_MARKS).map((mark) => {
				const li = document.createElement('li')
				li.className = `changes-mark changes-mark--${mark}`
				li.textContent = MARK_GLYPH[mark]
				li.title = MARK_TEXT[mark]
				return li
			})
		)
		const hits = marks.filter((m) => m === 'hit').length
		strip.setAttribute('aria-label', `${hits} of ${marks.length} changes on time`)
	}

	/* Screen wake lock: a phone that sleeps mid-session stops the mic. ------- */
	async function holdScreen() {
		if (wakeLock && !wakeLock.released) return
		try {
			const lock = await navigator.wakeLock?.request('screen')
			if (!lock) return
			if (!isRunning()) return void lock.release()
			wakeLock = lock
		} catch {
			// Refused or unsupported: the drill still runs.
		}
	}

	function releaseScreen() {
		void wakeLock?.release()
		wakeLock = null
	}

	/* Run ------------------------------------------------------------------- */
	function start() {
		if (!valid()) return
		if (!micLive && fake === undefined) {
			status.textContent = 'The microphone is off. Press Listen, then Start.'
			document.getElementById('micButton')?.focus()
			return
		}
		const s = Settings.get()
		session = {
			mode: s.changesMode,
			sequence: [...selection()],
			seconds: s.changesDuration,
			beats: s.changesBeats,
			bpm: s.changesBpm,
			speedUp: s.changesSpeedUp,
			countIn: s.changesCountIn,
		}
		resetHeard()
		counter = Changes.createChangeCounter(session.sequence)
		marks = []
		pending = []
		onsets = []
		clean = 0
		pendingBpm = 0
		slot = -1
		lastAnnounce = 0
		result.hidden = true
		status.textContent = ''
		stage.dataset.mode = session.mode
		strip.hidden = session.mode !== 'time'
		renderStrip()
		const now = performance.now()

		if (session.mode === 'minute') {
			countValue.textContent = '0'
			countLabel.textContent = 'changes'
			clock.textContent = clockText(session.seconds * 1000)
			goAt = now + (session.countIn ? COUNT_IN_S * 1000 : 0)
			phase = session.countIn ? 'countin' : 'running'
			if (phase === 'running') begin(now)
			else announce(`Get ready on ${session.sequence[0]}`, true)
		} else {
			countValue.textContent = '–'
			countLabel.textContent = 'on time'
			clock.textContent = `${session.bpm} BPM`
			// Accent each chord's first beat; nothing else of the Metronome tab's setup applies.
			Metronome.configure({
				beats: session.beats,
				accents: [2, 1, 1, 1],
				subdivision: 1,
				sound: 'click',
				volume: Settings.get().metroVolume,
				trainer: { enabled: false, step: 0, bars: 1, target: 0 },
			})
			Metronome.setTempo(session.bpm)
			Metronome.start()
			clicking = true
			phase = session.countIn ? 'countin' : 'running'
			setTarget(session.sequence[0], `then ${session.sequence[1]}`)
			announce(`Play ${session.sequence[0]} on the first beat`, true)
		}
		setRunningUi(true)
		holdScreen()
	}

	/** One-minute: the clock starts; whatever is already ringing is the starting chord. */
	function begin(now: number) {
		phase = 'running'
		endsAt = now + session.seconds * 1000
		const ringing = stabilizer.current()
		if (ringing) counter.onChord({ symbol: ringing, at: now, fresh: true })
		showCounterTarget()
		announce('Go', true)
	}

	function showCounterTarget() {
		const from = counter.at
		setTarget(counter.target(), from ? `from ${from}` : `Strum ${session.sequence[0]} to start`)
	}

	/** Ends the session; `finished` = ran its course (stored), otherwise stopped. */
	function finish(finished: boolean, reason = '') {
		const wasTime = session.mode === 'time'
		if (clicking) Metronome.stop()
		clicking = false
		releaseScreen()
		phase = 'idle'
		if (!wasTime && finished) {
			const count = counter.count
			// Nothing heard (mic too far, wrong chords) is not a session worth a place in the history.
			const before = count ? Changes.saveSession(session.sequence, session.seconds, count) : Changes.loadRecord(session.sequence, session.seconds)
			const delta = count - before.best
			const verdict = !count
				? 'No changes heard, not saved'
				: !before.history.length
					? 'First session'
					: delta > 0
						? `New best, +${delta}`
						: delta === 0
							? 'Ties your best'
							: `${delta} from your best`
			showResult(String(count), count === 1 ? 'change' : 'changes', [verdict, `Best ${Math.max(before.best, count)}`])
			announce(`Time. ${count} changes. ${verdict}.`, true)
			status.textContent = ''
		} else if (wasTime && marks.length) {
			const pct = Changes.accuracy(marks)
			const n = (m: Changes.Mark) => marks.filter((x) => x === m).length
			showResult(`${pct}%`, 'on time', [
				`${n('hit')} of ${marks.length} changes`,
				`${n('late')} late · ${n('early')} early · ${n('miss')} missed`,
				`Ended at ${Metronome.getState().bpm || session.bpm} BPM`,
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
		phase = 'done'
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
	document.addEventListener('keydown', (event) => {
		if (root.hidden || stage.hidden || event.code !== 'Space' || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return
		if (event.target !== document.body) return
		event.preventDefault()
		startButton.click()
	})

	// Hidden page or locked screen: the mic and the timers stall, so no count
	// or mark from here on would mean anything. End it rather than pause it.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden && isRunning()) finish(false, 'Stopped: the page was hidden.')
	})

	/* In time: downbeats from the metronome ---------------------------------- */
	Metronome.onBeat((event) => {
		if (!clicking) return
		const now = performance.now()
		lastClickAt = now
		if (event.sub !== 0) return
		const lead = session.countIn ? COUNT_IN_BEATS : 0
		const beat = event.bar * session.beats + event.beat
		if (beat < lead) {
			target.textContent = String(lead - beat)
			target.classList.add('changes-target--count')
			next.textContent = `Get ready on ${session.sequence[0]}`
			return
		}
		phase = 'running'
		if ((beat - lead) % session.beats) return
		if (pendingBpm) {
			// Takes effect from the next beat line: this chord's first beat is already scheduled.
			Metronome.setTempo(pendingBpm)
			announce(`Two clean passes. Up to ${pendingBpm} BPM.`, true)
			pendingBpm = 0
		}
		slot = (beat - lead) / session.beats
		const seq = session.sequence
		const current = seq[slot % seq.length]
		setTarget(current, `then ${seq[(slot + 1) % seq.length]}`)
		clock.textContent = `${event.bpm} BPM`
		// The first chord is where the player starts, not a change.
		if (slot > 0) pending.push({ downbeat: now, slotMs: (session.beats * 60000) / event.bpm, target: current })
	})

	function judgeDue(now: number) {
		// A slot's window closes half a slot after its downbeat, but a chord that
		// started inside it is only confirmed (and backdated) up to
		// CONFIRM_MS later: wait for it.
		while (pending.length && now >= pending[0].downbeat + pending[0].slotMs / 2 + CONFIRM_MS) {
			const due = pending.shift()!
			const times = onsets.filter((o) => o.symbol === due.target).map((o) => o.at)
			const mark = Changes.judge(due.downbeat, due.slotMs, times)
			marks.push(mark)
			renderStrip()
			countValue.textContent = `${Changes.accuracy(marks)}%`
			if (mark === 'hit') flash()
			if (!session.speedUp) continue
			const step = Changes.afterMark(clean, mark, session.sequence.length)
			clean = step.clean
			const bpm = pendingBpm || Metronome.getState().bpm
			if (step.speedUp && bpm < Changes.MAX_BPM) pendingBpm = Math.min(Changes.MAX_BPM, bpm + Changes.SPEED_STEP)
		}
	}

	/* Per frame ----------------------------------------------------------------- */
	function frame() {
		const now = performance.now()
		const attack = strummed() && !(clicking && Math.abs(now - lastClickAt) <= CLICK_MASK_MS)
		const onset = stabilizer.feed(heardChord(now)?.symbol ?? null, now, attack)
		showHeard(stabilizer.current())
		if (session.mode === 'minute' && phase === 'countin') {
			if (now >= goAt) begin(now)
			else {
				target.textContent = String(Math.ceil((goAt - now) / 1000))
				target.classList.add('changes-target--count')
				next.textContent = `Get ready on ${session.sequence[0]}`
			}
		} else if (session.mode === 'minute' && phase === 'running') {
			if (onset) {
				const outcome = counter.onChord(onset)
				if (outcome) showCounterTarget()
				if (outcome === 'change') {
					countValue.textContent = String(counter.count)
					flash()
					announce(`${counter.count} ${counter.count === 1 ? 'change' : 'changes'}`)
				}
			}
			const left = endsAt - now
			clock.textContent = clockText(left)
			if (left <= 0) finish(true)
		} else if (session.mode === 'time' && isRunning()) {
			// Flips of a ringing chord (not fresh) are not changes here either.
			if (onset?.fresh) onsets.push({ ...onset, at: onset.at - RECOGNITION_LATENCY_MS })
			onsets = onsets.filter((o) => now - o.at < ONSET_KEEP_MS)
			judgeDue(now)
		}
	}

	// ?debug: window.pluckChanges.hear('G') feeds that chord as if strummed
	// (null = silence; hear('Am', false) = the recognizer flipping a ringing
	// chord), driving frames itself while the mic is off; .off() returns to the mic.
	// A timer, not rAF: rAF stalls in a hidden or embedded test pane.
	if (new URLSearchParams(location.search).has('debug')) {
		let loop = 0
		const tick = () => {
			loop = 0
			if (fake === undefined) return
			if (!micLive && !root.hidden) frame()
			loop = window.setTimeout(tick, 16)
		}
		;(window as unknown as { pluckChanges: object }).pluckChanges = {
			hear(symbol: string | null, strum = true) {
				fake = symbol
				fakeStrum = strum && symbol !== null
				if (!loop) tick()
			},
			off() {
				fake = undefined
			},
		}
	}

	Settings.subscribe(() => {
		if (Settings.get().trainerExercise !== 'changes' || isRunning()) return
		// A finished session's result stays on screen until the setup changes.
		if (phase === 'done') {
			phase = 'idle'
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
			stabilizer = Changes.createStabilizer()
			showHeard(null)
			if (isRunning()) finish(false, 'Stopped: the microphone went off.')
		},

		onReading() {
			micLive = true
			frame()
		},
	}
}
