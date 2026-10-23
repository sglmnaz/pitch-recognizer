// The tab turned upright, for phones (docs/adr/0013): strings as lanes, thick
// low E on the left, the notes as tokens with the fret falling onto a red line
// with a target per string; a tail behind a note shows how long it rings. Only
// the layer of notes moves (one transform), as on the horizontal strip.
// `createScoreScreen` puts one or more of these full screen (Trainer → Tab and
// Songs): a row on top, the scores in a carousel, a row of keys at the bottom.
import { t } from '../core/i18n'
import { noteName } from '../music/note-names'

export interface ScoreNote {
	/** Start and length, in the score's units (quarters, steps…). */
	at: number
	length: number
	/** 1 = the highest string. */
	string: number
	label: string
	/** h, p, /, T… shown beside the token. */
	tech?: string
	/** The fret bent to, shown after the token. */
	bentTo?: number
}

export interface ScoreSpec {
	notes: ScoreNote[]
	/** Where each bar starts (units) and its number. */
	bars: { at: number; label: string }[]
	sections?: { at: number; text: string }[]
	/** Open-string MIDI notes, string 1 first. */
	tuning: number[]
	/** Paper per unit, px. */
	unitPx: number
}

const LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
// The strings sit between these (% of the width), equal margins: the score is centred.
const LEFT = 12
const RIGHT = 88
// Thickest (lowest string) and thinnest, px.
const THICK = 3.4
const THIN = 1
// A bar line sits this far before its first beat, as on the horizontal strip.
const BAR_LEAD = 0.25

