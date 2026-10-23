// The strip of tab paper shared by Trainer → Tab and Trainer → Songs: the
// strings and the red playhead stay still (index.html, trainer.css) and only the
// notes move, so nobody has to scroll while playing. No TAB clef: its 40 px went
// to the notes coming.
import { reducedMotion } from './media'

// Where the playhead stands on the paper (trainer.css .tab-now) and where the
// moving track starts.
export const PLAYHEAD_X = 56
export const TRACK_X = 0
// The top string and the gap between strings (trainer.css .tab-strings).
export const STRING_TOP = 24
export const STRING_GAP = 16

/** The y of a string on the paper (1 = high E, at the top). */
export const stringY = (string: number) => STRING_TOP + (string - 1) * STRING_GAP

const SVG = 'http://www.w3.org/2000/svg'

/** Collects the absolutely placed spans of one strip: `el` makes one, `mark` draws a sign between two notes, `parts` holds them in order. */
export function stripParts() {
	const parts: Element[] = []
	const el = (cls: string, left: number, text = '', top?: number) => {
		const span = document.createElement('span')
		span.className = cls
		span.style.left = `${left}px`
		if (top !== undefined) span.style.top = `${top}px`
		span.textContent = text
		parts.push(span)
		return span
	}
	/**
	 * The signs of the full-screen score, in print size, on the string at `y`: a legato
	 * (h, p) a slur over the two notes with its letter, a slide (/ \\) a slanting line
	 * with SL, a bend (b, `to` the fret reached) an arrow up from the note at `x0`.
	 */
	const mark = (sign: string, x0: number, x1: number, y: number, to = 0) => {
		const svg = document.createElementNS(SVG, 'svg')
		svg.setAttribute('class', 'tab-mark')
		const add = (tag: string, attrs: Record<string, string | number>, text = '') => {
			const shape = document.createElementNS(SVG, tag)
			for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, String(value))
			shape.textContent = text
			svg.append(shape)
		}
		const mid = (x0 + x1) / 2
		if (sign === 'h' || sign === 'p') {
			add('path', { class: 'ink', d: `M${x0 + 5} ${y - 9} Q${mid} ${y - 21} ${x1 - 5} ${y - 9}` })
			add('text', { x: mid, y: y - 21 }, sign)
		} else if (sign === '/' || sign === '\\') {
			const d = sign === '/' ? 4 : -4
			add('path', { class: 'ink', d: `M${x0 + 9} ${y + d} L${x1 - 9} ${y - d}` })
			add('text', { x: mid, y: y - 11 }, 'sl')
		} else {
			add('path', { class: 'ink', d: `M${x0 + 8} ${y - 2} Q${x0 + 20} ${y - 3} ${x0 + 22} ${y - 13}` })
			add('path', { class: 'head', d: `M${x0 + 22} ${y - 20} L${x0 + 18} ${y - 12} L${x0 + 26} ${y - 12}Z` })
			add('text', { class: 'to', x: x0 + 29, y: y - 16 }, String(to))
		}
		parts.push(svg)
	}
	return { parts, el, mark }
}

/** Puts `x` (px from the start of the strip) under the playhead; `smooth` slides there. */
export function placeStrip(strip: HTMLElement, x: number, smooth = false) {
	strip.classList.toggle('tab-strip--step', smooth && !reducedMotion.matches)
	strip.style.transform = `translateX(${(PLAYHEAD_X - TRACK_X - x).toFixed(1)}px)`
}
