import { centsBetween, getClosestNote } from '../../core/notes'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { nearestString, TUNINGS, tuningById, tuningStrings, type TuningString } from '../../music/tuning'
import type { PitchReading } from '../../core/microphone'
import type { View } from '../../ui/view'
import { liveRegion, subscribeVisible } from '../../ui/dom'
import { createReadout } from '../../ui/readout'

// The tuning select's first entry: no target strings, name whatever is played.
const CHROMATIC = 'chromatic'

export function createTunerView(root: HTMLElement): View {
	const readout = createReadout(root)
	const zones = root.querySelector<HTMLElement>('.meter__zones')!
	const stringsRow = root.querySelector<HTMLElement>('.strings')!
	const tuningSelect = root.querySelector<HTMLSelectElement>('.tuner-tuning')!
	const toleranceText = root.querySelector<HTMLElement>('.tuner-tolerance')!
	// Screen readers hear the note and whether it is in tune, never the
	// 60-per-second cents: the live region only changes when one of those does.
	const announce = liveRegion(root.querySelector<HTMLElement>('.tuner-live')!, { dedupe: true })

	let strings: TuningString[] = []
	let builtFor = ''
	// The chips are only reference tones: tap to hear a string. They never
	// follow what is played; the readout and needle do that.
	let chips: HTMLButtonElement[] = []
	// The string whose reference tone is playing, and when it ends.
	let refIndex: number | null = null
	let refTimer = 0

	/* Controls ------------------------------------------------------------ */
	// Picking a tuning means tuning to its strings: cents are read off the
	// nearest string however far it is (a drop-D low E reads against D, not as
	// "D#"). Chromatic names the nearest note of any pitch; its chips keep the
	// last tuning's strings as reference tones.
	tuningSelect.add(new Option('Chromatic', CHROMATIC))
	TUNINGS.forEach((tuning) => tuningSelect.add(new Option(tuning.name, tuning.id)))
	tuningSelect.addEventListener('change', () =>
		Settings.update(tuningSelect.value === CHROMATIC ? { tunerMode: 'chromatic' } : { tuning: tuningById(tuningSelect.value).id, tunerMode: 'guitar' })
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
			chip.setAttribute('aria-label', `${string.name}${string.octave}, hear reference tone`)
			chip.innerHTML = `<span class="string-chip__note">${string.name}<sub>${string.octave}</sub></span>`
			return chip
		})
		stringsRow.replaceChildren(...chips)
	}

	function syncChips() {
		chips.forEach((chip, i) => (chip.dataset.state = i === refIndex ? 'ref' : 'idle'))
	}

	/** Reflects settings: rebuilds the strings if the tuning or A4 moved. */
	function sync() {
		const { tuning, a4, tunerMode, tolerance } = Settings.get()
		const key = `${tuning}@${a4}`
		if (key !== builtFor) {
			builtFor = key
			// A reference tone still ringing is at the old pitch.
			const wasPlaying = refIndex !== null
			endReference()
			Sound.stopTone()
			build()
			if (wasPlaying) idle()
		}
		tuningSelect.value = tunerMode === 'chromatic' ? CHROMATIC : tuningById(tuning).id
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
		readout.show(`${string.name}${string.octave}`, `Reference · ${string.frequency.toFixed(1)} Hz`, 0, false)
		announce(`Playing ${string.name}${string.octave}`)
		syncChips()
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
		readout.idle('Play a note to begin')
		announce('')
		syncChips()
	}

	sync()
	// Hidden, onActivate syncs on the way back.
	subscribeVisible(root, sync)

	return {
		onActivate() {
			// A tone cut short by leaving the tab may still have its timer pending.
			endReference()
			sync()
			idle()
		},

		// Also runs on mic Stop, which must not cut a reference tone: it ends on
		// its own timer, and leaving the tab stops it (main.ts activate()).
		reset() {
			if (refIndex === null) idle()
		},

		onReading(reading: PitchReading | null) {
			// The reference tone (or any synth note) comes back through the mic.
			if (refIndex !== null || Sound.isRinging()) return

			if (!reading) {
				readout.idle('Listening…', false)
				announce('')
				syncChips()
				return
			}

			const { a4, tunerMode, tolerance } = Settings.get()
			const guitar = tunerMode === 'guitar'
			let label: string
			let cents: number
			let prefix = ''
			if (guitar) {
				// Cents off the string being tuned, however far: a drop-D low E
				// still reads against D until it gets there.
				const near = nearestString(reading.frequency, strings)
				const string = strings[near.index]
				label = `${string.name}${string.octave}`
				cents = near.cents
				prefix = `String ${strings.length - near.index} · `
			} else {
				const closest = getClosestNote(reading.frequency, a4)
				label = closest.note.split('/')[0]
				cents = centsBetween(reading.frequency, closest.frequency)
			}

			const inTune = Math.abs(cents) <= tolerance
			readout.show(label, `${prefix}${reading.frequency.toFixed(1)} Hz · ${cents > 0 ? '+' : ''}${Math.round(cents)} cents`, cents, inTune)
			announce(inTune ? `${label}, in tune` : label)
		},
	}
}
