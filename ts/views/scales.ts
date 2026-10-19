import { createFretboard, type Dot } from '../fretboard'
import { createHarmony } from './harmony'
import * as Settings from '../settings'
import * as Sound from '../sound'
import { midiOfFrequency } from '../notes'
import {
	degreeMap,
	degreeNumber,
	degreesOf,
	FRETS,
	identifyScales,
	midiAt,
	pitchClassOf,
	positionRun,
	positionWindows,
	ROOTS,
	SCALE_TYPES,
	scaleRun,
	scaleTitle,
	spellScale,
	STRINGS,
	type ScaleType,
} from '../scales'
import type { View } from './view'

// ponytail: results capped; a couple of marked notes already narrow it to a
// screenful, add paging if someone wants to browse all ~150 for a single note.
const MAX_RESULTS = 30
// Play scale: one note every STEP_MS, about eighth notes at 136 bpm.
const STEP_MS = 220
// A played note must hold this long before "Add notes by playing" marks it,
// so the attack's wobble and a neighbouring string do not get marked.
const ADD_HOLD_MS = 200

type Mode = 'explore' | 'identify'
type Shown = { rootPc: number; type: ScaleType }
export type MicState = 'off' | 'waiting' | 'listening' | 'blocked'

/** The mic is owned by index.ts; the view only asks for it and shows its state. */
export interface MicControl {
	state(): MicState
	listen(on: boolean): void
}

