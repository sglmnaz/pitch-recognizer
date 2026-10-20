// Markup for a result row (Scales → Identify): the caller adds it to its list.

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
