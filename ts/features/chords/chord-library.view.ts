// The Chords tab's other two sub-views beside the live recognizer: Library
// (pick a root and type: symbol, notes, keys, playable voicings) and Identify
// (mark one note per string on a neck, get the chord). Owns the Listen /
// Library / Identify switch; ts/features/chords/chords.view.ts keeps the recognizer and only
// calls onActivate and openChord. Pure logic lives in ts/music/chord-library.ts.
import { createFretboard, type Dot } from '../../ui/fretboard'
import { chordDiagram, type ChordDiagram } from '../../ui/chord-diagram'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { CHORD_TYPES, identifyChords, spellChord, type ChordType } from '../../music/chord-theory'
import { chordShapes, shapeString } from '../../music/chord-shapes'
import { CHORD_GROUPS, keysOf, matchNotes, parseChordSymbol, ROOT_LABELS, shapeNotes, voicingCaption } from '../../music/chord-library'
import { degreeMap, degreeRole, pitchClassOf, ROOTS, STRINGS } from '../../music/scales'
import { OPEN_CHORD_EVENT } from '../../ui/events'
import { bindSegmented, liveRegion, scoped, setPressed, svgEl } from '../../ui/dom'
import { micNeedChanged } from '../../ui/mic-block'
import { withStepper } from '../../ui/stepper'

// ponytail: the 8 best shapes; the generator has dozens, add "more" if asked.
const VOICINGS = 8
const RESULTS = 6
// Fit lamps on an Identify result: all lit for an exact match, one fewer per
// missing or extra note (omittable tones count half, rounded up), at least one.
const FIT_LAMPS = 4
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

/** A `tag` element holding `text`, with `className` when given. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
	const node = document.createElement(tag)
	if (className) node.className = className
	node.textContent = text
	return node
}

/** 'Bb minor 7th over D' as nodes for an upper-cased label: the note names sit
 * in .pitch spans, which keep their case (Bb, not BB). */
export const chordName = (root: string, typeName: string, bass?: string) => [
	el('span', root, 'pitch'),
	` ${typeName}`,
	...(bass ? [' over ', el('span', bass, 'pitch')] : []),
]

/** Strings low to high, all at once or one by one (the Play as setting). */
const play = (midis: number[]) => Sound.strum(midis, { step: Settings.get().chordPlay === 'arpeggio' ? ARPEGGIO_S : STRUM_S })