export function createScalesView(root: HTMLElement, mic: MicControl): View & { syncMic(): void } {
	const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!
	const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-mode]'))
	const explorePickers = $<HTMLElement>('.scales-explore')
	const identifyPickers = $<HTMLElement>('.scales-identify')
	const rootSelect = $<HTMLSelectElement>('.scales-root')
	const typeSelect = $<HTMLSelectElement>('.scales-type')
	const markedText = $<HTMLElement>('.scales-marked')
	const clearButton = $<HTMLButtonElement>('[data-action="clear"]')
	const infoTitle = $<HTMLElement>('.scale-info__title')
	const strip = $<HTMLElement>('.scale-info__notes')
	const card = $<HTMLElement>('.neck-card')
	const board = $<HTMLElement>('.neck-board')
	const tabBar = document.querySelector<HTMLElement>('.tabs')!
	const neck = $<SVGSVGElement>('.neck')
	const playButton = $<HTMLButtonElement>('[data-action="play"]')
	const playLabel = playButton.querySelector('span')!
	const displayButton = $<HTMLButtonElement>('[data-action="display"]')
	const displayMenu = $<HTMLElement>('.display__menu')
	const labelButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-labels]'))
	const positionRow = $<HTMLElement>('.scales-positions')
	const positionChip = $<HTMLButtonElement>('.position-chip')
	const micButton = $<HTMLButtonElement>('[data-action="mic"]')
	const micLabel = $<HTMLElement>('.mic-toggle__label')
	const hint = $<HTMLElement>('.neck-hint')
	const results = $<HTMLElement>('.scale-results')
	const phone = matchMedia('(max-width: 600px)')
	const legend = $<HTMLElement>('.neck-legend')
	const legendRoot = $<HTMLElement>('.neck-legend__root')
	const legendTone = $<HTMLElement>('.neck-legend__tone')

	let mode: Mode = 'explore'
	let rootPc = 0
	let typeIndex = 0
	let position = 0 // 0 = whole neck, 1–5 = box
	// Marked cells as "string-fret"; several frets may share a pitch class.
	const marked = new Set<string>()
	let selected: Shown | null = null
	let addByEar = false
	let heardMidi: number | null = null
	let heardSince = 0
	let addedMidi: number | null = null
	let playingMidi: number | null = null
	let playTimer = 0
	const fretboard = createFretboard(neck, board, { onTap, fill: screenHeight })
	const harmony = createHarmony(root, {
		redraw: render,
		setScale(pc, type) {
			mode = 'explore'
			rootPc = pc
			typeIndex = SCALE_TYPES.indexOf(type)
			stopPlaying()
			render()
		},
		stopScale,
	})

	/* Static controls ----------------------------------------------------- */
	ROOTS.forEach((name, pc) => rootSelect.add(new Option(name, String(pc))))
	rootSelect.addEventListener('change', () => {
		rootPc = Number(rootSelect.value)
		stopPlaying()
		render()
	})

	SCALE_TYPES.forEach((type, i) => typeSelect.add(new Option(type.aka ? `${type.name} (${type.aka})` : type.name, String(i))))
	typeSelect.addEventListener('change', () => {
		typeIndex = Number(typeSelect.value)
		stopPlaying()
		render()
	})

	const positionButtons = ['Neck', '1', '2', '3', '4', '5'].map((label, k) => {
		const button = document.createElement('button')
		button.type = 'button'
		button.textContent = label
		button.setAttribute('aria-label', k ? `Position ${k}` : 'Whole neck')
		button.addEventListener('click', () => setPosition(k))
		positionRow.append(button)
		return button
	})
	positionChip.addEventListener('click', () => setPosition(0))

	function setPosition(k: number) {
		position = k
		stopPlaying()
		render()
		// The box may sit off-screen: down the page (vertical neck) or sideways
		// in the scrolling board (horizontal on a phone): bring it into view.
		fretboard.revealBox()
	}

	labelButtons.forEach((button) =>
		button.addEventListener('click', () => Settings.update({ scaleLabels: button.dataset.labels as Settings.Settings['scaleLabels'] }))
	)

	function setMenuOpen(open: boolean) {
		displayMenu.hidden = !open
		displayButton.setAttribute('aria-expanded', String(open))
	}
	displayButton.addEventListener('click', (event) => {
		event.stopPropagation()
		setMenuOpen(displayMenu.hidden)
	})
	document.addEventListener('click', (event) => {
		if (!displayMenu.hidden && !displayMenu.contains(event.target as Node)) setMenuOpen(false)
	})
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') setMenuOpen(false)
	})

	modeButtons.forEach((button) =>
		button.addEventListener('click', () => {
			mode = button.dataset.mode as Mode
			stopPlaying()
			Sound.stopAll()
			render()
		})
	)

	clearButton.addEventListener('click', () => {
		marked.clear()
		selected = null
		render()
	})

	playButton.addEventListener('click', () => (playTimer ? stopPlaying() : playScale()))

	// Explore: the toggle is the mic itself. Identify: it adds notes by ear,
	// turning the mic on if needed (and leaves it on when switched off).
	micButton.addEventListener('click', () => {
		const listening = mic.state() === 'listening'
		if (mode === 'explore') {
			if (listening) clearHeard()
			return mic.listen(!listening)
		}
		addByEar = !(addByEar && listening)
		if (addByEar && !listening) mic.listen(true)
		syncMic()
	})

	// Taps (and Enter/Space on a focused note) play the note; in Identify they
	// also toggle the mark.
	function onTap(string: number, fret: number, midi: number) {
		Sound.play(midi)
		if (mode !== 'identify') return
		const key = `${string}-${fret}`
		if (marked.has(key)) marked.delete(key)
		else marked.add(key)
		render()
	}

	// Hidden, nothing to draw: onActivate renders on the way back. The phone
	// neck is sized from the board's width: redraw when that changes too.
	const redraw = () => {
		if (!root.hidden) render()
	}
	Settings.subscribe(redraw)
	phone.addEventListener('change', redraw)
	window.addEventListener('resize', redraw)

	/* Mic toggle ---------------------------------------------------------- */
	function syncMic() {
		const state = mic.state()
		const listening = state === 'listening'
		const on = mode === 'explore' ? listening : addByEar && listening
		micLabel.textContent = mode === 'explore' ? 'Listen' : 'Play to mark'
		micButton.title =
			mode === 'explore' ? 'Light up the notes you play on the guitar' : 'Mark the notes you play on the guitar'
		micButton.setAttribute('aria-pressed', String(on))
		micButton.classList.toggle('mic-toggle--live', listening)
		const text =
			state === 'blocked'
				? 'The browser is blocking the microphone. Allow it in the site settings to use this.'
				: state === 'waiting' && (on || mode === 'explore')
					? 'Tap anywhere to start the microphone.'
					: ''
		hint.textContent = text
		const hintChanged = hint.hidden !== !text
		hint.hidden = !text
		// The hint takes height from a vertical neck that fills the screen.
		if (hintChanged && Settings.get().fretboardVertical && !root.hidden) render()
	}

	// Height a vertical neck's frets 0–15 fill, so fret 15 ends exactly where
	// the screen does with the toolbar (and hint) above the board in view: the
	// screen height minus those controls, the board's top padding, and the
	// docked tab bar on phones, or on wider screens everything above the neck
	// block (top bar). Frets 16–22, the board's bottom and the legend follow
	// below the fold.
	function screenHeight() {
		const cardBox = card.getBoundingClientRect()
		const above = board.getBoundingClientRect().top - cardBox.top + parseFloat(getComputedStyle(board).paddingTop)
		const reserve = phone.matches ? tabBar.offsetHeight + 4 : cardBox.top + scrollY + 16
		return Math.max(300, innerHeight - reserve - above)
	}

	/* Playback ------------------------------------------------------------ */
	/** Stops Play scale and any progression. */
	function stopPlaying() {
		harmony.stop()
		stopScale()
	}

	function stopScale() {
		clearTimeout(playTimer)
		playTimer = 0
		playingMidi = null
		playLabel.textContent = 'Play scale'
		playButton.title = 'Play scale'
		applyLit()
	}

	function playScale() {
		const shown = shownScale()
		if (!shown) return
		harmony.stop(true)
		const midis = position
			? positionRun(shown.rootPc, shown.type, positionWindows(shown.rootPc, shown.type)[position - 1])
			: scaleRun(shown.rootPc, shown.type)
		let step = 0
		const tick = () => {
			if (step >= midis.length) return stopPlaying()
			playingMidi = midis[step++]
			Sound.play(playingMidi)
			applyLit()
			playTimer = window.setTimeout(tick, STEP_MS)
		}
		playLabel.textContent = 'Stop'
		playButton.title = 'Stop'
		tick()
	}

	/** Forgets the note heard from the mic (it stopped, or the tab is left). */
	function clearHeard() {
		heardMidi = null
		addedMidi = null
		applyLit()
	}

	// The note being played back lights inside the box only; the note heard
	// from the mic lights everywhere it can be played.
	const applyLit = () => fretboard.light(heardMidi, playingMidi)

	/* Rendering ----------------------------------------------------------- */
	const shownScale = (): Shown | null => (mode === 'identify' ? selected : { rootPc, type: SCALE_TYPES[typeIndex] })
	const markedMidis = () =>
		[...marked].map((key) => {
			const [s, f] = key.split('-').map(Number)
			return midiAt(s, f)
		})

	function renderStrip(shown: Shown, highlighted: (degree: string) => boolean) {
		const spelled = spellScale(ROOTS[shown.rootPc], shown.type)
		infoTitle.textContent = scaleTitle(spelled.root, shown.type)
		strip.replaceChildren(
			...degreesOf(shown.type).map((degree, i) => {
				const chip = document.createElement('button')
				chip.type = 'button'
				chip.className = 'scale-note'
				const on = highlighted(degree)
				chip.setAttribute('aria-pressed', String(on))
				if (on) chip.classList.add(i === 0 ? 'scale-note--root' : 'scale-note--tone')
				chip.title = on ? 'Tap to stop colouring this degree' : 'Tap to colour this degree on the neck'
				const note = document.createElement('span')
				note.className = 'scale-note__name'
				note.textContent = spelled.notes[i]
				const deg = document.createElement('span')
				deg.className = 'scale-note__degree'
				deg.textContent = degree
				chip.append(note, deg)
				chip.addEventListener('click', () => {
					const n = degreeNumber(degree)
					const degrees = new Set(Settings.get().scaleDegrees)
					if (degrees.has(n)) degrees.delete(n)
					else degrees.add(n)
					Settings.update({ scaleDegrees: [...degrees].sort() })
				})
				return chip
			})
		)
		return spelled
	}

	function renderResults(matches: ReturnType<typeof identifyScales>) {
		results.replaceChildren()
		if (marked.size === 0) return
		for (const match of matches.slice(0, MAX_RESULTS)) {
			const isSelected = selected?.rootPc === match.rootPc && selected.type === match.type
			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'scale-result'
			button.setAttribute('aria-pressed', String(isSelected))
			const title = document.createElement('span')
			title.className = 'scale-result__title'
			title.textContent = scaleTitle(match.root, match.type)
			const notes = document.createElement('span')
			notes.className = 'scale-result__notes'
			notes.textContent = match.notes.join(' ')
			const extra = document.createElement('span')
			extra.className = 'scale-result__extra'
			extra.textContent = match.extra === 0 ? 'exact' : `+${match.extra}`
			button.append(title, extra, notes)
			button.addEventListener('click', () => {
				selected = isSelected ? null : { rootPc: match.rootPc, type: match.type }
				stopPlaying()
				render()
				if (selected) board.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
			})
			const item = document.createElement('li')
			item.append(button)
			results.append(item)
		}
		if (matches.length > MAX_RESULTS) {
			const more = document.createElement('li')
			more.className = 'scale-results__more'
			more.textContent = `${matches.length - MAX_RESULTS} more — mark more notes to narrow it down`
			results.append(more)
		}
	}

	// A chord from the harmony section (tapped, or the bar of a progression
	// playing): its tones in the root / tone colours, labelled with chord
	// degrees, the rest of the scale dimmed; chord notes outside the scale
	// (the V of a minor key, a blues 7th) join the neck.
	function drawNeck(shown: Shown | null, names: Map<number, string>, highlighted: (degree: string) => boolean) {
		const { scaleLabels } = Settings.get()
		const degrees = shown ? degreeMap(shown.rootPc, shown.type) : new Map<number, string>()
		const chord = harmony.chord()
		const chordDegrees = new Map(chord ? degreesOf(chord.type).map((d, i) => [pitchClassOf(chord.notes[i]), d]) : [])
		chord?.notes.forEach((n) => names.has(pitchClassOf(n)) || names.set(pitchClassOf(n), n))
		const name = (midi: number) => names.get(midi % 12) ?? ROOTS[midi % 12]
		const dots: Dot[] = []
		STRINGS.forEach((_, string) => {
			for (let fret = 0; fret <= FRETS; fret++) {
				const midi = midiAt(string, fret)
				const isMarked = mode === 'identify' && marked.has(`${string}-${fret}`)
				const inChord = chordDegrees.get(midi % 12)
				const degree = chord ? (inChord ?? degrees.get(midi % 12)) : degrees.get(midi % 12)
				if (!degree && !isMarked) continue
				const role = chord
					? !inChord ? 'note' : inChord === '1' ? 'root' : 'tone'
					: !degree ? 'marked' : !highlighted(degree) ? 'note' : degree === '1' ? 'root' : 'tone'
				const label = scaleLabels === 'none' ? '' : scaleLabels === 'intervals' && degree ? degree : name(midi)
				dots.push({ string, fret, role, label, detail: degree, marked: isMarked, dimmed: Boolean(chord && !inChord) })
			}
		})
		fretboard.render({
			dots,
			noteName: name,
			emptyLabels: scaleLabels !== 'none',
			box: shown && position ? positionWindows(shown.rootPc, shown.type)[position - 1] : null,
			toggles: mode === 'identify',
		})
	}

	const ORDINALS = ['', 'root', '2nd', '3rd', '4th', '5th', '6th', '7th']

	// Names the coloured degrees the shown scale actually has, e.g. "3rd and 5th".
	function renderLegend(shown: Shown | null, scaleDegrees: number[]) {
		legend.hidden = !shown
		if (!shown) return
		const chord = harmony.chord()
		legendRoot.textContent = chord ? `${chord.symbol} root` : 'root'
		if (chord) {
			legendRoot.hidden = legendTone.hidden = false
			legendTone.textContent = 'chord tones'
			return
		}
		const present = new Set(degreesOf(shown.type).map(degreeNumber))
		const tones = scaleDegrees.filter((n) => n > 1 && present.has(n)).map((n) => ORDINALS[n])
		legendRoot.hidden = !scaleDegrees.includes(1)
		legendTone.hidden = tones.length === 0
		legendTone.textContent = tones.length > 1 ? `${tones.slice(0, -1).join(', ')} and ${tones.at(-1)}` : (tones[0] ?? '')
	}

	function render() {
		const { scaleDegrees, scaleLabels } = Settings.get()
		const identify = mode === 'identify'
		modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)))
		explorePickers.hidden = identify
		identifyPickers.hidden = !identify
		rootSelect.value = String(rootPc)
		typeSelect.value = String(typeIndex)
		labelButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.labels === scaleLabels)))
		positionButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === position)))

		// Marked notes, lowest pitch first; the lowest is the likely root.
		const markedSorted = markedMidis().sort((a, b) => a - b)
		const markedPcs = new Set(markedSorted.map((midi) => midi % 12))
		const matches = identify ? identifyScales(markedPcs, markedSorted.length ? markedSorted[0] % 12 : undefined) : []
		if (selected && !matches.some((m) => m.rootPc === selected!.rootPc && m.type === selected!.type)) selected = null

		const shown = shownScale()
		const highlighted = (degree: string) => scaleDegrees.includes(degreeNumber(degree))
		// The pickers already name the scale in Explore; Identify needs the title.
		infoTitle.hidden = !(identify && shown)
		strip.hidden = !shown
		playButton.disabled = !shown
		positionChip.hidden = !(shown && position)
		// "Pos 5 ×" on narrow phones (CSS hides the "ition"), so the toolbar fits.
		positionChip.innerHTML = `Pos<span>ition</span> ${position} ×`
		const names = new Map<number, string>()
		if (shown) renderStrip(shown, highlighted).notes.forEach((n) => names.set(pitchClassOf(n), n))
		else stopPlaying()

		markedText.textContent = markedPcs.size
			? [...markedPcs].map((pc) => names.get(pc) ?? ROOTS[pc]).join(' ')
			: 'Tap the neck to mark notes'
		markedText.classList.toggle('scales-marked--empty', markedPcs.size === 0)
		clearButton.disabled = marked.size === 0

		syncMic()
		harmony.render({ mode, rootPc, type: SCALE_TYPES[typeIndex], marked: markedSorted })
		renderLegend(shown, scaleDegrees)
		drawNeck(shown, names, highlighted)
		renderResults(matches)
	}

	return {
		onActivate: render,
		syncMic,

		reset() {
			stopPlaying()
			setMenuOpen(false)
			clearHeard()
		},

		onReading(reading) {
			// The synth's own notes come back through the mic: ignore them, and
			// everything while a progression plays (its rests too).
			const midi = reading && !Sound.isRinging() && !harmony.playing() ? Math.round(midiOfFrequency(reading.frequency, Settings.get().a4)) : null
			const now = performance.now()
			if (midi !== heardMidi) {
				heardMidi = midi
				heardSince = now
				applyLit()
			}
			if (midi === null) {
				addedMidi = null
				return
			}
			if (mode !== 'identify' || !addByEar || midi === addedMidi || now - heardSince < ADD_HOLD_MS) return
			addedMidi = midi
			// Mark it once, on the lowest fret it can be played, unless that pitch
			// class is marked already (the identifier works on pitch classes).
			if (markedMidis().some((m) => m % 12 === midi % 12)) return
			for (let fret = 0; fret <= FRETS; fret++) {
				const s = STRINGS.findIndex((open) => open + fret === midi)
				if (s >= 0) {
					marked.add(`${s}-${fret}`)
					render()
					return
				}
			}
		},
	}
}
