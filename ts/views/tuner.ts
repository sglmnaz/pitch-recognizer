import { centsBetween, getClosestNote } from '../notes'
import * as Settings from '../settings'
import * as Sound from '../sound'
import { nearestString, STANDARD, TUNINGS, tuningById, tuningStrings, type TuningString } from '../tuning'
import type { PitchReading } from '../microphone'
import type { View } from './view'

const CENTS_RANGE = 50
// In tune for this long before a string earns its check: a needle sweeping
// through zero while the peg turns must not count.
const LOCK_HOLD_MS = 500
// A checked string that is played again this far off is being retuned (or has
// drifted): take the check back.
const RETUNE_CENTS = 15
// Checks fade after a while: strings drift, and a new session starts fresh.
const TUNED_TTL_MS = 10 * 60 * 1000
// Chromatic mode names whatever you play, so a string chip only lights when
// the nearest note IS that string's note (within half a semitone).
const CHROMATIC_STRING_CENTS = 50

const CHECK =
	'<svg class="string-chip__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'

type ChipState = 'idle' | 'active' | 'locked' | 'ref'

export function createTunerView(root: HTMLElement): View {
	const readout = root.querySelector<HTMLElement>('.readout')!
	const note = root.querySelector<HTMLElement>('.readout__note')!
	const sub = root.querySelector<HTMLElement>('.readout__sub')!
	const needle = root.querySelector<HTMLElement>('.meter__needle')!
	const zones = root.querySelector<HTMLElement>('.meter__zones')!
	const stringsRow = root.querySelector<HTMLElement>('.strings')!
	const tuningSelect = root.querySelector<HTMLSelectElement>('.tuner-tuning')!
	const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tuner-mode]'))
	const toleranceText = root.querySelector<HTMLElement>('.tuner-tolerance')!
	const live = root.querySelector<HTMLElement>('.tuner-live')!

	let strings: TuningString[] = []
	let builtFor = ''
	let chips: HTMLButtonElement[] = []
	const shown: { state: ChipState; tuned: boolean }[] = []
	// String index -> when it was last confirmed in tune.
	const tuned = new Map<number, number>()
	let lockIndex = -1
	let lockSince = 0
	// The string whose reference tone is playing, and when it ends.
	let refIndex: number | null = null
	let refTimer = 0

	/* Controls ------------------------------------------------------------ */
	TUNINGS.forEach((tuning) => tuningSelect.add(new Option(tuning.name, tuning.id)))
	tuningSelect.addEventListener('change', () => {
		const tuning = tuningById(tuningSelect.value)
		const patch: Partial<Settings.Settings> = { tuning: tuning.id }
		// An alternate tuning is what Guitar mode is for: Chromatic would call
		// a drop-D string "D" but a half-step-down one "D#" with no sense of the
		// target. Standard leaves the user's mode alone.
		if (tuning !== STANDARD) patch.tunerMode = 'guitar'
		Settings.update(patch)
	})

	modeButtons.forEach((button) =>
		button.addEventListener('click', () => Settings.update({ tunerMode: button.dataset.tunerMode as Settings.Settings['tunerMode'] }))
	)

	stringsRow.addEventListener('click', (event) => {
		const chip = (event.target as Element).closest<HTMLButtonElement>('.string-chip')
		if (chip) playReference(chips.indexOf(chip))
	})

	/* Strings ------------------------------------------------------------- */
	// Rebuilt when the tuning or A4 changes; the per-frame work only flips
	// each chip's data-state.
	function build() {
		const { tuning, a4 } = Settings.get()
		strings = tuningStrings(tuningById(tuning), a4)
		chips = strings.map((string) => {
			const chip = document.createElement('button')
			chip.type = 'button'
			chip.className = 'string-chip'
			chip.dataset.state = 'idle'
			chip.setAttribute('aria-label', chipLabel(string, 'idle', false))
			chip.innerHTML = `<span class="string-chip__note">${string.name}<sub>${string.octave}</sub></span>${CHECK}`
			return chip
		})
		shown.length = 0
		strings.forEach(() => shown.push({ state: 'idle', tuned: false }))
		stringsRow.replaceChildren(...chips)
	}

	function syncChips(active: number, locked: boolean) {
		const now = performance.now()
		chips.forEach((chip, i) => {
			const at = tuned.get(i)
			if (at !== undefined && now - at > TUNED_TTL_MS) tuned.delete(i)
			const state: ChipState = i === refIndex ? 'ref' : i === active ? (locked ? 'locked' : 'active') : 'idle'
			const done = tuned.has(i)
			// Writes only on change: this runs every frame.
			const changed = shown[i].state !== state || shown[i].tuned !== done
			if (shown[i].state !== state) chip.dataset.state = shown[i].state = state
			if (shown[i].tuned !== done) {
				shown[i].tuned = done
				chip.toggleAttribute('data-tuned', done)
			}
			// The check icon is decorative: the state goes in the name.
			if (changed) chip.setAttribute('aria-label', chipLabel(strings[i], state, done))
		})
	}

	function chipLabel(string: TuningString, state: ChipState, done: boolean) {
		const status = state === 'ref' ? 'playing' : state === 'locked' ? 'in tune' : done ? 'tuned' : state === 'active' ? 'being played' : ''
		return `${string.name}${string.octave}, hear reference tone${status ? `, ${status}` : ''}`
	}

	// Screen readers hear the note and whether it is in tune, never the
	// 60-per-second cents: the live region only changes when one of those does.
	let announced = ''
	function announce(text: string) {
		if (text === announced) return
		announced = text
		live.textContent = text
	}

	/** Reflects settings: rebuilds the strings if the tuning or A4 moved. */
	function sync() {
		const { tuning, a4, tunerMode, tolerance } = Settings.get()
		const key = `${tuning}@${a4}`
		if (key !== builtFor) {
			builtFor = key
			// New targets: yesterday's checks no longer mean anything, and a
			// reference tone still ringing is at the old pitch.
			tuned.clear()
			const wasPlaying = refIndex !== null
			endReference()
			Sound.stopTone()
			build()
			if (wasPlaying) idle()
		}
		tuningSelect.value = tuningById(tuning).id
		modeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tunerMode === tunerMode)))
		// The meter's green band follows the tolerance (1 cent = 1% of the track).
		zones.style.setProperty('--tol', String(tolerance))
		toleranceText.textContent = String(tolerance)
	}

	/* Reference tone ------------------------------------------------------ */
	function playReference(index: number) {
		const string = strings[index]
		clearTimeout(refTimer)
		const ms = Sound.playTone(string.frequency, Settings.get().toneVolume)
		refIndex = index
		note.classList.remove('readout__idle')
		note.textContent = `${string.name}${string.octave}`
		sub.textContent = `Reference · ${string.frequency.toFixed(1)} Hz`
		announce(`Playing ${string.name}${string.octave}`)
		needle.style.left = '50%'
		readout.classList.remove('readout--locked')
		syncChips(-1, false)
		// While it rings the mic hears the speaker, not the guitar: readings
		// are ignored until it has died away.
		refTimer = window.setTimeout(() => {
			endReference()
			idle()
		}, ms)
	}

	function endReference() {
		clearTimeout(refTimer)
		refIndex = null
	}

	/* Readout ------------------------------------------------------------- */
	function idle() {
		note.textContent = '--'
		note.classList.add('readout__idle')
		sub.textContent = 'Play a note to begin'
		announce('')
		needle.style.left = '50%'
		readout.classList.remove('readout--locked')
		lockIndex = -1
		syncChips(-1, false)
	}

	// Strings earn a check by holding in tune, and lose it when played far off.
	function trackTuned(active: number, cents: number, locked: boolean, now: number) {
		if (active < 0) {
			lockIndex = -1
			return
		}
		if (Math.abs(cents) > RETUNE_CENTS) tuned.delete(active)
		if (!locked) {
			lockIndex = -1
		} else if (lockIndex !== active) {
			lockIndex = active
			lockSince = now
		} else if (now - lockSince >= LOCK_HOLD_MS) {
			tuned.set(active, now)
		}
	}

	sync()
	Settings.subscribe(sync)

	return {
		onActivate() {
			sync()
			idle()
		},

		reset() {
			endReference()
			Sound.stopTone()
			idle()
		},

		onReading(reading: PitchReading | null) {
			// The reference tone (or any synth note) comes back through the mic.
			if (refIndex !== null || Sound.isRinging()) return

			if (!reading) {
				note.textContent = '--'
				note.classList.add('readout__idle')
				sub.textContent = 'Listening…'
				announce('')
				readout.classList.remove('readout--locked')
				lockIndex = -1
				syncChips(-1, false)
				return
			}

			const { a4, tunerMode, tolerance } = Settings.get()
			const guitar = tunerMode === 'guitar'
			const near = nearestString(reading.frequency, strings)
			let label: string
			let cents: number
			let prefix = ''
			if (guitar) {
				// Cents off the string being tuned, however far: a drop-D low E
				// still reads against D until it gets there.
				const string = strings[near.index]
				label = `${string.name}${string.octave}`
				cents = near.cents
				prefix = `String ${strings.length - near.index} · `
			} else {
				const closest = getClosestNote(reading.frequency, a4)
				label = closest.note.split('/')[0]
				cents = centsBetween(reading.frequency, closest.frequency)
			}

			const active = guitar || Math.abs(near.cents) <= CHROMATIC_STRING_CENTS ? near.index : -1
			const stringLocked = active >= 0 && Math.abs(near.cents) <= tolerance
			trackTuned(active, near.cents, stringLocked, performance.now())
			syncChips(active, stringLocked)

			note.classList.remove('readout__idle')
			note.textContent = label
			sub.textContent = `${prefix}${reading.frequency.toFixed(1)} Hz · ${cents > 0 ? '+' : ''}${Math.round(cents)} cents`

			const clamped = Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, cents))
			needle.style.left = `${50 + (clamped / CENTS_RANGE) * 50}%`

			const inTune = Math.abs(cents) <= tolerance
			readout.classList.toggle('readout--locked', inTune)
			announce(inTune ? `${label}, in tune` : label)
		},
	}
}
