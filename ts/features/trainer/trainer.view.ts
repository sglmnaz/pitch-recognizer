import * as Game from '../../music/game'
import * as MusicRenderer from '../../ui/music-renderer'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { centsBetween, getClosestNote } from '../../core/notes'
import type { PitchReading } from '../../core/microphone'
import type { View } from '../../ui/view'
import { createEarView } from './ear.view'
import { createChangesView } from './changes.view'

const CENTS_RANGE = 50

/**
 * Four exercises behind one segmented control: Notes (match the note on the
 * staff with the mic), the ear drills Intervals / Chords (ts/views/ear.ts) and
 * Changes, chord-change drills played into the mic (ts/views/changes.ts).
 * `onMicNeed` tells index.ts that wantsMic() changed: Chords has no use for it.
 */
export function createTrainerView(root: HTMLElement, onMicNeed: () => void): View {
	const staff = root.querySelector<HTMLElement>('#staff')!
	const promptHint = root.querySelector<HTMLElement>('.prompt__hint')!
	const promptNote = root.querySelector<HTMLElement>('.prompt__note')!
	const promptAlt = root.querySelector<HTMLElement>('.prompt__alt')!

	const readout = root.querySelector<HTMLElement>('.readout')!
	const detectedNote = root.querySelector<HTMLElement>('.readout__note')!
	const detectedSub = root.querySelector<HTMLElement>('.readout__sub')!
	const needle = root.querySelector<HTMLElement>('.meter__needle')!

	const scoreValue = root.querySelector<HTMLElement>('[data-stat="score"]')!
	const streakValue = root.querySelector<HTMLElement>('[data-stat="streak"]')!
	const bestValue = root.querySelector<HTMLElement>('[data-stat="best"]')!

	const skipButton = root.querySelector<HTMLButtonElement>('[data-action="skip"]')!

	let started = false

	function applyStaffTheme() {
		// Force the staff to the light palette on demand, otherwise let it inherit
		// the app theme from the document root.
		if (Settings.get().lightStaff) {
			staff.dataset.theme = 'light'
		} else {
			delete staff.dataset.theme
		}
	}

	// First enharmonic spelling, with the octave number dropped while matching
	// any octave (where the number would be misleading).
	function displayNote(name: string): string {
		const spelling = name.split('/')[0]
		return Settings.get().matchAnyOctave ? spelling.replace(/[0-9]/g, '') : spelling
	}

	function targetLabel(): string {
		return displayNote(Game.getState().target.note)
	}

	function showTarget() {
		const { target } = Game.getState()
		promptHint.textContent = Settings.get().matchAnyOctave ? 'Match this note (any octave)' : 'Match this note'
		promptNote.textContent = displayNote(target.note)
		promptAlt.textContent = displayNote(target.altName)
		MusicRenderer.render(target)
		applyStaffTheme()
	}

	function updateScoreboard() {
		const { score, streak, best } = Game.getState()
		scoreValue.textContent = String(score)
		streakValue.textContent = String(streak)
		bestValue.textContent = String(best)
	}

	function clearReadout(message: string) {
		detectedNote.textContent = '--'
		detectedNote.classList.add('readout__idle')
		detectedSub.textContent = message
		needle.style.left = '50%'
		readout.classList.remove('readout--locked')
	}

	function ensureStarted() {
		if (started) return
		Game.nextNote()
		showTarget()
		updateScoreboard()
		started = true
	}

	function advance() {
		updateScoreboard()
		Game.nextNote()
		showTarget()
		clearReadout('Nice — next note')
	}

	skipButton.addEventListener('click', () => {
		Game.skip()
		showTarget()
		updateScoreboard()
		clearReadout('Skipped')
	})

	// React to settings changes: keep the target valid against the new pool and
	// re-apply the staff theme. Only re-render the prompt when the target moved.
	// Only while Notes is on screen: an ear-training setting must not rebuild
	// VexFlow into a hidden staff. onActivate catches up on the way back.
	Settings.subscribe(() => {
		if (root.hidden) return
		applyStaffTheme()
		if (!started || Settings.get().trainerExercise !== 'notes') return
		const previous = Game.getState().target
		Game.revalidateTarget()
		showTarget()
		if (Game.getState().target !== previous) {
			clearReadout('Play the note shown above')
		}
	})

	const notes: View = {
		onActivate() {
			if (started) {
				Game.revalidateTarget()
				showTarget()
			}
			ensureStarted()
			updateScoreboard()
			applyStaffTheme()
			clearReadout('Play the note shown above')
		},

		reset() {
			clearReadout('Press Listen to start')
		},

		onReading(reading: PitchReading | null) {
			// The app's own notes (an ear drill's last playback) are not the player.
			if (Sound.isRinging()) reading = null
			ensureStarted()
			const evaluation = Game.evaluate(reading, performance.now())

			if (!reading || !evaluation.detected) {
				clearReadout(`Find ${targetLabel()}`)
				return
			}

			const closest = getClosestNote(reading.frequency, Settings.get().a4)
			const cents = centsBetween(reading.frequency, closest.frequency)

			detectedNote.classList.remove('readout__idle')
			detectedNote.textContent = displayNote(closest.note)
			detectedSub.textContent = evaluation.onTarget ? 'Hold it steady…' : `Find ${targetLabel()}`

			const clamped = Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, cents))
			needle.style.left = `${50 + (clamped / CENTS_RANGE) * 50}%`
			readout.classList.toggle('readout--locked', evaluation.onTarget && Math.abs(cents) < 20)

			if (evaluation.solved) {
				advance()
			}
		},
	}

	/* Exercise switch ------------------------------------------------------ */
	const ear = createEarView(root)
	const changes = createChangesView(root)
	const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.trainer-mode [data-exercise]'))
	const exercise = () => Settings.get().trainerExercise
	const kindOf = (ex: string) => (ex === 'notes' || ex === 'changes' ? ex : 'ear')
	const active = () => ({ notes, ear, changes })[kindOf(exercise())]

	function applyExercise() {
		const ex = exercise()
		const kind = kindOf(ex)
		for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.exercise === ex))
		root.classList.toggle('trainer--ear', kind === 'ear')
		root.classList.toggle('trainer--changes', kind === 'changes')
		for (const element of root.querySelectorAll<HTMLElement>('[data-only]')) element.hidden = !element.dataset.only!.split(' ').includes(kind)
	}

	let sing = Settings.get().earSing
	Settings.subscribe(() => {
		if (Settings.get().earSing === sing) return
		sing = Settings.get().earSing
		onMicNeed()
	})

	for (const button of modeButtons) {
		button.addEventListener('click', () => {
			const ex = button.dataset.exercise as Settings.Settings['trainerExercise']
			if (ex === exercise()) return
			active().reset()
			// An interval or chord still playing belongs to the old exercise.
			Sound.stopAll()
			Settings.update({ trainerExercise: ex })
			applyExercise()
			onMicNeed()
			active().onActivate()
		})
	}

	return {
		onActivate() {
			applyExercise()
			active().onActivate()
		},
		reset: () => active().reset(),
		onReading: (reading) => active().onReading(reading),
		// Intervals only listen when sung answers are on; Changes always does.
		wantsMic: () => exercise() === 'notes' || exercise() === 'changes' || (exercise() === 'intervals' && Settings.get().earSing),
	}
}
