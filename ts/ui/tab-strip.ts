// The strip of tab paper shared by Trainer → Tab and Trainer → Songs: the
// strings, the TAB clef and the red playhead stay still (index.html, trainer.css)
// and only the notes move, so nobody has to scroll while playing.
import { reducedMotion } from './media'

// Where the playhead stands on the paper (trainer.css .tab-now) and where the
// moving track starts (after the clef).
export const PLAYHEAD_X = 96
export const TRACK_X = 40
// The top string and the gap between strings (trainer.css .tab-strings).
export const STRING_TOP = 24
export const STRING_GAP = 16

/** The y of a string on the paper (1 = high E, at the top). */
export const stringY = (string: number) => STRING_TOP + (string - 1) * STRING_GAP

/** Collects the absolutely placed spans of one strip: `el` makes one, `parts` holds them in order. */
export function stripParts() {
	const parts: HTMLElement[] = []
	const el = (cls: string, left: number, text = '', top?: number) => {
		const span = document.createElement('span')
		span.className = cls
		span.style.left = `${left}px`
		if (top !== undefined) span.style.top = `${top}px`
		span.textContent = text
		parts.push(span)
		return span
	}
	return { parts, el }
}

/** Puts `x` (px from the start of the strip) under the playhead; `smooth` slides there. */
export function placeStrip(strip: HTMLElement, x: number, smooth = false) {
	strip.classList.toggle('tab-strip--step', smooth && !reducedMotion.matches)
	strip.style.transform = `translateX(${(PLAYHEAD_X - TRACK_X - x).toFixed(1)}px)`
}
