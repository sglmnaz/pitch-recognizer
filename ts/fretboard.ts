// The fretboard: an SVG neck (full 0–22 or a short chord-diagram window) that
// draws whatever dots a view hands it, plus position boxes, barres, finger
// numbers and open/muted markers, and reports taps. Orientation, fret size,
// board palette and left-handedness come from the settings, so every view
// that shows a neck follows them alike.
import * as Settings from './settings'
import { FRETS, ROOTS, STRINGS } from './scales'

/** root / tone / note: the degree palette; marked: solid (Identify, off any
 * shown scale); optional: a dashed outline (e.g. a chord tone you may drop). */
export type Role = 'root' | 'tone' | 'note' | 'marked' | 'optional'

export interface Dot {
	/** String index as in `STRINGS`: 0 = highest string. */
	string: number
	fret: number
	role: Role
	/** Text in the dot ('' for none). */
	label: string
	/** Appended to the note name in the aria label, e.g. the degree: "C (b3)". */
	detail?: string
	/** On top of its role: a thicker outline (a marked note on a shown scale). */
	marked?: boolean
	/** Faded, like the notes outside a position box. */
	dimmed?: boolean
	/** Finger number, drawn in a row past the last fret (chord diagrams only, dots inside the window). */
	finger?: number
}

/** One finger across strings `from`–`to` (inclusive, either order) at `fret`. */
export interface Barre {
	fret: number
	from: number
	to: number
}

export interface NeckSpec {
	dots: Dot[]
	/** A cell's note name: its aria label, and its text when an empty cell lights up. */
	noteName?: (midi: number) => string
	/** Show that text on empty cells when lit (false for Labels: None). */
	emptyLabels?: boolean
	/** [lowest, highest] fret of a position box; cells outside it are dimmed. */
	box?: [number, number] | null
	barres?: Barre[]
	/** Per string: an open-string ring or a mute cross above the nut. */
	strings?: ('open' | 'muted' | null)[]
	/** Every cell is a toggle (focusable, aria-pressed = marked): Identify. */
	toggles?: boolean
	/** Accessible name of the whole neck (role="img" when nothing is tappable), e.g. "C, x32010". */
	label?: string
	/** Chord diagram: `frets` frets (default 4) from `from` (≥ 1; 1 draws the
	 * nut, higher a "5fr" label). Vertical unless `vertical` is false. */
	window?: { from: number; frets?: number; vertical?: boolean }
}

export interface FretboardOptions {
	/** Tuning as MIDI notes, highest string first (default standard). */
	tuning?: number[]
	onTap?: (string: number, fret: number, midi: number) => void
	/** Full vertical neck: the screen height frets 0–15 should fill (the view knows its layout). */
	fill?: () => number
	/** Redraw the last spec when the settings change (left-handed, board
	 * theme…). For necks whose view does not re-render on Settings.subscribe
	 * itself, e.g. a page of chord diagrams; call destroy() when dropping one. */
	autoRender?: boolean
}

export interface Fretboard {
	render(spec: NeckSpec): void
	/** Lights the heard note everywhere and the played-back one outside dimmed cells. */
	light(heard: number | null, playing?: number | null): void
	/** Brings the position box into view (page scroll when vertical, board scroll when horizontal). */
	revealBox(): void
	/** Stops the autoRender subscription. */
	destroy(): void
}

const INLAYS = [3, 5, 7, 9, 12, 15, 17, 19, 21]

