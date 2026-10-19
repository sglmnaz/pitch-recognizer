// Markup shared by the Scales strip / results and the Chords library /
// Identify results. The caller creates the element and sets its attributes
// (each view in its own order); these fill in the parts.

/** A note chip: `chip` gets the note name over its degree. */
export function noteChip<T extends HTMLElement>(chip: T, note: string, degree: string): T {
	const name = document.createElement('span')
	name.className = 'scale-note__name'
	name.textContent = note
	const deg = document.createElement('span')
	deg.className = 'scale-note__degree'
	deg.textContent = degree
	chip.append(name, deg)
	return chip
}

/** A result row's button: one span per [class, text], in order. */
export function resultButton(className: string, parts: [string, string][]) {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = className
	for (const [cls, text] of parts) {
		const span = document.createElement('span')
		span.className = cls
		span.textContent = text
		button.append(span)
	}
	return button
}