/** A switch calls micNeedChanged(): only Listen uses the mic. */
export function createChordModes(root: HTMLElement): ChordModes {
	const { $, $$ } = scoped(root)
	// The plate's display and the blocks under it, each tagged with its sub-view.
	const parts = $$('[data-chords-part]')
	let mode: Mode = Settings.get().chordsMode

	function setMode(next: Mode) {
		// A strum from the sub-view being left stops with it.
		if (next !== mode) Sound.stopAll()
		mode = next
		if (Settings.get().chordsMode !== next) Settings.update({ chordsMode: next })
		micNeedChanged()
		show()
	}
	const showMode = bindSegmented(root, 'data-chords-mode', (value) => setMode(value as Mode))

	function show() {
		// Not data-mode: that attribute is the theme's light/dark (ts/ui/theme.ts).
		root.dataset.chordsView = mode
		showMode(mode)
		// The shared #mic block follows wantsMic (ts/ui/mic-block.ts).
		for (const part of parts) part.hidden = part.dataset.chordsPart !== mode
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
	// The chord's diagrams, and those drawn so far; dropped (destroy) when the chord changes.
	let diagrams: ChordDiagram[] = []
	let drawn: ChordDiagram[] = []

	const rootButtons = ROOT_LABELS.map((label, pc) => {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'key chord-root'
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
	// ◀ ▶ walk the types in picker order (commonness within each group).
	withStepper(typeSelect)
	typeSelect.addEventListener('change', () => {
		type = CHORD_TYPES.find((t) => t.symbol === typeSelect.value) ?? CHORD_TYPES[0]
		renderLibrary()
	})

	// A page holds 8 diagrams of ~150 elements each: draw them as they scroll in.
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue
				observer.unobserve(entry.target)
				const card = entry.target as HTMLElement
				// A record queued before the chord changed: that card is gone.
				if (!card.isConnected) continue
				const diagram = diagrams[Number(card.dataset.index)]
				diagram.render()
				drawn.push(diagram)
			}
		},
		{ rootMargin: '200px 0px' }
	)

	function redrawDiagrams() {
		staleDiagrams = false
		for (const diagram of drawn) diagram.render()
	}

	function buildVoicings(symbol: string) {
		observer.disconnect()
		diagrams.forEach((diagram) => diagram.destroy())
		drawn = []
		const voicings = chordShapes(rootPc, type, { limit: VOICINGS })
		// Labels per the setting, read at every draw.
		diagrams = voicings.map((voicing) =>
			chordDiagram(rootPc, type, voicing, {
				svg: svgEl('svg', { class: 'neck', 'aria-hidden': 'true' }),
				labels: () => Settings.get().chordLabels,
			})
		)
		noVoicings.hidden = voicings.length > 0
		voicingList.replaceChildren(
			...voicings.map((voicing, i) => {
				const caption = voicingCaption(voicing, i)
				const item = document.createElement('li')
				item.className = i === 0 ? 'voicing voicing--hero' : 'voicing'
				item.dataset.index = String(i)
				// The diagram printed on a card with its shape; Strum under it plays it.
				const card = el('div', '', 'paper voicing__card')
				card.append(diagrams[i].el, el('span', caption.title, 'voicing__title'))
				const strum = el('button', '▶ Strum', 'key voicing__strum')
				strum.type = 'button'
				strum.setAttribute('aria-label', `Play ${symbol}, ${shapeString(voicing)}, ${caption.position}`)
				strum.addEventListener('click', () => play(shapeNotes(voicing.frets).midis))
				const foot = el('div', '', 'voicing__foot')
				foot.append(el('span', caption.position, 'silk'), strum)
				item.append(card, foot)
				observer.observe(item)
				return item
			})
		)
	}

	function renderLibrary() {
		const chord = spellChord(ROOTS[rootPc], type)
		setPressed(rootButtons, (_, pc) => pc === rootPc)
		typeSelect.value = type.symbol
		const key = `${rootPc}|${type.symbol}`
		if (key === builtFor) return
		builtFor = key
		symbolEl.textContent = chord.symbol
		nameEl.replaceChildren(...chordName(chord.root, type.name))
		// Note over degree, one column each, printed on the display.
		notesEl.replaceChildren(
			...chord.notes.map((note, i) => {
				const tone = document.createElement('span')
				tone.setAttribute('role', 'listitem')
				tone.className = 'chord-tone'
				tone.append(note, el('small', chord.degrees[i]))
				return tone
			})
		)
		const keys = keysOf(rootPc, type)
		keysBlock.hidden = keys.length === 0
		keysList.replaceChildren(
			...keys.map((use) => {
				const chip = document.createElement('li')
				chip.className = 'key-chip'
				chip.setAttribute('aria-label', `${use.numeral} in ${use.minor ? `${use.key.slice(0, -1)} minor` : `${use.key} major`}`)
				chip.append(el('small', use.numeral), use.key)
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
	// Only a new best match is announced, not every redraw.
	const announce = liveRegion($('.chord-identify__status'), { dedupe: true })
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

	const message = (text: string) => el('li', text, 'chord-results__empty')

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
			const role = degree ? degreeRole(degree) : 'marked'
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
		announce(top ? `Best match: ${top.symbol}, ${top.root} ${top.type.name}${top.bass ? ` over ${top.bass}` : ''}` : '')

		if (empty) return results.replaceChildren(message('Tap a fret on each string you play; tap it again to clear. Open strings sit left of the nut.'))
		if (!matches.length) return results.replaceChildren(message(pcs.size < 2 ? 'Mark at least two different notes.' : 'No chord found. Is the root marked?'))
		results.replaceChildren(
			...matches.slice(0, RESULTS).map((match) => {
				// A printed index line: symbol, name, how it differs, fit lamps, Open.
				const diff = matchNotes(match, pcs)
				const text = el('span', '', 'chord-result__text')
				const name = el('span', '', 'chord-result__name')
				name.append(...chordName(match.root, match.type.name, match.bass))
				text.append(name, el('span', `${diff.length ? diff.join(' · ') : 'exact'} · ${match.notes.join(' ')}`, 'chord-result__detail'))
				const fit = el('span', '', 'chord-result__fit')
				fit.setAttribute('aria-hidden', 'true')
				const lit = Math.max(1, FIT_LAMPS - Math.ceil(match.missing + match.extra))
				for (let i = 0; i < FIT_LAMPS; i++) fit.append(el('span', '', i < lit ? 'lamp is-on' : 'lamp'))
				const open = el('button', 'Open', 'key chord-result__open')
				open.type = 'button'
				open.setAttribute('aria-label', `Open ${match.symbol} in the Library`)
				open.addEventListener('click', () => openChord(match.symbol))
				const item = el('li', '', 'chord-result')
				item.append(el('span', match.symbol, 'chord-result__symbol'), text, fit, open)
				return item
			})
		)
	}

	return { onActivate: show, openChord, listening: () => mode === 'listen' }
}
