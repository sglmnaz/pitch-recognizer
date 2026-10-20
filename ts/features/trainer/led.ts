// Red LED counters (trainer.css .led): a number padded to a fixed width with
// unlit zeros, like a scoreboard. The unlit digits are decoration, hidden from
// screen readers, which hear the number alone.

/** Shows `value` on the LED `el`, `digits` wide; null = every digit unlit. */
export function showLed(el: HTMLElement, value: number | null, digits = 3) {
	const text = value === null ? '' : String(value)
	const unlit = document.createElement('span')
	unlit.className = 'led__off'
	unlit.ariaHidden = 'true'
	unlit.textContent = '0'.repeat(Math.max(0, digits - text.length))
	el.replaceChildren(unlit, text)
}

/** The Score / Streak / Best counters of the Trainer's scoreboard. */
export function createScoreboard(root: HTMLElement) {
	const score = root.querySelector<HTMLElement>('[data-stat="score"]')!
	const streak = root.querySelector<HTMLElement>('[data-stat="streak"]')!
	const best = root.querySelector<HTMLElement>('[data-stat="best"]')!
	return (state: { score: number; streak: number; best: number }) => {
		showLed(score, state.score)
		showLed(streak, state.streak)
		showLed(best, state.best)
	}
}
