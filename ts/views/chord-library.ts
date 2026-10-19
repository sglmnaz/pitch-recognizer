// The Chords tab's other two sub-views beside the live recognizer: Library
// (pick a root and type: symbol, notes, keys, playable voicings) and Identify
// (mark one note per string on a neck, get the chord). Owns the Listen /
// Library / Identify switch; ts/views/chords.ts keeps the recognizer and only
// calls onActivate and openChord. Pure logic lives in ts/chord-library.ts.
import { createFretboard, type Dot, type Fretboard } from '../fretboard'
import * as Settings from '../settings'
import * as Sound from '../sound'
import { CHORD_TYPES, identifyChords, spellChord, type ChordType } from '../chord-theory'
import { chordShapes, shapeString, voicingSpec, type Voicing } from '../chord-shapes'
import { CHORD_GROUPS, keysOf, matchNotes, parseChordSymbol, ROOT_LABELS, shapeNotes, voicingCaption } from '../chord-library'
import { degreeMap, degreeNumber, pitchClassOf, ROOTS, STRINGS } from '../scales'
import { OPEN_CHORD_EVENT } from './harmony'

// ponytail: the 8 best shapes; the generator has dozens, add "more" if asked.
const VOICINGS = 8
const RESULTS = 6
// Strum: a pick across six strings takes ~30 ms per string; an arpeggio picks
// them one by one, about sixteenths at 95 bpm.
const STRUM_S = 0.03
const ARPEGGIO_S = 0.16

type Mode = Settings.Settings['chordsMode']

export interface ChordModes {
	/** The Chords tab became active: show the remembered sub-view. */
	onActivate(): void
	/** Opens a chord ('Am7', 'C/E') in the Library. Unknown symbols are ignored. */
	openChord(symbol: string): void
	/** Listen is showing: the recognizer wants the mic and its readings. */
	listening(): boolean
}

// "C#/Db" read aloud as "C sharp or D flat".
const spoken = (label: string) =>
	label
		.split('/')
		.map((n) => n[0] + (n[1] === '#' ? ' sharp' : n[1] === 'b' ? ' flat' : ''))
		.join(' or ')

const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1)

/** Strings low to high, all at once or one by one (the Play as setting). A
 * new strum cuts the last one off instead of stacking on it; six strings
 * ringing together at 1/sqrt(n) each stay as loud as one note, like ts/views/ear.ts. */
function play(midis: number[]) {
	const step = Settings.get().chordPlay === 'arpeggio' ? ARPEGGIO_S : STRUM_S
	const gain = 1 / Math.sqrt(Math.max(1, midis.length))
	Sound.stopAll()
	midis.forEach((midi, i) => Sound.play(midi, i * step, gain))
}

