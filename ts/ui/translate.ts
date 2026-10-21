// Puts index.html, written in English, into the language in use, once at boot
// before any view is built (ts/main.ts). Every text node and the attributes
// people read or hear are looked up whole (ts/core/i18n.ts lookup); a block
// mixing text with inline markup (a <b>, a <kbd>) is looked up as its inner
// HTML, so a translation can move the bold word. What the dictionary does not
// know (numbers, note names, LCD placeholders) stays as it is. Text under a
// data-i18n="ctx" element is looked up as `ctx|text` first (a knob's short
// labels), then as plain text.
// tests/visual/i18n.spec.ts lists whatever stays English in Italian.
import { lookup } from '../core/i18n'

const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'data-title', 'content'] as const
// Inline markup a sentence may carry without splitting it.
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'SMALL', 'KBD', 'CODE', 'A', 'BR', 'SPAN', 'ABBR'])

/** Whitespace folded, ends trimmed: the form the dictionary keys are written in. */
export const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A block whose own text runs around inline elements holding text: translated as one sentence. Empty ones (a lamp) do not count. */
function isSentence(el: Element): boolean {
	let text = false
	let inline = false
	for (const child of el.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) text ||= /\p{L}/u.test(child.textContent ?? '')
		else if (child.nodeType === Node.ELEMENT_NODE) {
			const inner = child as Element
			if (!INLINE.has(inner.tagName) || inner.children.length) return false
			inline ||= Boolean(inner.textContent?.trim())
		}
	}
	return text && inline
}

function translateAttributes(el: Element, find: Find) {
	for (const name of ATTRIBUTES) {
		const value = el.getAttribute(name)
		// Of the metas, only the description is words.
		if (!value || (name === 'content' && el.getAttribute('name') !== 'description')) continue
		const found = find(normalize(value))
		if (found !== undefined) el.setAttribute(name, found)
	}
}

type Find = (key: string) => string | undefined

/**
 * Translates `root` and everything under it, template contents included.
 * `find` answers each key; tests/visual/i18n.spec.ts passes one that records
 * the keys, to list what a dictionary lacks.
 */
export function translate(root: ParentNode, find: Find = lookup) {
	const walk = (node: ParentNode) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				const text = child.textContent ?? ''
				const key = normalize(text)
				const context = child.parentElement?.closest('[data-i18n]')?.getAttribute('data-i18n')
				const found = key && ((context && find(`${context}|${key}`)) || find(key))
				// Keep the spaces around it: they separate it from its neighbours.
				if (found) child.textContent = /^\s*/.exec(text)![0] + found + /\s*$/.exec(text)![0]
				continue
			}
			if (child.nodeType !== Node.ELEMENT_NODE) continue
			const el = child as Element
			if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
			translateAttributes(el, find)
			if (el instanceof HTMLTemplateElement) {
				walk(el.content)
				continue
			}
			if (isSentence(el)) {
				const found = find(normalize(el.innerHTML))
				if (found !== undefined) {
					el.innerHTML = found
					continue
				}
			}
			walk(el)
		}
	}
	walk(root)
}
