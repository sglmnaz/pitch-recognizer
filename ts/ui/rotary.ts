/**
 * Rotary selector (R1, docs/design/oldschool-components.html): a knurled knob
 * pointing at one of 2–6 fixed positions, a lamp lit next to the chosen one.
 * Markup (index.html): a `.rotary[role=radiogroup]` holding one
 * `button.rotary__pos[role=radio][data-value]` per position (a `.lamp` and the
 * label inside) and a decorative `.rotary__knob`. Styles: `.rotary` in
 * ts/features/metronome/metronome.css until a second tab uses it.
 *
 * It is a radio group for keyboard and screen-reader users (roving tabindex,
 * arrows move and select, Home / End); a tap on a position picks it, a tap on
 * the knob turns it one step, like the real thing.
 * Returns `show(value)`, which turns the knob to that value without calling
 * `onPick` (same shape as bindSegmented in ts/ui/dom.ts).
 */
export function bindRotary(root: HTMLElement, onPick: (value: string) => void) {
	const positions = Array.from(root.querySelectorAll<HTMLButtonElement>('.rotary__pos'))
	const knob = root.querySelector<HTMLElement>('.rotary__knob')!
	// Positions fan out over the top of the knob, 60° apart, never past a half
	// turn: 2 → ±30°, 3 → −60 / 0 / 60, 4 → −90 / −30 / 30 / 90.
	const spread = Math.min(180, 60 * (positions.length - 1))
	const angleOf = (i: number) => (positions.length < 2 ? 0 : -spread / 2 + (spread * i) / (positions.length - 1))
	positions.forEach((pos, i) => pos.style.setProperty('--a', `${angleOf(i)}deg`))

	let current = 0
	const pick = (i: number) => {
		show(positions[i].dataset.value!)
		onPick(positions[i].dataset.value!)
	}

	positions.forEach((pos, i) => pos.addEventListener('click', () => pick(i)))
	knob.addEventListener('click', () => pick((current + 1) % positions.length))
	root.addEventListener('keydown', (event) => {
		const n = positions.length
		const to = { ArrowRight: current + 1, ArrowDown: current + 1, ArrowLeft: current - 1, ArrowUp: current - 1, Home: 0, End: n - 1 }[event.key]
		if (to === undefined) return
		event.preventDefault()
		const i = (to + n) % n
		pick(i)
		positions[i].focus()
	})

	function show(value: string | number) {
		const i = positions.findIndex((pos) => pos.dataset.value === String(value))
		if (i < 0) return
		current = i
		root.style.setProperty('--turn', `${angleOf(i)}deg`)
		positions.forEach((pos, j) => {
			pos.setAttribute('aria-checked', String(j === i))
			pos.tabIndex = j === i ? 0 : -1
			pos.querySelector('.lamp')?.classList.toggle('is-on', j === i)
		})
	}

	return show
}