/** `onMicNeed` tells index.ts that listening() changed: only Listen uses the mic. */
export function createChordModes(root: HTMLElement, onMicNeed: () => void): ChordModes {
	const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!
	const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-chords-mode]'))
	const listenParts = [$<HTMLElement>(':scope > .readout'), $<HTMLElement>(':scope > .hint')]
	const library = $<HTMLElement>('.chord-library')
	const identify = $<HTMLElement>('.chord-identify')
	let mode: Mode = Settings.get().chordsMode

	function setMode(next: Mode) {
		// A strum from the sub-view being left stops with it.
		if (next !== mode) Sound.stopAll()
		mode = next
		if (Settings.get().chordsMode !== next) Settings.update({ chordsMode: next })
		onMicNeed()
		show()
	}
	modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.chordsMode as Mode)))

	function show() {
		root.dataset.mode = mode
		modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chordsMode === mode)))
		// The shared #mic block follows wantsMic (index.ts).
		for (const part of listenParts) part.hidden = mode !== 'listen'
		library.hidden = mode !== 'library'
		identify.hidden = mode !== 'identify'
		if (mode === 'library') {
			renderLibrary()
			if (staleDiagrams) redrawDiagrams()
		}
		if (mode === 'identify') renderIdentify()
	}

	// Labels, left-handedness and the board theme redraw what is on screen;
	// diagrams drawn while hidden are redrawn when they show (Identify always
	// redraws then). Every other setting leaves the necks alone.
	const look = () => {
		const { chordLabels, leftHanded, fretboardTheme } = Settings.get()
		return `${chordLabels}|${leftHanded}|${fretboardTheme}`
	}
	let lastLook = look()
	let staleDiagrams = false
	Settings.subscribe(() => {
		if (look() === lastLook) return
		lastLook = look()
		if (root.hidden || mode !== 'library') staleDiagrams = true
		else redrawDiagrams()
		if (!root.hidden && mode === 'identify') renderIdentify()
	})

	/* Library ------------------------------------------------------------- */
	const rootRow = $<HTMLElement>('.chord-roots')
	const typeSelect = $<HTMLSelectElement>('.chord-type')
	const symbolEl = $<HTMLElement>('.chord-info__symbol')
	const nameEl = $<HTMLElement>('.chord-info__name')
	const notesEl = $<HTMLElement>('.chord-info__notes')
	const keysBlock = $<HTMLElement>('.chord-keys')
	const keysList = $<HTMLElement>('.chord-keys__list')
	const voicingList = $<HTMLElement>('.voicings')
	const noVoicings = $<HTMLElement>('.voicings__empty')
	let rootPc = 0
	let type: ChordType = CHORD_TYPES[0]
	let builtFor = ''
	// Diagrams drawn so far; dropped (destroy) when the chord changes.
	let drawn: { board: Fretboard; voicing: Voicing }[] = []

	const rootButtons = ROOT_LABELS.map((label, pc) => {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'chord-root'
		button.textContent = label
		button.setAttribute('aria-label', spoken(label))
		button.addEventListener('click', () => {
			rootPc = pc
			renderLibrary()
		})
		rootRow.append(button)
		return button
	})

	for (const group of CHORD_GROUPS) {
		const optgroup = document.createElement('optgroup')
		optgroup.label = group.label
		for (const t of group.types) optgroup.append(new Option(`${capitalized(t.name)}${t.symbol ? ` (${t.symbol})` : ''}`, t.symbol))
		typeSelect.append(optgroup)
	}
	typeSelect.addEventListener('change', () => {
		type = CHORD_TYPES.find((t) => t.symbol === typeSelect.value) ?? CHORD_TYPES[0]
		renderLibrary()
	})

	// Fingers: the numbers move into the dots, so the row under the diagram goes.
	function specOf(voicing: Voicing) {
		const labels = Settings.get().chordLabels
		const spec = voicingSpec(voicing, rootPc, type, {
			labels: labels === 'fingers' ? 'none' : labels,
			fingers: labels !== 'fingers',
		})
		if (labels === 'fingers') for (const dot of spec.dots) dot.label = voicing.fingers[dot.string] ? String(voicing.fingers[dot.string]) : ''
		return spec
	}

	// A page holds 8 diagrams of ~150 elements each: draw them as they scroll in.
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue
				observer.unobserve(entry.target)
				const card = entry.target as HTMLElement
				// A record queued before the chord changed: that card is gone.
				if (!card.isConnected) continue
				const voicing = chordShapes(rootPc, type, { limit: VOICINGS })[Number(card.dataset.index)]
				const board = createFretboard(card.querySelector('svg')!, null)
				board.render(specOf(voicing))
				drawn.push({ board, voicing })
			}
		},
		{ rootMargin: '200px 0px' }
	)

	function redrawDiagrams() {
		staleDiagrams = false
		for (const { board, voicing } of drawn) board.render(specOf(voicing))
	}

	function buildVoicings(symbol: string) {
		observer.disconnect()
		drawn.forEach(({ board }) => board.destroy())
		drawn = []
		const voicings = chordShapes(rootPc, type, { limit: VOICINGS })
		noVoicings.hidden = voicings.length > 0
		voicingList.replaceChildren(
			...voicings.map((voicing, i) => {
				const caption = voicingCaption(voicing, i)
				const item = document.createElement('li')
				item.className = i === 0 ? 'voicing voicing--hero' : 'voicing'
				item.dataset.index = String(i)
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'voicing__btn'
				button.setAttribute('aria-label', `Play ${symbol}, ${shapeString(voicing)}, ${caption.position}`)
				button.addEventListener('click', () => play(shapeNotes(voicing.frets).midis))
				const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
				svg.setAttribute('class', 'neck')
				svg.setAttribute('aria-hidden', 'true')
				const title = document.createElement('span')
				title.className = 'voicing__title'
				title.textContent = caption.title
				const position = document.createElement('span')
				position.className = 'voicing__pos'
				position.textContent = caption.position
				button.append(svg, title, position)
				item.append(button)
				observer.observe(item)
				return item
			})
		)
	}

	function renderLibrary() {
		const chord = spellChord(ROOTS[rootPc], type)
		rootButtons.forEach((b, pc) => b.setAttribute('aria-pressed', String(pc === rootPc)))
		typeSelect.value = type.symbol
		const key = `${rootPc}|${type.symbol}`
		if (key === builtFor) return
		builtFor = key
		symbolEl.textContent = chord.symbol
		nameEl.textContent = `${chord.root} ${type.name}`
		notesEl.replaceChildren(
			...chord.notes.map((note, i) => {
				const chip = document.createElement('span')
				chip.setAttribute('role', 'listitem')
				const degree = chord.degrees[i]
				const n = degreeNumber(degree)
				chip.className = `scale-note chord-note${degree === '1' ? ' scale-note--root' : n === 3 || n === 5 ? ' scale-note--tone' : ''}`
				const name = document.createElement('span')
				name.className = 'scale-note__name'
				name.textContent = note
				const deg = document.createElement('span')
				deg.className = 'scale-note__degree'
				deg.textContent = degree
				chip.append(name, deg)
				return chip
			})
		)
		const keys = keysOf(rootPc, type)
		keysBlock.hidden = keys.length === 0
		keysList.replaceChildren(
			...keys.map((use) => {
				const chip = document.createElement('li')
				chip.className = 'key-chip'
				chip.setAttribute('aria-label', `${use.numeral} in ${use.minor ? `${use.key.slice(0, -1)} minor` : `${use.key} major`}`)
				const numeral = document.createElement('b')
				numeral.textContent = use.numeral
				chip.append(numeral, ` ${use.key}`)
				return chip
			})
		)
		buildVoicings(chord.symbol)
	}

	function openChord(symbol: string) {
		const parsed = parseChordSymbol(symbol)
		if (!parsed) return
		rootPc = parsed.rootPc
		type = parsed.type
		setMode('library')
		// Keyboard users land on the chord, not on a button that just vanished.
		if (!root.hidden) symbolEl.focus()
	}
	symbolEl.tabIndex = -1

	// Other tabs (Scales' diatonic chords) link here: they set #chords and send
	// this event, in either order. Opening sets the state and the remembered
	// mode, so a hash change after it lands on the Library too.
	window.addEventListener(OPEN_CHORD_EVENT, (event) => {
		const symbol = (event as CustomEvent<{ symbol?: string }>).detail?.symbol
		if (typeof symbol === 'string') openChord(symbol)
	})

	/* Identify ------------------------------------------------------------ */
	const board = $<HTMLElement>('.chord-identify .neck-board')
	const shapeEl = $<HTMLElement>('.chord-shape')
	const strumButton = $<HTMLButtonElement>('[data-action="strum"]')
	const clearButton = $<HTMLButtonElement>('[data-action="clear-shape"]')
	const results = $<HTMLElement>('.chord-results')
	const status = $<HTMLElement>('.chord-identify__status')
	// Per string as in STRINGS: -1 not played (muted), else the fret. One note
	// per string, like a real chord shape.
	const shape = STRINGS.map(() => -1)
	const neckSvg = $<SVGSVGElement>('.chord-identify .neck')
	const neck = createFretboard(neckSvg, board, { onTap })

	function onTap(string: number, fret: number, midi: number) {
		shape[string] = shape[string] === fret ? -1 : fret
		if (shape[string] >= 0) Sound.play(midi)
		renderIdentify()
	}

	strumButton.addEventListener('click', () => play(shapeNotes(shape).midis))
	clearButton.addEventListener('click', () => {
		shape.fill(-1)
		renderIdentify()
	})
	// The phone neck is sized from the board's width; once per frame at most.
	let resizeFrame = 0
	window.addEventListener('resize', () => {
		if (resizeFrame) return
		resizeFrame = requestAnimationFrame(() => {
			resizeFrame = 0
			if (!root.hidden && mode === 'identify') renderIdentify()
		})
	})

	function message(text: string) {
		const item = document.createElement('li')
		item.className = 'chord-results__empty'
		item.textContent = text
		return item
	}

	function renderIdentify() {
		const { midis, pcs, bassPc } = shapeNotes(shape)
		const matches = identifyChords(pcs, bassPc)
		const top = matches[0]
		// Dots wear the best match's degree colours and spelling.
		const degrees = top ? degreeMap(top.rootPc, top.type) : new Map<number, string>()
		const names = new Map(top ? top.notes.map((n) => [pitchClassOf(n), n]) : [])
		const name = (midi: number) => names.get(midi % 12) ?? ROOTS[midi % 12]
		const dots: Dot[] = shape.flatMap((fret, string) => {
			if (fret < 0) return []
			const midi = STRINGS[string] + fret
			const degree = degrees.get(midi % 12)
			const n = degree ? degreeNumber(degree) : 0
			const role = !degree ? 'marked' : degree === '1' ? 'root' : n === 3 || n === 5 ? 'tone' : 'note'
			return [{ string, fret, role, label: name(midi), detail: degree, marked: true }]
		})
		neck.render({ dots, noteName: name, toggles: true, label: 'Fretboard: tap one note per string, again to clear it' })

		shapeEl.textContent = midis.length ? shapeString({ frets: shape }) : 'Tap one note per string'
		shapeEl.classList.toggle('chord-shape--empty', midis.length === 0)
		// Clear (or the last note's tap) disables a focused button: keep focus on the neck.
		const empty = midis.length === 0
		if (empty && (document.activeElement === strumButton || document.activeElement === clearButton))
			neckSvg.querySelector<SVGGElement>('[data-s][tabindex="0"]')?.focus()
		strumButton.disabled = clearButton.disabled = empty
		// Only a new best match is announced, not every redraw.
		const best = top ? `Best match: ${top.symbol}, ${top.root} ${top.type.name}${top.bass ? ` over ${top.bass}` : ''}` : ''
		if (status.textContent !== best) status.textContent = best

		if (empty) return results.replaceChildren(message('Tap a fret on each string you play; tap it again to clear. Open strings sit left of the nut.'))
		if (!matches.length) return results.replaceChildren(message(pcs.size < 2 ? 'Mark at least two different notes.' : 'No chord found. Is the root marked?'))
		results.replaceChildren(
			...matches.slice(0, RESULTS).map((match) => {
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'scale-result chord-result'
				button.title = 'Open in the Library'
				const symbol = document.createElement('span')
				symbol.className = 'chord-result__symbol'
				symbol.textContent = match.symbol
				const diff = matchNotes(match, pcs)
				const extra = document.createElement('span')
				extra.className = 'scale-result__extra'
				extra.textContent = diff.length ? diff.join(' · ') : 'exact'
				const full = document.createElement('span')
				full.className = 'scale-result__notes'
				full.textContent = `${match.root} ${match.type.name}${match.bass ? ` over ${match.bass}` : ''} · ${match.notes.join(' ')}`
				button.append(symbol, extra, full)
				button.addEventListener('click', () => openChord(match.symbol))
				const item = document.createElement('li')
				item.append(button)
				return item
			})
		)
	}

	return { onActivate: show, openChord, listening: () => mode === 'listen' }
}
