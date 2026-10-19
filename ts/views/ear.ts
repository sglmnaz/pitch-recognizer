// Trainer → Intervals / Chords: the app plays (ts/sound.ts), the user names
// what it heard. Round logic lives in ts/ear.ts; this wires the DOM.
import * as Ear from '../ear'
import * as Settings from '../settings'
import * as Sound from '../sound'
import { HOLD_MS } from '../game'
import { getClosestNote, midiOfFrequency } from '../notes'
import type { PitchReading } from '../microphone'
import type { View } from './view'

// Long enough to see the green, short enough to keep the drill moving.
const AUTO_ADVANCE_MS = 700
// The weakest few are what to practise; the rest is noise on a phone.
const STATS_SHOWN = 6

const DIRECTION_TEXT: Record<Ear.Direction, string> = { up: 'Ascending', down: 'Descending', harmonic: 'Harmonic' }

// Extra time after a played note before the mic may take a sung answer.
const RING_MARGIN_MS = 500

export function createEarView(root: HTMLElement): View {
	const panel = root.querySelector<HTMLElement>('.ear')!
	const promptText = panel.querySelector<HTMLElement>('.ear__prompt')!
	const hint = panel.querySelector<HTMLElement>('.ear__hint')!
	const playButton = panel.querySelector<HTMLButtonElement>('[data-action="replay"]')!
	const playLabel = playButton.querySelector('span')!
	const answers = panel.querySelector<HTMLElement>('.ear__answers')!
	const feedback = panel.querySelector<HTMLElement>('.ear__feedback')!
	const nextButton = panel.querySelector<HTMLButtonElement>('[data-action="next"]')!
	const statsTotal = root.querySelector<HTMLElement>('.ear-stats__total')!
	const statsList = root.querySelector<HTMLElement>('.ear-stats__list')!
	const scoreValue = root.querySelector<HTMLElement>('[data-stat="score"]')!
	const streakValue = root.querySelector<HTMLElement>('[data-stat="streak"]')!
	const bestValue = root.querySelector<HTMLElement>('[data-stat="best"]')!

	// The exercise on screen (null until first shown); Settings may already say another.
	let shown: Ear.Exercise | null = null
	let answersKey = ''
	// Answers stay off until the question has been heard once.
	let played = false
	let autoTimer = 0
	// Sung answer: the note being held and since when.
	let hold: { midi: number; since: number } | null = null
	// Readings arrive every frame while the mic runs and reset() runs when it
	// stops, so this tracks whether a sung answer is possible at all.
	let micLive = false

	const exercise = () => Settings.get().trainerExercise as Ear.Exercise
	const enabled = () => (exercise() === 'intervals' ? Settings.get().earIntervals : Settings.get().earChords)
	const question = () => Ear.getSession(exercise()).question
	const buttons = () => Array.from(answers.querySelectorAll<HTMLButtonElement>('.ear-answer'))
	// Browsers hold audio until the page has had a gesture: never auto-play the
	// first question of a page that booted straight into the Trainer.
	const canAutoplay = () => navigator.userActivation?.hasBeenActive ?? false

	function renderAnswers() {
		const ex = exercise()
		const ids = Ear.pool(ex, enabled())
		const key = `${ex}:${ids.join()}`
		if (key === answersKey) return
		answersKey = key
		answers.dataset.exercise = ex
		answers.setAttribute('aria-label', ex === 'intervals' ? 'Intervals' : 'Chord qualities')
		answers.replaceChildren(
			...ids.map((id) => {
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'ear-answer'
				button.dataset.id = id
				const short = document.createElement('span')
				short.className = 'ear-answer__short'
				short.textContent = id
				const name = document.createElement('span')
				name.className = 'ear-answer__name'
				name.textContent = Ear.labelOf(ex, id)
				button.append(short, name)
				button.addEventListener('click', () => onAnswer(id))
				return button
			})
		)
		syncButtons()
	}

	function syncButtons() {
		const session = Ear.getSession(exercise())
		for (const button of buttons()) {
			button.disabled = !played
			if (!session.answered) delete button.dataset.state
		}
	}

	function updateScoreboard() {
		const { score, streak, best } = Ear.getSession(exercise())
		scoreValue.textContent = String(score)
		streakValue.textContent = String(streak)
		bestValue.textContent = String(best)
	}

	function renderStats() {
		const ex = exercise()
		const stats = Ear.weakest(ex)
		const right = stats.reduce((sum, s) => sum + s.right, 0)
		const total = stats.reduce((sum, s) => sum + s.total, 0)
		statsTotal.textContent = total ? `${right}/${total} · ${Math.round((100 * right) / total)}%` : ''
		if (!total) {
			const empty = document.createElement('li')
			empty.className = 'ear-stats__empty'
			empty.textContent = `Your weakest ${ex === 'intervals' ? 'intervals' : 'chords'} show up here.`
			statsList.replaceChildren(empty)
			return
		}
		statsList.replaceChildren(
			...stats.slice(0, STATS_SHOWN).map((stat) => {
				const share = stat.right / stat.total
				const row = document.createElement('li')
				row.className = 'ear-stat'
				row.title = Ear.labelOf(ex, stat.id)
				row.innerHTML = '<span class="ear-stat__id"></span><span class="ear-stat__bar"><span></span></span><span class="ear-stat__n"></span>'
				row.querySelector('.ear-stat__id')!.textContent = stat.id
				const bar = row.querySelector<HTMLElement>('.ear-stat__bar span')!
				bar.style.width = `${Math.max(4, share * 100)}%`
				bar.classList.toggle('ear-stat__fill--good', share >= 0.8)
				row.querySelector('.ear-stat__n')!.textContent = `${stat.right}/${stat.total}`
				row.setAttribute('aria-label', `${Ear.labelOf(ex, stat.id)}: ${stat.right} of ${stat.total} right`)
				return row
			})
		)
	}

	function showHint(text?: string) {
		const q = question()
		const prefix = q?.exercise === 'intervals' ? `${DIRECTION_TEXT[q.direction]}. ` : 'Strummed. '
		if (text) hint.textContent = text
		else if (!played) hint.textContent = `${prefix}Press Play to hear it.`
		else if (q?.exercise === 'intervals' && micLive && Settings.get().earSing) {
			hint.textContent = `${prefix}Tap the answer, or sing or play the ${q.direction === 'harmonic' ? 'upper' : 'second'} note.`
		} else hint.textContent = `${prefix}${q?.exercise === 'intervals' ? 'Tap the interval.' : 'Tap its quality.'}`
	}

	function showQuestion() {
		promptText.textContent = question()!.exercise === 'intervals' ? 'Which interval?' : 'Which chord?'
		playLabel.textContent = played ? 'Replay' : 'Play'
		showHint()
	}

	/** Plays the question, or what answer `id` would have sounded like on the same root. */
	function play(id?: string) {
		const q = question()
		if (!q) return
		const { notes, gain } = Ear.playback(q, id ?? q.id, Settings.get().earGap)
		// A replay replaces what is still sounding instead of stacking on it, and
		// the mic ignores the whole note (its tail could otherwise answer).
		Sound.stopAll()
		// The mic ignores each note for its whole length plus a margin: audio can
		// start late (a context just resumed, Bluetooth output) and the room rings on.
		for (const note of notes) Sound.play(note.midi, note.at, gain, Sound.NOTE_MS + RING_MARGIN_MS)
		hold = null
		if (!played) {
			played = true
			syncButtons()
			showQuestion()
		}
	}

	function startRound(autoplay: boolean) {
		clearTimeout(autoTimer)
		const ex = exercise()
		// Keep focus in the panel for keyboard users: the Next button is about to hide.
		const hadFocus = panel.contains(document.activeElement)
		Ear.next(ex, enabled(), Settings.get().earDirection)
		shown = ex
		played = false
		hold = null
		feedback.textContent = ''
		delete feedback.dataset.state
		nextButton.hidden = true
		renderAnswers()
		syncButtons()
		showQuestion()
		updateScoreboard()
		renderStats()
		if (autoplay) play()
		if (hadFocus) (played ? buttons()[0] : playButton).focus()
	}

	function onAnswer(id: string) {
		const ex = exercise()
		const q = question()
		if (!q) return
		// After the round is decided, a tap is a comparison: hear that answer.
		if (Ear.getSession(ex).answered) {
			play(id)
			return
		}
		const { correct } = Ear.answer(ex, id)
		for (const button of buttons()) {
			if (button.dataset.id === q.id) button.dataset.state = 'right'
			else if (button.dataset.id === id) button.dataset.state = 'wrong'
		}
		const name = Ear.labelOf(ex, q.id)
		feedback.textContent = correct
			? `Correct — ${name}`
			: `Not quite — it was ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}, not ${Ear.labelOf(ex, id)}. Tap any answer to hear it.`
		feedback.dataset.state = correct ? 'right' : 'wrong'
		nextButton.hidden = false
		updateScoreboard()
		renderStats()
		if (correct && Settings.get().earAutoAdvance) {
			autoTimer = window.setTimeout(() => {
				// The user may have left the tab or switched exercise meanwhile.
				if (!root.hidden && !panel.hidden && exercise() === ex) startRound(true)
			}, AUTO_ADVANCE_MS)
		} else {
			nextButton.focus()
		}
	}

	playButton.addEventListener('click', () => play())
	nextButton.addEventListener('click', () => startRound(true))

	// Space replays, Enter moves on (or replays while unanswered), only where
	// those keys do nothing else: not in a button, field or the settings.
	document.addEventListener('keydown', (event) => {
		if (root.hidden || panel.hidden || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return
		if (event.target !== document.body || (event.code !== 'Space' && event.key !== 'Enter')) return
		event.preventDefault()
		if (event.key === 'Enter' && Ear.getSession(exercise()).answered) startRound(true)
		else play()
	})

	// A settings change can take the asked answer out of the pool or change the
	// direction: ask afresh, without playing. Settings live on their own tab, so
	// this runs on coming back too (onActivate), not only on a live change.
	function syncToSettings() {
		if (shown === null || shown !== exercise()) return
		// A decided round keeps its right/wrong marks; the next round picks the
		// change up (startRound re-renders the answers).
		if (Ear.getSession(shown).answered) return
		renderAnswers()
		const q = question()
		const { earDirection } = Settings.get()
		const stale =
			!q ||
			!Ear.pool(shown, enabled()).includes(q.id) ||
			(shown === 'intervals' && earDirection !== 'mixed' && q.direction !== earDirection)
		if (stale) startRound(false)
	}
	Settings.subscribe(() => {
		if (!root.hidden) syncToSettings()
	})

	return {
		onActivate() {
			const ex = exercise()
			if (shown !== ex || !question()) {
				startRound(canAutoplay())
				return
			}
			renderAnswers()
			syncToSettings()
			updateScoreboard()
			renderStats()
		},

		reset() {
			clearTimeout(autoTimer)
			hold = null
			micLive = false
			showHint()
		},

		onReading(reading: PitchReading | null) {
			// Sung answers are opt-in: through the phone speaker the mic can hear the
			// question itself, so by default answers are taps only.
			if (!Settings.get().earSing) return
			if (!micLive) {
				micLive = true
				showHint()
			}
			const q = question()
			// Sung answers: intervals only, once heard, before answering, and never
			// while the speaker may still be what the mic hears.
			if (!reading || !q || q.exercise !== 'intervals' || !played || Ear.getSession('intervals').answered || Sound.isRinging()) {
				if (hold) {
					hold = null
					showHint()
				}
				return
			}
			const { a4 } = Settings.get()
			const midi = Math.round(midiOfFrequency(reading.frequency, a4))
			const now = performance.now()
			if (hold?.midi !== midi) {
				hold = { midi, since: now }
				showHint(`Hearing ${getClosestNote(reading.frequency, a4).note.split('/')[0]}…`)
				return
			}
			if (now - hold.since < HOLD_MS) return
			const id = Ear.intervalOfAnswer(q, midi, enabled())
			// The reference's pitch class, or an interval that is not a button, is
			// no answer (and not a wrong one); keep the hold so it is not re-judged
			// every HOLD_MS while it rings on.
			if (id) onAnswer(id)
			else hold.since = Infinity
		},
	}
}