/** One score in `root` (an empty element): draw(spec), then place(at) every frame; setSide(on) turns it on its side. */
export function createVerticalScore(root: HTMLElement) {
	root.classList.add('vscore')
	root.innerHTML = '<div class="vscore__fixed"></div><div class="vscore__layer"></div><span class="vscore__fade"></span><div class="vscore__names"></div>'
	const fixed = root.querySelector<HTMLElement>('.vscore__fixed')!
	const layer = root.querySelector<HTMLElement>('.vscore__layer')!
	const names = root.querySelector<HTMLElement>('.vscore__names')!
	let unitPx = 64
	let side = false
	let drawn: ScoreSpec | null = null
	let placed: [number, boolean] = [0, false]
	let sounding: { at: number; length: number; el: HTMLElement; tail?: HTMLElement }[] = []
	let lit: { el: HTMLElement; tail?: HTMLElement }[] = []
	let barEls: { at: number; el: HTMLElement }[] = []
	let litBar: HTMLElement | null = null

	const span = (parent: HTMLElement, cls: string, style: string, text = '') => {
		const el = document.createElement('span')
		el.className = cls
		el.setAttribute('style', style)
		el.textContent = text
		parent.append(el)
		return el
	}

	function draw(spec: ScoreSpec) {
		drawn = spec
		unitPx = spec.unitPx
		const strings = spec.tuning.length
		// Upright: low E on the left; on its side: high E on top, as in a tab.
		const across = (string: number) => {
			const x = strings < 2 ? 50 : LEFT + ((strings - string) * (RIGHT - LEFT)) / (strings - 1)
			return side ? 100 - x : x
		}
		// A string's place across, `at` units along (later = higher, or further right), and their sizes.
		const at = (string: number, units: number) =>
			side ? `top:${across(string)}%;left:${units * unitPx}px` : `left:${across(string)}%;top:${-units * unitPx}px`
		const along = (units: number) => (side ? `left:${units * unitPx}px` : `top:${-units * unitPx}px`)
		const acrossOnly = (string: number) => `${side ? 'top' : 'left'}:${across(string)}%`
		const thick = side ? 'height' : 'width'
		fixed.replaceChildren()
		names.replaceChildren()
		layer.replaceChildren()
		const lane = (RIGHT - LEFT) / Math.max(1, strings - 1)
		for (let s = strings; s >= 1; s--) span(fixed, 'vscore__lane', `${acrossOnly(s)};${thick}:${lane}%`)
		for (let s = strings; s >= 1; s--) {
			const width = THIN + ((THICK - THIN) * (s - 1)) / Math.max(1, strings - 1)
			span(fixed, 'vscore__string', `${acrossOnly(s)};${thick}:${width.toFixed(1)}px`)
			span(fixed, 'vscore__target', acrossOnly(s))
			span(names, '', acrossOnly(s), noteName(LETTERS[spec.tuning[s - 1] % 12]))
		}
		span(fixed, 'vscore__line', '')
		barEls = spec.bars.map((bar) => {
			span(layer, 'vscore__bar', along(bar.at - BAR_LEAD))
			return { at: bar.at, el: span(layer, 'vscore__barno', along(bar.at - BAR_LEAD), bar.label) }
		})
		litBar = null
		for (const section of spec.sections ?? []) span(layer, 'vscore__section', along(section.at - BAR_LEAD), section.text)
		sounding = spec.notes.map((note) => {
			// A tail behind notes longer than an eighth's room: how long they ring.
			const long = note.length * unitPx > 40
			const tail = long
				? span(layer, 'vscore__tail', `${at(note.string, side ? note.at : note.at + note.length)};${side ? 'width' : 'height'}:${note.length * unitPx}px`)
				: undefined
			const el = span(layer, 'vscore__n', at(note.string, note.at), note.label)
			if (note.bentTo !== undefined) span(el, 'vscore__bend', '', `b${note.bentTo}`)
			if (note.tech) span(layer, 'vscore__tech', at(note.string, side ? note.at : note.at + 0.12), note.tech)
			return { at: note.at, length: note.length, el, tail }
		})
		sounding.sort((a, b) => a.at - b.at)
		lit = []
	}

	/** Puts unit `at` on the line, lights what sounds there (`playing`) and the bar's number. */
	function place(at: number, playing: boolean) {
		placed = [at, playing]
		layer.style.transform = side ? `translateX(${(-at * unitPx).toFixed(1)}px)` : `translateY(${(at * unitPx).toFixed(1)}px)`
		// The notes struck last at or before `at`, all of a chord, while they ring.
		let lo = 0
		let hi = sounding.length - 1
		let found = -1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (sounding[mid].at <= at + 1e-6) {
				found = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		const now: typeof lit = []
		if (playing && found >= 0) {
			const struck = sounding[found].at
			for (let i = found; i >= 0 && Math.abs(sounding[i].at - struck) < 1e-6; i--)
				if (at < sounding[i].at + Math.max(sounding[i].length, 0.25)) now.push(sounding[i])
		}
		if (now.length !== lit.length || now.some((n) => !lit.includes(n))) {
			for (const n of lit) {
				n.el.classList.remove('is-now')
				n.tail?.classList.remove('is-now')
			}
			for (const n of now) {
				n.el.classList.add('is-now')
				n.tail?.classList.add('is-now')
			}
			lit = now
		}
		let bar: HTMLElement | null = null
		for (const b of barEls) if (b.at <= at + 1e-6) bar = b.el
		if (bar !== litBar) {
			litBar?.classList.remove('is-now')
			bar?.classList.add('is-now')
			litBar = bar
		}
	}

	/** On its side (the phone turned): strings across, notes coming from the right. */
	function setSide(on: boolean) {
		if (on === side) return
		side = on
		root.classList.toggle('vscore--side', on)
		if (drawn) {
			draw(drawn)
			place(...placed)
		}
	}

	return { draw, place, setSide }
}

export type VerticalScore = ReturnType<typeof createVerticalScore>

export interface ScoreScreenKey {
	/** The key, made by the view (it wires it and keeps its label and state). */
	el: HTMLButtonElement
	/** Share of the bottom row's width. */
	grow?: number
}

/**
 * The full-screen page: ✕ to leave, the track's name with a lamp per score (the
 * carousel scrolls natively, by swipe or ◂ ▸), a small display, the scores, the
 * keys. Android's Back leaves it too (a history entry while open). ↻ lays the
 * page on its side.
 */
export function createScoreScreen(keys: ScoreScreenKey[], onClose: () => void) {
	const root = document.createElement('div')
	root.className = 'score-screen'
	root.hidden = true
	root.setAttribute('role', 'dialog')
	root.setAttribute('aria-modal', 'true')
	root.innerHTML =
		'<div class="score-screen__top"><button class="key key--step score-screen__close" type="button">✕</button>' +
		'<button class="key key--step score-screen__turn" type="button">↻</button>' +
		'<div class="score-screen__track"><span class="score-screen__name"><button class="score-screen__prev" type="button">◂</button><b></b><button class="score-screen__next" type="button">▸</button></span><span class="score-screen__pager"></span></div>' +
		'<span class="window"><span class="lcd score-screen__lcd"></span></span></div>' +
		'<div class="score-screen__rail"></div><div class="score-screen__keys"></div>'
	document.body.append(root)
	const close = root.querySelector<HTMLButtonElement>('.score-screen__close')!
	const turnKey = root.querySelector<HTMLButtonElement>('.score-screen__turn')!
	const prev = root.querySelector<HTMLButtonElement>('.score-screen__prev')!
	const next = root.querySelector<HTMLButtonElement>('.score-screen__next')!
	const name = root.querySelector<HTMLElement>('.score-screen__name b')!
	const pager = root.querySelector<HTMLElement>('.score-screen__pager')!
	const lcd = root.querySelector<HTMLElement>('.score-screen__lcd')!
	const rail = root.querySelector<HTMLElement>('.score-screen__rail')!
	const keyRow = root.querySelector<HTMLElement>('.score-screen__keys')!
	close.setAttribute('aria-label', t('Leave full screen'))
	turnKey.setAttribute('aria-label', t('Turn the score'))
	prev.setAttribute('aria-label', t('Track before'))
	next.setAttribute('aria-label', t('Next track'))
	keyRow.style.gridTemplateColumns = keys.map((k) => `${k.grow ?? 1}fr`).join(' ')
	keyRow.append(...keys.map((k) => k.el))

	let scores: VerticalScore[] = []
	let titles: string[] = []
	let lamps: HTMLElement[] = []
	let shown = 0
	let pushed = false
	// On its side: the viewport is landscape (a browser tab), or ↻ turns the page a
	// quarter in CSS. The installed app is held upright by its manifest, and unlocking it
	// needs the browser's own full screen, which shows a banner: the player turns it by hand.
	const landscape = matchMedia('(orientation: landscape)')
	let quarter: 0 | 90 = 0
	function turn() {
		const turned = quarter !== 0 && !landscape.matches
		const side = landscape.matches || turned
		root.classList.toggle('score-screen--side', side)
		root.classList.toggle('score-screen--turned', turned)
		// The page a quarter round, as tall as the screen is wide.
		root.style.cssText = turned ? `width:${innerHeight}px;height:${innerWidth}px;transform:translateX(${innerWidth}px) rotate(90deg)` : ''
		turnKey.hidden = landscape.matches
		for (const score of scores) score.setSide(side)
		showTrack()
	}
	landscape.addEventListener('change', () => {
		if (!root.hidden) turn()
	})
	addEventListener('resize', () => {
		if (!root.hidden && quarter) turn()
	})
	turnKey.addEventListener('click', () => {
		quarter = quarter ? 0 : 90
		turn()
	})
	/** The score in view: the one whose panel covers the rail's middle. */
	function showTrack() {
		const panel = rail.firstElementChild as HTMLElement | null
		const step = panel ? panel.offsetWidth + 10 : 1
		const index = Math.max(0, Math.min(scores.length - 1, Math.round(rail.scrollLeft / step)))
		shown = index
		name.textContent = titles[index] ?? ''
		lamps.forEach((lamp, i) => lamp.classList.toggle('is-on', i === index))
		const several = scores.length > 1
		prev.hidden = next.hidden = !several
		pager.hidden = !several
	}
	rail.addEventListener('scroll', showTrack, { passive: true })
	const go = (by: number) => {
		const panel = rail.firstElementChild as HTMLElement | null
		if (panel) rail.scrollTo({ left: (shown + by) * (panel.offsetWidth + 10), behavior: 'smooth' })
	}
	prev.addEventListener('click', () => go(-1))
	next.addEventListener('click', () => go(1))

	function hide(fromHistory = false) {
		if (root.hidden) return
		root.hidden = true
		document.documentElement.classList.remove('has-score-screen')
		quarter = 0
		turn()
		if (pushed && !fromHistory) history.back()
		pushed = false
		onClose()
	}
	close.addEventListener('click', () => hide())
	window.addEventListener('popstate', () => {
		if (pushed) {
			pushed = false
			hide(true)
		}
	})

	return {
		/** One score per title (a track each); returns them to draw and place. */
		setScores(names: string[]): VerticalScore[] {
			titles = names
			rail.replaceChildren(
				...names.map(() => {
					const panel = document.createElement('div')
					panel.className = 'window score-screen__panel'
					panel.append(document.createElement('div'))
					return panel
				})
			)
			scores = [...rail.querySelectorAll<HTMLElement>('.score-screen__panel > div')].map((el) => createVerticalScore(el))
			pager.replaceChildren(
				...(lamps = names.map(() => {
					const lamp = document.createElement('span')
					lamp.className = 'lamp'
					return lamp
				}))
			)
			rail.scrollLeft = 0
			for (const score of scores) score.setSide(root.classList.contains('score-screen--side'))
			showTrack()
			return scores
		},
		setText(text: string) {
			if (lcd.textContent !== text) lcd.textContent = text
		},
		open() {
			if (!root.hidden) return
			root.hidden = false
			document.documentElement.classList.add('has-score-screen')
			history.pushState({ scoreScreen: true }, '')
			pushed = true
			turn()
		},
		close: () => hide(),
		isOpen: () => !root.hidden,
	}
}

export type ScoreScreen = ReturnType<typeof createScoreScreen>
