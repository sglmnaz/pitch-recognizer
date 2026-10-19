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
	STRING_NAMES,
	STRINGS,
	type ScaleType,
} from '../scales'
import type { View } from './view'

const INLAYS = [3, 5, 7, 9, 12, 15, 17, 19, 21]
// ponytail: results capped; a couple of marked notes already narrow it to a
// screenful, add paging if someone wants to browse all ~150 for a single note.
const MAX_RESULTS = 30
// Play scale: one note every STEP_MS, about eighth notes at 136 bpm.
const STEP_MS = 220
// A played note must hold this long before "Add notes by playing" marks it,
// so the attack's wobble and a neighbouring string do not get marked.
const ADD_HOLD_MS = 200

/* Neck geometry (SVG user units ≈ CSS px on a desktop) -------------------- */
// Frets sit where a real guitar puts them: fret n at scale × (1 − 2^(−n/12)),
// so they narrow up the neck. Along = distance from the open-string column,
// across = string index (0 = high E). Horizontal draws along → x, high E on
// top like tab; vertical draws along → y, low E on the left like a chord
// diagram. 820 units over 22 frets leave fret 15 27 wide (the mockup's
// proportions) and fret 22 18 wide, where dots shrink a little to fit.
const OPEN = 30 // room for open-string notes before the nut
const LENGTH = 820
// Vertical: frets 0–15 fill the screen; 16–22 continue below it.
const SCREEN_FRETS = 15
const SPACING = { h: 28, v: 36 }
const MARGIN = { h: 14, v: 34 } // first string from the edge; v leaves room for fret numbers
const DOT_R = 10
const ROOT_R = 11
// Vertical: drawn 1:1 with EQUAL fret spacing (it reads like a chord chart;
// users found narrowing frets odd top to bottom), frets 0–15 exactly filling
// the screen height left by everything that shares it (see verticalLength),
// the rest continuing below the fold.
// On phones the strings spread across the board's width. On a short screen
// dots shrink to their fret (never below MIN_R) and labels with them (never
// below MIN_FONT). Horizontal keeps real fret spacing and, on phones, scrolls.
const EDGE = 24 // past the high E, room for its dots
const MIN_R = 6
const MIN_FONT = 9

/** Fret positions for a neck `length` long with `open` units before the nut:
 * real (narrowing) spacing, or equal spacing. */
