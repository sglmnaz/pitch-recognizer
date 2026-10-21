import * as Game from '../../music/game'
import * as MusicRenderer from '../../ui/music-renderer'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { centsBetween, getClosestNote } from '../../core/notes'
import type { PitchReading } from '../../core/microphone'
import type { View } from '../../ui/view'
import { bindSegmented } from '../../ui/dom'
import { createReadout } from '../../ui/readout'
import { micNeedChanged } from '../../ui/mic-block'
import { createEarView } from './ear.view'
import { createChangesView } from './changes.view'
import { createTabView } from './tab.view'
import { noteName, noteSystem } from '../../music/note-names'
import { createScoreboard } from './led'

/**
 * Five exercises behind one segmented control: Notes (match the note on the
 * staff with the mic), the ear drills Intervals / Chords (ts/features/trainer/ear.view.ts),
 * Changes, chord-change drills played into the mic (ts/features/trainer/changes.view.ts),
 * and Tab, technique exercises on a moving tab strip (ts/features/trainer/tab.view.ts).
 * Switching exercises calls micNeedChanged(): Chords has no use for the mic.
 */
export function createTrainerView(root: HTMLElement): View {
	const staff = root.querySelector<HTMLElement>('#staff')!
	const promptHint = root.querySelector<HTMLElement>('.prompt__hint')!
	const promptNote = root.querySelector<HTMLElement>('.prompt__note')!
	const promptAlt = root.querySelector<HTMLElement>('.prompt__alt')!

	const readout = createReadout(root)

	const showScore = createScoreboard(root)

	const skipButton = root.querySelector<HTMLButtonElement>('[data-action="skip"]')!

	let started = false

	function applyStaffTheme() {
		// Force the staff to light mode on demand (data-mode), otherwise let it inherit
		// the app theme from the document root.
		if (Settings.get().lightStaff) {
			staff.dataset.mode = 'light'
		} else {
			delete staff.dataset.mode
		}
	}

	// First enharmonic spelling, in the chosen names, with the octave number
	// dropped while matching any octave (where the number would be misleading).
	function displayNote(name: string): string {
		const spelling = noteName(name.split('/')[0])
		return Settings.get().matchAnyOctave ? spelling.replace(/[0-9]/g, '') : spelling
	}

	function targetLabel(): string {
		return displayNote(Game.getState().target.note)
	}

	function showTarget() {
		const { target } = Game.getState()
		promptHint.textContent = Settings.get().matchAnyOctave ? 'Match this note (any octave)' : 'Match this note'
		promptNote.textContent = displayNote(target.note)
		// The other name under it: Do Re Mi under letters, letters under any other system.
		const other = noteSystem() === 'letters' ? target.altName : target.note.split('/')[0]
		promptAlt.textContent = Settings.get().matchAnyOctave ? other.replace(/[0-9]/g, '') : other
		MusicRenderer.render(target)
		applyStaffTheme()
	}

	const updateScoreboard = () => showScore(Game.getState())

	const clearReadout = (message: string) => readout.idle(message)

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

			readout.show(
				displayNote(closest.note),
				evaluation.onTarget ? 'Hold it steady…' : `Find ${targetLabel()}`,
				cents,
				evaluation.onTarget && Math.abs(cents) < 20
			)

			if (evaluation.solved) {
				advance()
			}
		},
	}

	/* Exercise switch ------------------------------------------------------ */
	const ear = createEarView(root)
	const changes = createChangesView(root)
	const tab = createTabView(root)
	const exercise = () => Settings.get().trainerExercise
	const kindOf = (ex: string) => (ex === 'notes' || ex === 'changes' || ex === 'tab' ? ex : 'ear')
	const active = () => ({ notes, ear, changes, tab })[kindOf(exercise())]

	function applyExercise() {
		const ex = exercise()
		const kind = kindOf(ex)
		showExercise(ex)
		root.classList.toggle('trainer--ear', kind === 'ear')
		root.classList.toggle('trainer--changes', kind === 'changes')
		root.classList.toggle('trainer--tab', kind === 'tab')
		for (const element of root.querySelectorAll<HTMLElement>('[data-only]')) element.hidden = !element.dataset.only!.split(' ').includes(kind)
	}

	let sing = Settings.get().earSing
	Settings.subscribe(() => {
		if (Settings.get().earSing === sing) return
		sing = Settings.get().earSing
		micNeedChanged()
	})

	const showExercise = bindSegmented(root.querySelector('.trainer-mode')!, 'data-exercise', (value) => {
		const ex = value as Settings.Settings['trainerExercise']
		if (ex === exercise()) return
		active().reset()
		// An interval or chord still playing belongs to the old exercise.
		Sound.stopAll()
		Settings.update({ trainerExercise: ex })
		applyExercise()
		micNeedChanged()
		active().onActivate()
	})

	return {
		onActivate() {
			applyExercise()
			active().onActivate()
		},
		reset: () => active().reset(),
		onReading: (reading) => active().onReading(reading),
		// Intervals only listen when sung answers are on; Changes and Tab always do.
		wantsMic: () => exercise() === 'notes' || exercise() === 'changes' || exercise() === 'tab' || (exercise() === 'intervals' && Settings.get().earSing),
	}
}
