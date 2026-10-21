// The circle of fifths under the Scales neck (Harmony → Circle), drawn as a
// clock-face dial (docs/design/oldschool-components.html, "C7"): twelve
// sectors on the face, majors on the outer ring, relative minors inside, the
// current key's sector backlit, a red index on the rim pointing at it and a
// round LCD in the hub naming it. A tap or Enter on a key shows its scale
// through `onChoose`. Colours are classes read from the theme (scales.css);
// the bezel is the HTML box around the svg.
import { CIRCLE, circleIndex, keyOf, MAJOR, MINOR, signatureName } from '../../music/harmony'
import type { ScaleType } from '../../music/scales'
import { noteName, spokenName } from '../../music/note-names'
import { svgEl } from '../../ui/dom'

// Radii in the 290 viewBox. The two rings meet at SPLIT; each is ~33 deep,
// 34 px for a thumb on a 300 px dial (a 340 px phone column).
const C = 145
const FACE = 134
const RIM = 126 // sectors end here; the 60 ticks run inward from it
const SPLIT = 89
const HUB = 60
const MAJOR_TEXT = 101
const MINOR_TEXT = 77
const GLASS = 52 // the hub's LCD, inside a black ring up to 57

// Printed with ♯ / ♭, in the chosen note names.
const glyphs = (name: string) => noteName(name.replace(/#/g, '♯').replace(/([A-G])b/g, '$1♭'))
const sigShort = (n: number) => (n === 0 ? 'no ♯ / ♭' : `${Math.abs(n)} ${n > 0 ? '♯' : '♭'}`)
// Clockwise from 12 o'clock, like the dial.
const at = (r: number, deg: number) => [C + r * Math.sin((deg * Math.PI) / 180), C - r * Math.cos((deg * Math.PI) / 180)]

/** The ring band between radii r0 < r1 from a0 to a1 degrees. */
function band(r0: number, r1: number, a0: number, a1: number) {
	const [x0, y0] = at(r1, a0)
	const [x1, y1] = at(r1, a1)
	const [x2, y2] = at(r0, a1)
	const [x3, y3] = at(r0, a0)
	return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`
}

const text = (attrs: Record<string, string | number>, content = '') => {
	const el = svgEl('text', attrs)
	el.textContent = content
	return el
}

export function createCircle(circle: SVGSVGElement, onChoose: (rootPc: number, type: ScaleType) => void) {
	// Built once; render() only moves the light, so focus survives a tap.
	const glow = svgEl('radialGradient', { id: 'circle-glow', gradientUnits: 'userSpaceOnUse', r: 70 })
	glow.append(svgEl('stop', { class: 'circle__glow-in', offset: 0 }), svgEl('stop', { class: 'circle__glow-out', offset: 1 }))
	const defs = svgEl('defs', {})
	defs.append(glow)
	circle.append(defs, svgEl('circle', { class: 'circle__face', cx: C, cy: C, r: FACE }))

	const sectors = CIRCLE.map((_, i) =>
		svgEl('path', { class: `circle__sector${i % 2 ? ' circle__sector--alt' : ''}`, d: band(HUB, RIM, i * 30 - 15, i * 30 + 15) })
	)
	circle.append(...sectors)
	for (let n = 0; n < 60; n++) {
		const [x1, y1] = at(RIM, n * 6)
		const [x2, y2] = at(n % 5 ? 122 : 118, n * 6)
		circle.append(svgEl('line', { class: n % 5 ? 'circle__tick' : 'circle__tick circle__tick--hour', x1, y1, x2, y2 }))
	}

	const keyCells: SVGGElement[] = []
	for (const ring of ['major', 'minor'] as const) {
		CIRCLE.forEach((key, i) => {
			const name = ring === 'major' ? key.major : `${key.minor}m`
			const alt = ring === 'major' ? key.majorAlt : key.minorAlt && `${key.minorAlt}m`
			const spoken = (n: string) => spokenName(n.replace(/m$/, ''))
			const g = svgEl('g', {
				class: `circle__key circle__key--${ring}`,
				role: 'button',
				tabindex: -1,
				'data-ring': ring,
				'data-index': i,
				'aria-label': `${spoken(name)} ${ring}, ${signatureName(key.accidentals)}${alt ? ` (${spoken(alt)} ${ring}, ${signatureName(key.accidentals - 12)})` : ''}`,
			})
			// The tap target is the whole half of the sector, not just the letters.
			const [r0, r1] = ring === 'major' ? [SPLIT, RIM] : [HUB, SPLIT]
			g.append(svgEl('path', { class: 'circle__hit', d: band(r0, r1, i * 30 - 15, i * 30 + 15) }))
			const [tx, ty] = at(ring === 'major' ? MAJOR_TEXT : MINOR_TEXT, i * 30)
			g.append(text({ class: alt ? 'circle__label circle__label--alt' : 'circle__label', x: tx, y: ty }, glyphs(alt ? `${name}/${alt}` : name)))
			g.addEventListener('click', () => choose(g))
			keyCells.push(g)
			circle.append(g)
		})
	}

	// Pointing at 12 o'clock; render() turns it to the key.
	const index = svgEl('path', { class: 'circle__index', d: `M${C - 7} ${C - 143}L${C + 7} ${C - 143}L${C} ${C - 130}Z` })
	const hubKey = text({ class: 'circle__hub-label', x: C, y: C - 17 }, 'KEY')
	const hubName = text({ class: 'circle__hub-name', x: C, y: C + 10 })
	const hubSub = text({ class: 'circle__hub-sub', x: C, y: C + 28 })
	circle.append(
		index,
		svgEl('circle', { class: 'circle__hub-rim', cx: C, cy: C, r: HUB - 3 }),
		svgEl('circle', { class: 'circle__hub-glass', cx: C, cy: C, r: GLASS }),
		hubKey,
		hubName,
		hubSub
	)

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
			const current = key ? circleIndex(key.pc, key.family) : -1
			const isCurrent = (c: SVGGElement) => Number(c.dataset.index) === current && c.dataset.ring === family
			// The one tab stop: the key in focus, else the current key, else C.
			const rover = keyCells.find((c) => c === document.activeElement) ?? keyCells.find(isCurrent) ?? keyCells[0]
			keyCells.forEach((c) => {
				c.classList.toggle('circle__key--lit', Number(c.dataset.index) === current)
				c.setAttribute('aria-current', String(isCurrent(c)))
				c.setAttribute('tabindex', c === rover ? '0' : '-1')
			})
			sectors.forEach((s, i) => s.classList.toggle('circle__sector--lit', i === current))
			index.toggleAttribute('hidden', current < 0)
			if (current < 0) {
				hubName.textContent = '—'
				hubSub.textContent = 'no key'
				return
			}
			// The backlight is brightest at the middle of the lit sector.
			const [gx, gy] = at((HUB + RIM) / 2, current * 30)
			glow.setAttribute('cx', String(gx))
			glow.setAttribute('cy', String(gy))
			index.setAttribute('transform', `rotate(${current * 30} ${C} ${C})`)
			const k = CIRCLE[current]
			const [name, relative] = family === 'major' ? [k.major, `${k.minor}m`] : [`${k.minor}m`, k.major]
			hubName.textContent = glyphs(name)
			hubSub.textContent = `${glyphs(relative)} · ${sigShort(k.accidentals)}`
		},
	}
}
