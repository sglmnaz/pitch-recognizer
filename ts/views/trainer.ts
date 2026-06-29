import * as Game from '../game'
import * as MusicRenderer from '../music-renderer'
import * as Settings from '../settings'
import { centsBetween, getClosestNote } from '../notes'
import type { PitchReading } from '../microphone'
import type { View } from './view'

const CENTS_RANGE = 50

export function createTrainerView(root: HTMLElement): View {
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
	Settings.subscribe(() => {
		applyStaffTheme()
		if (!started) return
		const previous = Game.getState().target
		Game.revalidateTarget()
		showTarget()
		if (Game.getState().target !== previous) {
			clearReadout('Play the note shown above')
		}
	})

	return {
		onActivate() {
			ensureStarted()
			applyStaffTheme()
			clearReadout('Play the note shown above')
		},

		reset() {
			clearReadout('Press Listen to start')
		},

		onReading(reading: PitchReading | null) {
			ensureStarted()
			const evaluation = Game.evaluate(reading, performance.now())

			if (!reading || !evaluation.detected) {
				clearReadout(`Find ${targetLabel()}`)
				return
			}

			const closest = getClosestNote(reading.frequency)
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
}
