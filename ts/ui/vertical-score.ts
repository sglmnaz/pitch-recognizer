// The tab turned upright, for phones (docs/adr/0013): strings as lanes, thick
// low E on the left, the notes as tokens with the fret falling onto a red line
// with a target per string; a tail behind a note shows how long it rings. Only
// the layer of notes moves (one transform), as on the horizontal strip.
// `createScoreScreen` puts one or more of these full screen (Trainer → Tab and
// Songs): a row on top, the scores in a carousel, a row of keys at the bottom.
import { t } from '../core/i18n'
import { readString, writeString } from '../core/storage'
import { onPress } from './tempo'
import { noteName } from '../music/note-names'

export interface ScoreNote {
	/** Start and length, in the score's units (quarters, steps…). */
	at: number
	length: number
	/** 1 = the highest string. */
	string: number
	label: string
	/** h p (legato), / \ (slide): joined to the note before on its string; T (tap) beside the token. */
	tech?: string
	/** The fret bent to: an arrow from the token to it. */
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
// A drag along the score goes twice as far once the finger has moved this many px, three times at twice that.
const SCRUB_PX = 80
// Where the full-screen page remembers the way it was last turned.
const TURN_KEY = 'pitch-recognizer:score-turn'
// The tempo keys of the full-screen page step this much (BPM in Tab, % of speed in Songs).
const TEMPO_STEP = 5
// Marks between two notes of a string (approved mock-up Segni 2, "game"): legato, slide.
const LEGATO = ['h', 'p']
const SLIDE = ['/', '\\']
const joins = (tech?: string) => !!tech && (LEGATO.includes(tech) || SLIDE.includes(tech))
// A token (one size for every note: 34 px read large, a mix with 20 px ones looked uneven),
// its radius, and the room two notes of a string need: apart, and with a mark between them.
const TOKEN_PX = 26
const R = TOKEN_PX / 2
const APART_PX = 30
const JOINED_PX = 42
// The pairs the spacing must serve: all but the closest tenth (grace notes, a strum written as
// notes a hair apart once made the score run kilometres per bar).
const SERVED = 0.9
// A bar with closer notes gets its own room (up to this per unit), the others keep the
// pace; only notes closer than GRACE (units: a 16th of a quarter, grace notes) may overlap.
const BAR_MOST_PX = 300
const GRACE = 1 / 16
const SVG = 'http://www.w3.org/2000/svg'
// Two notes are joined only if the first rings into the second (up to this times its length):
// a slide into a note from nowhere (Guitar Pro's slide-in) had no note to start from, and was
// drawn from one bars before.
const RINGS_INTO = 1.5
/** Whether `note` (a legato or slide) starts from `before`, the note before it on its string. */
export const joinsFrom = (before: { at: number; length: number }, note: { at: number }) =>
	before.at < note.at && note.at - before.at <= Math.max(before.length, 0.01) * RINGS_INTO + 1e-6

/**
 * Paper per unit so the tokens of a string stay apart (36 px) and a mark fits beside the
 * notes it joins (48 px), for nine pairs in ten, within `least` and `most`: past `most` the
 * notes would fly by too fast to read at 100%.
 */
export function unitPxFor(notes: ScoreNote[], least: number, most = Number.POSITIVE_INFINITY) {
	const needs: number[] = []
	const last = new Map<number, number>()
	for (const note of [...notes].sort((a, b) => a.at - b.at)) {
		const before = last.get(note.string)
		const gap = before === undefined ? 0 : note.at - before
		if (gap > 1e-6) needs.push((joins(note.tech) ? JOINED_PX : APART_PX) / gap)
		last.set(note.string, note.at)
	}
	needs.sort((a, b) => a - b)
	const need = needs.length ? needs[Math.floor(SERVED * (needs.length - 1))] : least
	return Math.min(most, Math.max(least, need))
}

interface Stop {
	/** Where a bar starts, in units and in px along; its px per unit. */
	at: number
	x: number
	px: number
}

/**
 * Each bar's scale: the score's own (spec.unitPx) or more where the bar's notes are closer,
 * so a fast run gets room without stretching the whole song (as Guitar Pro and Songsterr
 * size bars by what is in them); the score runs a little faster through such a bar.
 */
function barStops(spec: ScoreSpec): Stop[] {
	const starts = [...new Set(spec.bars.map((bar) => bar.at))].sort((a, b) => a - b)
	if (!starts.length || starts[0] > 0) starts.unshift(Math.min(0, starts[0] ?? 0))
	const need = starts.map(() => spec.unitPx)
	const barOf = (at: number) => {
		let i = 0
		while (i + 1 < starts.length && starts[i + 1] <= at + 1e-9) i++
		return i
	}
	const last = new Map<number, number>()
	for (const note of [...spec.notes].sort((a, b) => a.at - b.at)) {
		const before = last.get(note.string)
		const gap = before === undefined ? 0 : note.at - before
		if (gap >= GRACE) {
			const i = barOf(note.at)
			need[i] = Math.max(need[i], (joins(note.tech) ? JOINED_PX : APART_PX) / gap)
		}
		last.set(note.string, note.at)
	}
	const most = Math.max(spec.unitPx, BAR_MOST_PX)
	let x = 0
	return starts.map((at, i) => {
		if (i) x += (at - starts[i - 1]) * Math.min(most, need[i - 1])
		return { at, x, px: Math.min(most, need[i]) }
	})
}

/** One score in `root` (an empty element): draw(spec), then place(at) every frame; setSide(on) turns it on its side. */
export function createVerticalScore(root: HTMLElement) {
	root.classList.add('vscore')
	root.innerHTML = '<div class="vscore__fixed"></div><div class="vscore__layer"></div><span class="vscore__fade"></span><div class="vscore__names"></div>'
	const fixed = root.querySelector<HTMLElement>('.vscore__fixed')!
	const layer = root.querySelector<HTMLElement>('.vscore__layer')!
	const names = root.querySelector<HTMLElement>('.vscore__names')!
	let unitPx = 64
	let stops: Stop[] = []
	let side = false
	let drawn: ScoreSpec | null = null
	let placed: [number, boolean] = [0, false]
	let sounding: { at: number; length: number; el: HTMLElement; tail?: HTMLElement }[] = []
	let lit: { el: HTMLElement; tail?: HTMLElement }[] = []
	let barEls: { at: number; el: HTMLElement }[] = []
	let litBar: HTMLElement | null = null
	let band: { from: number; to: number; open: boolean } | null = null

	// Px along for a unit and back, on the bars' own scales.
	const stopAt = (key: 'at' | 'x', value: number) => {
		let lo = 0
		let hi = stops.length - 1
		let found = 0
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (stops[mid][key] <= value) {
				found = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		return stops[found] ?? { at: 0, x: 0, px: unitPx }
	}
	const px = (units: number) => {
		const stop = stopAt('at', units)
		return stop.x + (units - stop.at) * stop.px
	}
	const unitsAt = (x: number) => {
		const stop = stopAt('x', x)
		return stop.at + (x - stop.x) / stop.px
	}

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
		stops = barStops(spec)
		const strings = spec.tuning.length
		// Upright: low E on the left; on its side: high E on top, as in a tab.
		const across = (string: number) => {
			const x = strings < 2 ? 50 : LEFT + ((strings - string) * (RIGHT - LEFT)) / (strings - 1)
			return side ? 100 - x : x
		}
		// A string's place across, `at` units along (later = higher, or further right), and their sizes.
		const at = (string: number, units: number) => (side ? `top:${across(string)}%;left:${px(units)}px` : `left:${across(string)}%;top:${-px(units)}px`)
		const along = (units: number) => (side ? `left:${px(units)}px` : `top:${-px(units)}px`)
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
		// The note each legato or slide comes from: the one before on its string.
		const from = new Map<ScoreNote, ScoreNote>()
		const last = new Map<number, ScoreNote>()
		for (const note of [...spec.notes].sort((a, b) => a.at - b.at)) {
			const before = last.get(note.string)
			if (before && joins(note.tech) && joinsFrom(before, note)) from.set(note, before)
			last.set(note.string, note)
		}
		const leadsOn = new Set(from.values())
		// A mark drawn in px from a token: u along (later), v across toward the high strings,
		// turned back near the edge where the high strings leave no room.
		const mark = (note: ScoreNote) => {
			const el = document.createElementNS(SVG, 'svg')
			el.setAttribute('class', 'vscore__mark')
			el.setAttribute('style', at(note.string, note.at))
			layer.append(el)
			const toEdge = side ? across(note.string) < 30 : across(note.string) > 70
			const dir = toEdge ? -1 : 1
			const xy = (u: number, v: number): [number, number] => (side ? [u, -v * dir] : [v * dir, -u])
			const p = (u: number, v: number) => xy(u, v).join(' ')
			const path = (cls: string, d: string) => {
				const shape = document.createElementNS(SVG, 'path')
				shape.setAttribute('class', cls)
				shape.setAttribute('d', d)
				el.append(shape)
			}
			const text = (u: number, v: number, words: string) => {
				const label = document.createElementNS(SVG, 'text')
				const [x, y] = xy(u, v)
				label.setAttribute('x', String(x))
				label.setAttribute('y', String(y))
				label.textContent = words
				el.append(label)
			}
			return { p, path, text, dir }
		}
		sounding = spec.notes.map((note) => {
			// A tail behind notes longer than an eighth's room: how long they ring (a note
			// that goes on into a legato or slide has the mark's band instead).
			const rings = px(note.at + note.length) - px(note.at)
			const long = rings > 40 && !leadsOn.has(note)
			const tail = long
				? span(layer, 'vscore__tail', `${at(note.string, side ? note.at : note.at + note.length)};${side ? 'width' : 'height'}:${rings}px`)
				: undefined
			const before = from.get(note)
			// Not picked (hammered, pulled, slid into): the token hollow.
			const el = span(layer, before ? 'vscore__n vscore__n--soft' : 'vscore__n', at(note.string, note.at), note.label)
			if (before) {
				const { p, path, text } = mark(before)
				const run = px(note.at) - px(before.at)
				path('band', `M${p(R, 0)} L${p(run - R, 0)}`)
				if (LEGATO.includes(note.tech!)) {
					// A slur beside the two tokens, H or P at its top.
					path('ink', `M${p(4, 18)} Q${p(run / 2, 38)} ${p(run - 4, 18)}`)
					text(run / 2, 44, note.tech!)
				} else {
					// A straight line slanting the way the hand goes, SL beside it.
					const d = note.tech === '/' ? 7 : -7
					path('ink slide', `M${p(R + 2, -d)} L${p(run - R - 2, d)}`)
					text(run / 2, 26, 'sl')
				}
			} else if (note.tech && SLIDE.includes(note.tech)) {
				// Slid into from nowhere: a short slanting line into the token.
				const { p, path } = mark(note)
				const d = note.tech === '/' ? 7 : -7
				path('ink slide', `M${p(-R - 26, -d)} L${p(-R - 3, d)}`)
			}
			if (note.bentTo !== undefined) {
				// A curved arrow toward the high strings, to the fret reached (a hollow token).
				const { p, path, dir } = mark(note)
				path('ink', `M${p(6, R - 2)} Q${p(52, 22)} ${p(58, 52)}`)
				path('head', `M${p(58, 60)} L${p(52, 46)} L${p(64, 46)}Z`)
				const off = 80 * dir
				span(
					layer,
					'vscore__n vscore__n--soft vscore__n--reached',
					side
						? `top:calc(${across(note.string)}% - ${off}px);left:${px(note.at) + 58}px`
						: `left:calc(${across(note.string)}% + ${off}px);top:${-(px(note.at) + 58)}px`,
					String(note.bentTo)
				)
			}
			if (note.tech === 'T') span(layer, 'vscore__tech', at(note.string, side ? note.at : note.at + 0.12), note.tech)
			return { at: note.at, length: note.length, el, tail }
		})
		sounding.sort((a, b) => a.at - b.at)
		lit = []
		showBand()
	}

	/** The A–B loop shaded, `from` to `to` in units; `open` while only one end is set; null: none. */
	function setBand(next: { from: number; to: number; open: boolean } | null) {
		band = next
		showBand()
	}
	function showBand() {
		layer.querySelector('.vscore__band')?.remove()
		if (!band) return
		const size = px(band.to) - px(band.from)
		const el = span(
			layer,
			band.open ? 'vscore__band is-open' : 'vscore__band',
			side ? `left:${px(band.from)}px;width:${size}px` : `top:${-px(band.to)}px;height:${size}px`
		)
		layer.prepend(el)
	}

	/** Puts unit `at` on the line, lights what sounds there (`playing`) and the bar's number. */
	function place(at: number, playing: boolean) {
		placed = [at, playing]
		layer.style.transform = side ? `translateX(${(-px(at)).toFixed(1)}px)` : `translateY(${px(at).toFixed(1)}px)`
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

	return {
		draw,
		place,
		setSide,
		setBand,
		/** Where the line stands, in units. */
		position: () => placed[0],
		/** The units `dx` px of paper move from unit `from` (on the bars' own scales). */
		units: (from: number, dx: number) => unitsAt(px(from) + dx) - from,
	}
}

export type VerticalScore = ReturnType<typeof createVerticalScore>

export interface ScoreScreenKey {
	/** The key, made by the view (it wires it and keeps its label and state). */
	el: HTMLButtonElement
	/** Share of the bottom row's width. */
	grow?: number
	/** 'top': upright in the row over the keys (before the tempo), on its side in the top bar. */
	place?: 'top'
}

/**
 * The full-screen page: ✕ to leave, the track's name with a lamp per score (the
 * carousel scrolls natively, by swipe or ◂ ▸), a small display, the scores, the
 * keys ('top' ones and the tempo ▼ ▲ in a row over the others when `onTempo` is given;
 * held, ▼ ▲ repeat). With `onScrub`
 * a drag along the strings moves through the song (units from where it began; `done`
 * on release); tracks change only by ◂ ▸. Android's
 * Back leaves it too (a history entry while open). ↻ lays the page on its side:
 * then a bar on top (✕ ↻ track display, the 'top' keys) and one under the score
 * (the other keys, the tempo).
 */
export function createScoreScreen(
	keys: ScoreScreenKey[],
	{ onClose, onTempo, onScrub }: { onClose: () => void; onTempo?: (by: number) => void; onScrub?: (units: number, done: boolean) => void }
) {
	const root = document.createElement('div')
	root.className = 'score-screen'
	root.hidden = true
	root.setAttribute('role', 'dialog')
	root.setAttribute('aria-modal', 'true')
	root.innerHTML =
		'<div class="score-screen__top"><button class="key key--step score-screen__close" type="button">✕</button>' +
		'<button class="key key--step score-screen__turn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.6 3.6v4.6H15"/></svg></button>' +
		'<div class="score-screen__track"><span class="score-screen__name"><button class="score-screen__prev" type="button">◂</button><b></b><button class="score-screen__next" type="button">▸</button></span><span class="score-screen__pager"></span></div>' +
		'<span class="window"><span class="lcd score-screen__lcd"><span></span><small></small></span></span></div>' +
		'<div class="score-screen__rail"></div>' +
		'<div class="score-screen__mid"></div><div class="score-screen__tempo"><button class="key key--step" type="button">▼</button><span class="window"><span class="lcd"><b></b><small></small></span></span><button class="key key--step" type="button">▲</button></div>' +
		'<div class="score-screen__keys"></div>'
	document.body.append(root)
	const close = root.querySelector<HTMLButtonElement>('.score-screen__close')!
	const turnKey = root.querySelector<HTMLButtonElement>('.score-screen__turn')!
	const prev = root.querySelector<HTMLButtonElement>('.score-screen__prev')!
	const next = root.querySelector<HTMLButtonElement>('.score-screen__next')!
	const name = root.querySelector<HTMLElement>('.score-screen__name b')!
	const pager = root.querySelector<HTMLElement>('.score-screen__pager')!
	const lcd = root.querySelector<HTMLElement>('.score-screen__lcd span')!
	const lcdSub = root.querySelector<HTMLElement>('.score-screen__lcd small')!
	const rail = root.querySelector<HTMLElement>('.score-screen__rail')!
	const keyRow = root.querySelector<HTMLElement>('.score-screen__keys')!
	const top = root.querySelector<HTMLElement>('.score-screen__top')!
	const tempo = root.querySelector<HTMLElement>('.score-screen__tempo')!
	const mid = root.querySelector<HTMLElement>('.score-screen__mid')!
	const [slower, faster] = tempo.querySelectorAll<HTMLButtonElement>('button')
	const tempoMain = tempo.querySelector('b')!
	const tempoSub = tempo.querySelector('small')!
	slower.setAttribute('aria-label', t('Slower'))
	faster.setAttribute('aria-label', t('Faster'))
	onPress(slower, () => onTempo?.(-TEMPO_STEP), true)
	onPress(faster, () => onTempo?.(TEMPO_STEP), true)
	close.setAttribute('aria-label', t('Leave full screen'))
	turnKey.setAttribute('aria-label', t('Turn the score'))
	prev.setAttribute('aria-label', t('Track before'))
	next.setAttribute('aria-label', t('Next track'))
	/** Upright: the 'top' keys and the tempo in a row over the others; on its side: the 'top' keys in the top bar, the tempo after the others. */
	function arrange(side: boolean) {
		const upper = keys.filter((k) => k.place === 'top').map((k) => k.el)
		const bottom = keys.filter((k) => k.place !== 'top')
		keyRow.replaceChildren(...bottom.map((k) => k.el))
		keyRow.style.gridTemplateColumns = bottom.map((k) => `${k.grow ?? 1}fr`).join(' ')
		if (!onTempo) tempo.remove()
		if (side) {
			top.append(...upper)
			if (onTempo) {
				keyRow.append(tempo)
				keyRow.style.gridTemplateColumns += ' auto'
			}
		} else mid.replaceChildren(...upper, ...(onTempo ? [tempo] : []))
		mid.hidden = side || !mid.childElementCount
	}
	arrange(false)

	let scores: VerticalScore[] = []
	let titles: string[] = []
	let lamps: HTMLElement[] = []
	let shown = 0
	let pushed = false
	// On its side: the viewport is landscape (a browser tab), or ↻ turns the page a
	// quarter in CSS. The installed app is held upright by its manifest, and unlocking it
	// needs the browser's own full screen, which shows a banner: the player turns it by hand.
	const landscape = matchMedia('(orientation: landscape)')
	// On its side unless the player last chose upright (most of the strip fits across the phone).
	let quarter: 0 | 90 = readString(TURN_KEY) === 'upright' ? 0 : 90
	function turn() {
		const turned = quarter !== 0 && !landscape.matches
		const side = landscape.matches || turned
		root.classList.toggle('score-screen--side', side)
		root.classList.toggle('score-screen--turned', turned)
		arrange(side)
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
		writeString(TURN_KEY, quarter ? 'side' : 'upright')
		turn()
	})
	/** One score shown, the track `shown`: its name and lamp. */
	function showTrack() {
		;[...rail.children].forEach((panel, i) => {
			;(panel as HTMLElement).hidden = i !== shown
		})
		name.textContent = titles[shown] ?? ''
		lamps.forEach((lamp, i) => lamp.classList.toggle('is-on', i === shown))
		const several = scores.length > 1
		prev.hidden = next.hidden = !several
		pager.hidden = !several
	}
	// Dragging the score moves through the song, as on paper: the finger takes the notes
	// along the strings (down upright, left on its side, where the song goes on).
	let drag: { x: number; y: number; id: number; moved: boolean; from: number } | null = null
	const dragged = (event: PointerEvent) => {
		const dx = event.clientX - drag!.x
		const dy = event.clientY - drag!.y
		// Turned a quarter in CSS, the page's x runs down the screen.
		const px = root.classList.contains('score-screen--side') ? -(root.classList.contains('score-screen--turned') ? dy : dx) : dy
		// Faster the further the finger goes: a short drag places a note, a long one skips bars
		// (300 px ≈ 4 bars, 600 px ≈ 13 at 96 px a quarter).
		return scores[0]?.units(drag!.from, px * (1 + Math.abs(px) / SCRUB_PX)) ?? 0
	}
	if (onScrub) {
		rail.classList.add('is-scrub')
		rail.addEventListener('pointerdown', (event) => {
			if (event.button !== 0 || drag) return
			drag = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false, from: scores[0]?.position() ?? 0 }
			// The moves keep coming when the finger leaves the score.
			try {
				rail.setPointerCapture(event.pointerId)
			} catch {}
		})
		rail.addEventListener('pointermove', (event) => {
			if (drag?.id !== event.pointerId) return
			// A tap is not a drag: 6 px before anything moves.
			if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return
			drag.moved = true
			onScrub(dragged(event), false)
		})
		const end = (event: PointerEvent) => {
			if (drag?.id !== event.pointerId) return
			const { moved } = drag
			const units = dragged(event)
			drag = null
			if (moved) onScrub(units, true)
		}
		rail.addEventListener('pointerup', end)
		rail.addEventListener('pointercancel', end)
	}
	// The next track round, the first after the last.
	const go = (by: number) => {
		shown = (shown + by + scores.length) % Math.max(1, scores.length)
		showTrack()
	}
	prev.addEventListener('click', () => go(-1))
	next.addEventListener('click', () => go(1))

	function hide(fromHistory = false) {
		if (root.hidden) return
		root.hidden = true
		document.documentElement.classList.remove('has-score-screen')
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
			shown = Math.min(shown, names.length - 1)
			for (const score of scores) score.setSide(root.classList.contains('score-screen--side'))
			showTrack()
			return scores
		},
		/** The display: a line, and a second one (the part of the song) under it upright, after it on its side. */
		setText(text: string, sub = '') {
			if (lcd.textContent !== text) lcd.textContent = text
			if (lcdSub.textContent !== sub) lcdSub.textContent = sub
		},
		/** The tempo's display (♩ = 96) and the line beside it (80 %); `enabled` false greys ▼ ▲. */
		setTempo(main: string, sub = '', enabled = true) {
			if (tempoMain.textContent !== main) tempoMain.textContent = main
			if (tempoSub.textContent !== sub) tempoSub.textContent = sub
			slower.disabled = faster.disabled = !enabled
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
