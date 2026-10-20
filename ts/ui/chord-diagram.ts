// A chord diagram: one voicing drawn on a compact fretboard window (the
// Chords library, Trainer Changes, the Scales harmony detail).
import type { ChordType } from '../music/chord-theory'
import { voicingSpec, type Voicing } from '../music/chord-shapes'
import { svgEl } from './dom'
import { createFretboard } from './fretboard'

/** As the chordLabels setting; 'fingers' puts the finger numbers in the dots instead of a row below. */
export type DiagramLabels = 'degrees' | 'notes' | 'fingers' | 'none'

export interface ChordDiagramOptions {
	/** Draw into this svg (one in the markup); default a new <svg class="neck">. */
	svg?: SVGSVGElement
	/** Redraw by itself when left-handed or the board theme changes (fretboard autoRender). */
	autoRender?: boolean
	/** Dot labels, read at every render() (default degrees). */
	labels?: DiagramLabels | (() => DiagramLabels)
	/** The finger row under the diagram (default true; 'fingers' labels drop it). */
	fingers?: boolean
	/** Scale with the container instead of drawing 1:1 (fretboard fluid). */
	fluid?: boolean
}

export interface ChordDiagram {
	el: SVGSVGElement
	/** Draws (or redraws) the voicing; nothing without one. */
	render(): void
	/** Drops the board's settings subscription and listeners. */
	destroy(): void
}

export function chordDiagram(rootPc: number, type: ChordType, voicing: Voicing | undefined, opts: ChordDiagramOptions = {}): ChordDiagram {
	const el = opts.svg ?? svgEl('svg', { class: 'neck' })
	const board = createFretboard(el, null, { autoRender: opts.autoRender, fluid: opts.fluid })
	return {
		el,
		render() {
			if (!voicing) return
			const labels = typeof opts.labels === 'function' ? opts.labels() : opts.labels
			if (labels !== 'fingers') return board.render(voicingSpec(voicing, rootPc, type, { labels, fingers: opts.fingers }))
			const spec = voicingSpec(voicing, rootPc, type, { labels: 'none', fingers: false })
			for (const dot of spec.dots) dot.label = voicing.fingers[dot.string] ? String(voicing.fingers[dot.string]) : ''
			board.render(spec)
		},
		destroy: board.destroy,
	}
}