/* Neck geometry (SVG user units ≈ CSS px on a desktop) -------------------- */
// Frets sit where a real guitar puts them: fret n at scale × (1 − 2^(−n/12)),
// so they narrow up the neck. Along = distance from the open-string column,
// across = string index (0 = high E). Horizontal draws along → x, high E on
// top like tab; vertical draws along → y, low E on the left like a chord
// diagram. 820 units over 22 frets leave fret 15 27 wide (the mockup's
// proportions) and fret 22 18 wide, where dots shrink a little to fit.
const OPEN = 30 // room for open-string notes before the nut
const LENGTH = 820
const SPACING = { h: 28, v: 36 }
const MARGIN = { h: 14, v: 34 } // first string from the edge; v leaves room for fret numbers
const DOT_R = 10
const ROOT_R = 11
// Vertical: drawn 1:1 with EQUAL fret spacing (it reads like a chord chart;
// users found narrowing frets odd top to bottom), frets 0–15 exactly filling
// the screen height left by everything that shares it (the view's `fill`),
// the rest continuing below the fold.
// On phones the strings spread across the board's width. On a short screen
// dots shrink to their fret (never below MIN_R) and labels with them (never
// below MIN_FONT). Horizontal keeps real fret spacing and, on phones, scrolls.
const SCREEN_FRETS = 15
const EDGE = 24 // past the high E, room for its dots
const MIN_R = 6
const MIN_FONT = 9
// Chord diagrams: a small fixed grid, drawn 1:1, sized like a printed chord
// chart (strings 20 apart, frets 26 long) so dots of radius 8.5 clear their
// neighbours.
const CHORD = { spacing: 20, fret: 26, open: 22, r: 8.5, margin: 34, edge: 18, fingers: 18 }

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

/** A chord window: frets `from`…`from + frets − 1` equally spaced after the open row. */
function windowGeometry(from: number, frets: number) {
	const { open, fret: size } = CHORD
	const fretAt = (n: number) => open + (n - from + 1) * size
	const noteAlong = (fret: number) => (fret === 0 ? open / 2 : fretAt(fret) - size / 2)
	const halfCell = (fret: number) => (fret === 0 ? open / 2 : size / 2)
	return { length: fretAt(from + frets - 1) + 6, open, fretAt, noteAlong, halfCell }
}

const phone = matchMedia('(max-width: 600px)')

// Labels and names come from callers: keep them text inside the markup.
const esc = (text: string) => text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)

