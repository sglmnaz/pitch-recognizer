// The circle of fifths under the Scales neck (Harmony → Circle): majors
// outside, relative minors inside, the current key and its neighbours lit.
// A tap or Enter on a key shows its scale through `onChoose`.
import { CIRCLE, circleIndex, keyOf, MAJOR, MINOR, signatureName } from '../../music/harmony'
import type { ScaleType } from '../../music/scales'
import { svgEl } from '../../ui/dom'

const sig = (n: number) => (n === 0 ? '' : `${Math.abs(n)}${n > 0 ? '♯' : '♭'}`)

// Built once; render() only moves the highlight, so focus survives a tap.
// Rings: majors outside, relative minors inside, radii in a 400 viewBox,
// each 63 deep: 44 px for a thumb even at a 280 px circle (a 320 px phone).
const C = 200
const RINGS = { major: [135, 198], minor: [72, 135] } as const
const at = (r: number, deg: number) => [C + r * Math.sin((deg * Math.PI) / 180), C - r * Math.cos((deg * Math.PI) / 180)]

export function createCircle(circle: SVGSVGElement, onChoose: (rootPc: number, type: ScaleType) => void) {
	const keyCells: SVGGElement[] = []
	const center = svgEl('text', { class: 'circle__center', x: C, y: C - 6 })
	const centerSig = svgEl('text', { class: 'circle__center-sig', x: C, y: C + 16 })
	for (const ring of ['major', 'minor'] as const) {
		const [r0, r1] = RINGS[ring]
		CIRCLE.forEach((key, i) => {
			const a0 = i * 30 - 15
			const a1 = i * 30 + 15
			const [x0, y0] = at(r1, a0)
			const [x1, y1] = at(r1, a1)
			const [x2, y2] = at(r0, a1)
			const [x3, y3] = at(r0, a0)
			const name = ring === 'major' ? key.major : `${key.minor}m`
			const alt = ring === 'major' ? key.majorAlt : key.minorAlt && `${key.minorAlt}m`
			const spoken = (n: string) =>
				n
					.replace('#', ' sharp')
					.replace(/^([A-G])b/, '$1 flat')
					.replace(/m$/, '')
			const g = svgEl('g', {
				class: `circle__key circle__key--${ring}`,
				role: 'button',
				tabindex: -1,
				'data-ring': ring,
				'data-index': i,
				'aria-label': `${spoken(name)} ${ring}, ${signatureName(key.accidentals)}${alt ? ` (${spoken(alt)} ${ring}, ${signatureName(key.accidentals - 12)})` : ''}`,
			})
			g.append(svgEl('path', { d: `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z` }))
			const [tx, ty] = at((r0 + r1) / 2, i * 30)
			const label = svgEl('text', { x: tx, y: ty + (ring === 'major' ? -6 : 0) })
			if (ring === 'minor' && alt) {
				label.setAttribute('class', 'circle__alt')
				label.append(svgEl('tspan', { x: tx, dy: -7 }), svgEl('tspan', { x: tx, dy: 14 }))
				label.children[0].textContent = name
				label.children[1].textContent = alt
			} else label.textContent = alt ? `${name}/${alt}` : name
			if (alt && ring === 'major') label.setAttribute('class', 'circle__alt')
			g.append(label)
			if (ring === 'major') {
				const s = svgEl('text', { class: 'circle__sig', x: tx, y: ty + 12 })
				s.textContent = alt ? `${sig(key.accidentals)}/${sig(key.accidentals - 12)}` : sig(key.accidentals) || '–'
				g.append(s)
			}
			g.addEventListener('click', () => choose(g))
			keyCells.push(g)
			circle.append(g)
		})
	}
	circle.append(center, centerSig)

	function choose(g: SVGGElement) {
		const key = CIRCLE[Number(g.dataset.index)]
		const minor = g.dataset.ring === 'minor'
		onChoose(minor ? key.minorPc : key.majorPc, minor ? MINOR : MAJOR)
		g.focus()
	}

	// Roving focus: Left / Right go round the ring, Up / Down switch rings.
	circle.addEventListener('keydown', (event) => {
		const g = (event.target as Element).closest<SVGGElement>('.circle__key')
		if (!g) return
		const i = Number(g.dataset.index)
		const ring = g.dataset.ring
		let next: [string, number] | null = null
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			return choose(g)
		}
		if (event.key === 'ArrowRight') next = [ring!, (i + 1) % 12]
		if (event.key === 'ArrowLeft') next = [ring!, (i + 11) % 12]
		if (event.key === 'ArrowUp') next = ['major', i]
		if (event.key === 'ArrowDown') next = ['minor', i]
		if (!next) return
		event.preventDefault()
		const target = keyCells.find((c) => c.dataset.ring === next![0] && Number(c.dataset.index) === next![1])!
		keyCells.forEach((c) => c.setAttribute('tabindex', c === target ? '0' : '-1'))
		target.focus()
	})

	return {
		/** Lights the key of this scale; a mode lights its parent major: D Dorian is written in C major. */
		render(rootPc: number, type: ScaleType) {
			const key = keyOf(rootPc, type)
			const family = key?.family
			const index = key ? circleIndex(key.pc, key.family) : -1
			const near = (i: number) => index >= 0 && [11, 0, 1].includes((i - index + 12) % 12)
			const isCurrent = (c: SVGGElement) => Number(c.dataset.index) === index && c.dataset.ring === family
			// The one tab stop: the key in focus, else the current key, else C.
			const rover = keyCells.find((c) => c === document.activeElement) ?? keyCells.find(isCurrent) ?? keyCells[0]
			keyCells.forEach((c) => {
				const current = isCurrent(c)
				c.classList.toggle('circle__key--current', current)
				c.classList.toggle('circle__key--near', near(Number(c.dataset.index)) && !current)
				c.setAttribute('aria-current', String(current))
				c.setAttribute('tabindex', c === rover ? '0' : '-1')
			})
			if (index < 0) {
				center.textContent = 'Tap a key'
				centerSig.textContent = ''
				return
			}
			const k = CIRCLE[index]
			center.textContent = family === 'major' ? k.major : k.minor
			centerSig.textContent = `${family} · ${signatureName(k.accidentals)}`
		},
	}
}