function geometry(length: number, open: number, equal = false) {
	const scale = (length - open - 6) / (1 - 2 ** (-FRETS / 12))
	const fretAt = equal
		? (n: number) => open + (n * (length - open - 6)) / FRETS
		: (n: number) => open + scale * (1 - 2 ** (-n / 12))
	const noteAlong = (fret: number) => (fret === 0 ? open / 2 : (fretAt(fret - 1) + fretAt(fret)) / 2)
	const halfCell = (fret: number) => (fret === 0 ? open / 2 : (fretAt(fret) - fretAt(fret - 1)) / 2)
	return { length, open, fretAt, noteAlong, halfCell }
}

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
		const boxEl = neck.querySelector('.neck__box')
		if (boxEl && neck.classList.contains('neck--vertical')) return boxEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
		const box = boxEl?.getBoundingClientRect()
		if (box) {
			const view = board.getBoundingClientRect()
			board.scrollBy({ left: box.left + box.width / 2 - (view.left + view.width / 2), behavior: 'smooth' })
		}
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
		if (mode === 'explore') return mic.listen(!listening)
		addByEar = !(addByEar && listening)
		if (addByEar && !listening) mic.listen(true)
		syncMic()
	})

	// Taps (and Enter/Space on a focused note) play the note; in Identify they
	// also toggle the mark.
	function onCell(target: EventTarget | null) {
		const cell = (target as Element | null)?.closest<SVGGElement>('[data-s]')
		if (!cell) return
		const string = Number(cell.dataset.s)
		const fret = Number(cell.dataset.f)
		Sound.play(midiAt(string, fret))
		if (mode !== 'identify') return
		const key = `${string}-${fret}`
		if (marked.has(key)) marked.delete(key)
		else marked.add(key)
		render()
		neck.querySelector<SVGGElement>(`[data-s="${string}"][data-f="${fret}"]`)?.focus()
	}
	neck.addEventListener('click', (event) => onCell(event.target))
	neck.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return
		event.preventDefault()
		onCell(event.target)
	})

	Settings.subscribe(render)
	// The phone neck is sized from the board's width: redraw when that changes.
	const redraw = () => {
		if (!root.hidden) render()
	}
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

	// Vertical neck length so fret 15 ends exactly where the screen does, with
	// the toolbar (and hint) above the board in view: the screen height minus
	// those controls, the board's top padding, and the docked tab bar on
	// phones, or on wider screens everything above the neck block (top bar).
	// Frets 16–22, the board's bottom and the legend follow below the fold.
	function verticalLength() {
		const cardBox = card.getBoundingClientRect()
		const above = board.getBoundingClientRect().top - cardBox.top + parseFloat(getComputedStyle(board).paddingTop)
		const reserve = phone.matches ? tabBar.offsetHeight + 4 : cardBox.top + scrollY + 16
		const screen = Math.max(300, innerHeight - reserve - above)
		// Equal frets: stretch the screen's 0–15 to the full 0–22 neck.
		return Math.round(OPEN + 6 + ((screen - OPEN) * FRETS) / SCREEN_FRETS)
	}

	/* Playback ------------------------------------------------------------ */
	function stopPlaying() {
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

	// The note being played back lights inside the box only; the note heard
	// from the mic lights everywhere it can be played.
	function applyLit() {
		for (const cell of neck.querySelectorAll<SVGGElement>('[data-s]')) {
			const midi = Number(cell.dataset.midi)
			const lit = midi === heardMidi || (midi === playingMidi && !cell.classList.contains('cell--dim'))
			cell.classList.toggle('cell--lit', lit)
		}
	}

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

	function drawNeck(shown: Shown | null, names: Map<number, string>, highlighted: (degree: string) => boolean, length?: number) {
		const { scaleLabels, fretboardVertical } = Settings.get()
		const vertical = fretboardVertical
		const o = vertical ? 'v' : 'h'
		const boardWidth = board.clientWidth - parseFloat(getComputedStyle(board).paddingLeft) * 2
		const spacingV = phone.matches ? Math.max(SPACING.v, (boardWidth - MARGIN.v - EDGE) / 5) : SPACING.v
		const spacing = vertical ? spacingV : SPACING.h
		const across = (a: number) => MARGIN[o] + (vertical ? 5 - a : a) * spacing
		// Fixed distances past the outer strings, whatever the string spacing:
		// wires, nut and position box reach 14 units out, fret numbers sit 22 out.
		const out = 14 / spacing
		const numAt = 5 + 22 / spacing
		const xy = (along: number, a: number) => (vertical ? [across(a), along] : [along, across(a)])
		const pt = (along: number, a: number, p = '') => {
			const [x, y] = xy(along, a)
			return `${p}x="${x}" ${p}y="${y}"`
		}
		const line = (along1: number, a1: number, along2: number, a2: number) => {
			const [x1, y1] = xy(along1, a1)
			const [x2, y2] = xy(along2, a2)
			return `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`
		}
		// Axis-aligned rect between two (along, across) corners.
		const rect = (along1: number, a1: number, along2: number, a2: number) => {
			const [x1, y1] = xy(along1, a1)
			const [x2, y2] = xy(along2, a2)
			return `x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}"`
		}
		// Fret size setting: scales the neck's length (frets' height when vertical,
		// width when horizontal) at constant dot size. Above 1 a vertical neck
		// just grows and the page scrolls (one scrollbar, not two); a horizontal
		// one scrolls sideways in its board. Below 1 dots shrink with their frets.
		const size = Settings.get().fretSize
		const fill = vertical ? verticalLength() : null
		const base = length ?? fill ?? LENGTH
		// Phones, horizontal: drawn 1:1 (so MIN_R / MIN_FONT are real pixels)
		// and scrolling; a neck within 10 % of the board's width just fits it,
		// since a few px of scroll is a scrollbar for nothing.
		const phoneWidth = !vertical && phone.matches ? (LENGTH * size <= boardWidth * 1.1 ? boardWidth : LENGTH * size) : null
		const g = geometry(Math.round(phoneWidth ?? base * size), OPEN, vertical)
		const { fretAt, noteAlong, halfCell } = g
		const width = vertical ? MARGIN.v + 5 * spacingV + EDGE : g.length
		const height = vertical ? g.length : MARGIN.h + 5 * SPACING.h + 30
		neck.setAttribute('viewBox', `0 0 ${width} ${height}`)
		neck.classList.toggle('neck--vertical', vertical)
		// Vertical is drawn 1:1 (inline size beats the stylesheet's width: 100%).
		// Horizontal on wider screens: the rendered width grows with the length,
		// so dots keep their size.
		neck.style.width = vertical ? `${width}px` : phoneWidth ? `${g.length}px` : size === 1 ? '' : `${100 * size}%`
		neck.style.height = vertical ? `${height}px` : ''

		const degrees = shown ? degreeMap(shown.rootPc, shown.type) : new Map<number, string>()
		const box = shown && position ? positionWindows(shown.rootPc, shown.type)[position - 1] : null
		const parts: string[] = []

		for (const fret of INLAYS) {
			const at = noteAlong(fret)
			const spots = fret === 12 ? [1.5, 3.5] : [2.5]
			for (const a of spots) parts.push(`<circle class="neck__inlay" ${pt(at, a, 'c')} r="4"/>`)
			// Fret numbers beyond the low E: under the neck, or left of it when vertical.
			parts.push(`<text class="neck__num" ${pt(at, numAt)}>${fret}</text>`)
		}
		// Wires and nut run half a string space past the outer strings.
		for (let fret = 1; fret <= FRETS; fret++) parts.push(`<line class="neck__fret" ${line(fretAt(fret), -out, fretAt(fret), 5 + out)}/>`)
		parts.push(`<line class="neck__nut" ${line(g.open, -out, g.open, 5 + out)}/>`)
		// Thicker toward the low E, like real gauges (.010–.046): 0.7 to 2.4.
		STRINGS.forEach((_, s) => parts.push(`<line class="neck__string" style="stroke-width:${0.7 + s * 0.34}" ${line(g.open, s, g.length, s)}/>`))
		if (box) {
			const from = box[0] === 0 ? 2 : fretAt(box[0] - 1) + 1
			const to = fretAt(box[1]) - 1
			parts.push(`<rect class="neck__box" ${rect(from, -out, to, 5 + out)} rx="6"/>`)
		}

		STRINGS.forEach((_, s) => {
			for (let fret = 0; fret <= FRETS; fret++) {
				const midi = midiAt(s, fret)
				const pc = midi % 12
				const isMarked = mode === 'identify' && marked.has(`${s}-${fret}`)
				const degree = degrees.get(pc)
				const name = names.get(pc) ?? ROOTS[pc]
				const classes = ['cell']
				const isRoot = degree === '1' && highlighted(degree)
				if (degree || isMarked) classes.push('cell--dot')
				if (degree && highlighted(degree)) classes.push(isRoot ? 'cell--root' : 'cell--tone')
				else if (degree) classes.push('cell--scale')
				if (isMarked) classes.push('cell--marked')
				if (box && (fret < box[0] || fret > box[1])) classes.push('cell--dim')
				const label = scaleLabels === 'none' ? '' : scaleLabels === 'intervals' && degree ? degree : name
				const at = noteAlong(fret)
				const half = halfCell(fret)
				const full = isRoot ? ROOT_R : DOT_R
				const r = Math.max(MIN_R, Math.min(full, half + 0.4))
				const font = r < full ? `style="font-size:${Math.max(MIN_FONT, r * 1.15).toFixed(1)}px"` : ''
				const focusable = mode === 'identify' || degree !== undefined
				parts.push(
					`<g class="${classes.join(' ')}" data-s="${s}" data-f="${fret}" data-midi="${midi}" role="button" tabindex="${focusable ? 0 : -1}"` +
						` aria-label="${STRING_NAMES[s]} string, ${fret === 0 ? 'open' : `fret ${fret}`}, ${name}${degree ? ` (${degree})` : ''}"` +
						(mode === 'identify' ? ` aria-pressed="${isMarked}"` : '') +
						`><rect class="cell__hit" ${rect(at - half, s - 0.5, at + half, s + 0.5)}/>` +
						`<circle ${pt(at, s, 'c')} r="${r}"/>` +
						`<text ${pt(at, s)} ${font}>${label}</text></g>`
				)
			}
		})
		neck.innerHTML = parts.join('')
		applyLit()
		// The board's padding and legend were measured around the previous
		// drawing; if the fill is off (first vertical draw, a scrollbar gone),
		// draw once more at the corrected length.
		if (fill && length === undefined) {
			const want = verticalLength()
			if (Math.abs(want - fill) > 1) drawNeck(shown, names, highlighted, want)
		}
	}

	const ORDINALS = ['', 'root', '2nd', '3rd', '4th', '5th', '6th', '7th']

	// Names the coloured degrees the shown scale actually has, e.g. "3rd and 5th".
	function renderLegend(shown: Shown | null, scaleDegrees: number[]) {
		legend.hidden = !shown
		if (!shown) return
		const present = new Set(degreesOf(shown.type).map(degreeNumber))
		const tones = scaleDegrees.filter((n) => n > 1 && present.has(n)).map((n) => ORDINALS[n])
		legendRoot.hidden = !scaleDegrees.includes(1)
		legendTone.hidden = tones.length === 0
		legendTone.textContent = tones.length > 1 ? `${tones.slice(0, -1).join(', ')} and ${tones.at(-1)}` : (tones[0] ?? '')
	}

	function render() {
		const { scaleDegrees, scaleLabels, fretboardTheme } = Settings.get()
		const identify = mode === 'identify'
		modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)))
		explorePickers.hidden = identify
		identifyPickers.hidden = !identify
		rootSelect.value = String(rootPc)
		typeSelect.value = String(typeIndex)
		labelButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.labels === scaleLabels)))
		positionButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === position)))
		if (fretboardTheme === 'auto') delete board.dataset.theme
		else board.dataset.theme = fretboardTheme

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
			heardMidi = null
			addedMidi = null
			applyLit()
		},

		onReading(reading) {
			// The synth's own notes come back through the mic: ignore them.
			const midi = reading && !Sound.isRinging() ? Math.round(midiOfFrequency(reading.frequency, Settings.get().a4)) : null
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