export function createFretboard(svg: SVGSVGElement, board: HTMLElement | null, options: FretboardOptions = {}): Fretboard {
	const tuning = options.tuning ?? STRINGS
	const last = tuning.length - 1
	let heard: number | null = null
	let playing: number | null = null
	let laidOut = ''
	let lastSpec: NeckSpec | null = null
	// Only these settings change how a given spec is drawn; every other one
	// (metronome volume, a trainer option…) must not redraw a page of diagrams.
	const lookOf = () => {
		const { leftHanded, fretboardTheme, fretboardVertical, fretSize } = Settings.get()
		return `${leftHanded}|${fretboardTheme}|${fretboardVertical}|${fretSize}`
	}
	let drawnLook = ''
	const unsubscribe = options.autoRender
		? Settings.subscribe(() => lastSpec && lookOf() !== drawnLook && render(lastSpec))
		: () => {}
	const interactive = Boolean(options.onTap)

	// Taps (and Enter/Space on a focused note). A tap that re-renders the neck
	// keeps focus on the same note.
	function onCell(target: EventTarget | null) {
		const cell = (target as Element | null)?.closest<SVGGElement>('[data-s]')
		if (!cell || !options.onTap) return
		const string = Number(cell.dataset.s)
		const fret = Number(cell.dataset.f)
		options.onTap(string, fret, Number(cell.dataset.midi))
		if (!cell.isConnected) svg.querySelector<SVGGElement>(`[data-s="${string}"][data-f="${fret}"]`)?.focus()
	}
	svg.addEventListener('click', (event) => onCell(event.target))
	svg.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return
		event.preventDefault()
		onCell(event.target)
	})

	// Equal frets: stretch the screen's 0–15 to the full 0–22 neck.
	function fillLength() {
		if (!options.fill) return LENGTH
		return Math.round(OPEN + 6 + ((options.fill() - OPEN) * FRETS) / SCREEN_FRETS)
	}

	function applyLit() {
		for (const cell of svg.querySelectorAll<SVGGElement>('[data-s]')) {
			const midi = Number(cell.dataset.midi)
			const lit = midi === heard || (midi === playing && !cell.classList.contains('cell--dim'))
			cell.classList.toggle('cell--lit', lit)
		}
	}

	function render(spec: NeckSpec, length?: number) {
		lastSpec = spec
		drawnLook = lookOf()
		const { fretboardVertical, fretSize: size, fretboardTheme, leftHanded } = Settings.get()
		const win = spec.window
		const vertical = win ? win.vertical !== false : fretboardVertical
		// Measured before anything is resized (see the scroll handling below).
		const layout = `${vertical}${leftHanded}`
		const shown = Boolean(board?.clientWidth) && !win
		const fromRight = shown && leftHanded && !vertical && layout === laidOut ? board!.scrollWidth - board!.scrollLeft - board!.clientWidth : null
		const o = vertical ? 'v' : 'h'
		// The board palette: on the board, or on a chord diagram's own svg.
		const themed = board ?? svg
		if (fretboardTheme === 'auto') delete themed.dataset.theme
		else themed.dataset.theme = fretboardTheme

		const boardWidth = board ? board.clientWidth - parseFloat(getComputedStyle(board).paddingLeft) * 2 : 0
		const spacingV = win ? CHORD.spacing : phone.matches ? Math.max(SPACING.v, (boardWidth - MARGIN.v - EDGE) / 5) : SPACING.v
		const spacing = win ? CHORD.spacing : vertical ? spacingV : SPACING.h
		const margin = win ? (vertical ? CHORD.margin : CHORD.edge) : MARGIN[o]
		// Fret size setting: scales the neck's length (frets' height when vertical,
		// width when horizontal) at constant dot size. Above 1 a vertical neck
		// just grows and the page scrolls (one scrollbar, not two); a horizontal
		// one scrolls sideways in its board. Below 1 dots shrink with their frets.
		const fill = !win && vertical ? fillLength() : null
		const base = length ?? fill ?? LENGTH
		// Phones, horizontal: drawn 1:1 (so MIN_R / MIN_FONT are real pixels)
		// and scrolling; a neck within 10 % of the board's width just fits it,
		// since a few px of scroll is a scrollbar for nothing.
		const phoneWidth = !win && !vertical && phone.matches ? (LENGTH * size <= boardWidth * 1.1 ? boardWidth : LENGTH * size) : null
		const g = win ? windowGeometry(win.from, win.frets ?? 4) : geometry(Math.round(phoneWidth ?? base * size), OPEN, vertical)
		const { fretAt, noteAlong, halfCell } = g
		const first = win ? win.from : 1
		const lastFret = win ? win.from + (win.frets ?? 4) - 1 : FRETS
		const fingerRow = win && spec.dots.some((d) => d.finger && d.fret >= win.from) ? CHORD.fingers : 0
		const width = vertical ? margin + last * spacing + (win ? CHORD.edge : EDGE) : g.length + fingerRow
		const height = vertical ? g.length + fingerRow : margin + last * spacing + 30

		// Left-handed: mirror x, which puts the nut on the right of a horizontal
		// neck and the low string on the right of a vertical one. Only
		// coordinates move, so the text stays readable.
		const X = (x: number) => (leftHanded ? width - x : x)
		const across = (a: number) => margin + (vertical ? last - a : a) * spacing
		// Fixed distances past the outer strings, whatever the string spacing:
		// wires, nut and position box reach 14 units out, fret numbers sit 22 out.
		const out = 14 / spacing
		const numAt = last + 22 / spacing
		const xy = (along: number, a: number) => (vertical ? [X(across(a)), along] : [X(along), across(a)])
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

		svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
		svg.classList.toggle('neck--vertical', vertical)
		svg.classList.toggle('neck--chord', Boolean(win))
		svg.classList.toggle('neck--left', leftHanded)
		// A diagram nobody taps is one picture to assistive tech, not ~30 buttons.
		if (spec.label) {
			svg.setAttribute('role', interactive ? 'group' : 'img')
			svg.setAttribute('aria-label', spec.label)
		}
		// Vertical and chord diagrams are drawn 1:1 (inline size beats the
		// stylesheet's width: 100%). Horizontal on wider screens: the rendered
		// width grows with the length, so dots keep their size.
		svg.style.width = vertical || win ? `${width}px` : phoneWidth ? `${g.length}px` : size === 1 ? '' : `${100 * size}%`
		svg.style.height = vertical || win ? `${height}px` : ''

		const box = spec.box ?? null
		const dots = new Map(spec.dots.map((d) => [`${d.string}-${d.fret}`, d]))
		const noteName = spec.noteName ?? ((midi: number) => ROOTS[midi % 12])
		const parts: string[] = []

		// Chord diagrams leave the inlays out: they would sit under the dots.
		for (const fret of win ? [] : INLAYS) {
			const at = noteAlong(fret)
			const spots = fret === 12 ? [1.5, 3.5] : [2.5]
			for (const a of spots) parts.push(`<circle class="neck__inlay" ${pt(at, a, 'c')} r="4"/>`)
			// Fret numbers beyond the low E: under the neck, or left of it when vertical.
			parts.push(`<text class="neck__num" ${pt(at, numAt)}>${fret}</text>`)
		}
		// Wires and nut run half a string space past the outer strings.
		for (let fret = first; fret <= lastFret; fret++) parts.push(`<line class="neck__fret" ${line(fretAt(fret), -out, fretAt(fret), last + out)}/>`)
		const top = fretAt(first - 1)
		if (first === 1) parts.push(`<line class="neck__nut" ${line(top, -out, top, last + out)}/>`)
		else parts.push(`<line class="neck__fret" ${line(top, -out, top, last + out)}/>`)
		// Thicker toward the low E, like real gauges (.010–.046): 0.7 to 2.4.
		tuning.forEach((_, s) => parts.push(`<line class="neck__string" style="stroke-width:${0.7 + s * 0.34}" ${line(top, s, win ? fretAt(lastFret) : g.length, s)}/>`))
		if (box) {
			const from = box[0] === 0 ? 2 : fretAt(box[0] - 1) + 1
			const to = fretAt(box[1]) - 1
			parts.push(`<rect class="neck__box" ${rect(from, -out, to, last + out)} rx="6"/>`)
		}
		if (win) {
			// "5fr" beside the first fret when the window does not start at the nut.
			if (first > 1) parts.push(`<text class="neck__num" ${pt(noteAlong(first), last + 20 / spacing)}>${first}fr</text>`)
			for (const b of spec.barres ?? []) {
				const r = CHORD.r
				const at = noteAlong(b.fret)
				const lo = Math.min(b.from, b.to)
				const hi = Math.max(b.from, b.to)
				parts.push(`<rect class="neck__barre" ${rect(at - r, lo - r / spacing, at + r, hi + r / spacing)} rx="${r}"/>`)
			}
			spec.strings?.forEach((mark, s) => {
				if (mark === 'open' && !dots.has(`${s}-0`)) parts.push(`<circle class="neck__open" ${pt(noteAlong(0), s, 'c')} r="5" aria-hidden="true"/>`)
				if (mark === 'muted') parts.push(`<text class="neck__muted" ${pt(noteAlong(0), s)} aria-hidden="true">×</text>`)
			})
			for (const d of spec.dots) {
				if (d.finger && d.fret >= first && d.fret <= lastFret)
					parts.push(`<text class="neck__finger" ${pt(g.length + fingerRow / 2 - 3, d.string)} aria-hidden="true">${d.finger}</text>`)
			}
		}

		tuning.forEach((open, s) => {
			const frets = win ? [0, ...Array.from({ length: lastFret - first + 1 }, (_, i) => first + i)] : Array.from({ length: FRETS + 1 }, (_, i) => i)
			for (const fret of frets) {
				const midi = open + fret
				const dot = dots.get(`${s}-${fret}`)
				// A chord diagram draws only its dots (nothing to tap or light elsewhere).
				if (win && !dot) continue
				const name = esc(noteName(midi))
				const isMarked = Boolean(dot && (dot.marked || dot.role === 'marked'))
				const classes = ['cell']
				if (dot) classes.push('cell--dot')
				if (dot && dot.role !== 'marked') classes.push(dot.role === 'note' ? 'cell--scale' : `cell--${dot.role}`)
				if (isMarked) classes.push('cell--marked')
				if ((box && (fret < box[0] || fret > box[1])) || dot?.dimmed) classes.push('cell--dim')
				const label = dot ? esc(dot.label) : spec.emptyLabels === false ? '' : name
				const at = noteAlong(fret)
				const half = halfCell(fret)
				const full = win ? CHORD.r : dot?.role === 'root' ? ROOT_R : DOT_R
				const r = Math.max(MIN_R, Math.min(full, half + 0.4))
				const font = r < full ? `style="font-size:${Math.max(MIN_FONT, r * 1.15).toFixed(1)}px"` : ''
				const focusable = spec.toggles || dot !== undefined
				// Buttons only when a tap does something; otherwise the svg's label speaks for it.
				const button = interactive
					? ` role="button" tabindex="${focusable ? 0 : -1}"` +
						` aria-label="${ROOTS[open % 12]} string, ${fret === 0 ? 'open' : `fret ${fret}`}, ${name}${dot?.detail ? ` (${esc(dot.detail)})` : ''}"` +
						(spec.toggles ? ` aria-pressed="${isMarked}"` : '')
					: ''
				parts.push(
					`<g class="${classes.join(' ')}" data-s="${s}" data-f="${fret}" data-midi="${midi}"${button}` +
						`><rect class="cell__hit" ${rect(at - half, s - 0.5, at + half, s + 0.5)}/>` +
						`<circle ${pt(at, s, 'c')} r="${r}"/>` +
						`<text ${pt(at, s)} ${font}>${label}</text></g>`
				)
			}
		})
		// A left-handed horizontal neck starts at the nut, now on the right, and
		// keeps its distance from the right edge when it is redrawn wider or
		// narrower (fret size, phone breakpoint), so the nut stays in view.
		// Only once it is on screen (a hidden board has no scroll width).
		svg.innerHTML = parts.join('')
		applyLit()
		if (shown && layout !== laidOut) {
			if (!vertical) board!.scrollLeft = leftHanded ? board!.scrollWidth : 0
			laidOut = layout
		} else if (fromRight !== null) board!.scrollLeft = board!.scrollWidth - board!.clientWidth - fromRight
		// The board's padding and the view's layout were measured around the
		// previous drawing; if the fill is off (first vertical draw, a scrollbar
		// gone), draw once more at the corrected length.
		if (fill && length === undefined) {
			const want = fillLength()
			if (Math.abs(want - fill) > 1) render(spec, want)
		}
	}

	return {
		render: (spec) => render(spec),

		light(heardMidi, playingMidi = null) {
			if (heardMidi === heard && playingMidi === playing) return
			heard = heardMidi
			playing = playingMidi
			applyLit()
		},

		revealBox() {
			const boxEl = svg.querySelector('.neck__box')
			if (boxEl && svg.classList.contains('neck--vertical')) return boxEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
			const box = boxEl?.getBoundingClientRect()
			if (box && board) {
				const view = board.getBoundingClientRect()
				board.scrollBy({ left: box.left + box.width / 2 - (view.left + view.width / 2), behavior: 'smooth' })
			}
		},

		destroy: unsubscribe,
	}
}
