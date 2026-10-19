import { readString, remove, writeString } from '../core/storage'

/*
 * Theme = palette × mode (docs/adr/0005). <html data-theme="<palette id>"
 * data-mode="light|dark">; the inline script in index.html sets both before
 * first paint from the same keys, so a reload never flashes. Each palette is
 * one CSS block in ts/styles/tokens.css plus one entry here (DESIGN.md, "How
 * to add a theme"); the head script's allow-list must list the same ids.
 */

export type Mode = 'light' | 'dark'
/** What the user picks: a mode, or follow the device. */
export type ModeChoice = 'system' | Mode

export interface Theme {
	id: string
	label: string
	/** Browser chrome colour (<meta name="theme-color">): the palette's --bg per mode. */
	themeColor: Record<Mode, string>
}

export const THEMES: readonly Theme[] = [{ id: 'default', label: 'Default', themeColor: { light: '#fbfbfc', dark: '#0a0a0b' } }]
export const MODES: readonly ModeChoice[] = ['system', 'light', 'dark']

const MODE_KEY = 'pitch-recognizer:mode'
const PALETTE_KEY = 'pitch-recognizer:palette'
/** Before palettes the mode lived under 'theme' ('light' / 'dark', absent = system). */
const LEGACY_MODE_KEY = 'theme'

const systemDark = matchMedia('(prefers-color-scheme: dark)')
const isMode = (value: string | null): value is Mode => value === 'light' || value === 'dark'

function loadMode(): ModeChoice {
	const legacy = readString(LEGACY_MODE_KEY)
	if (legacy !== null) {
		if (isMode(legacy) && readString(MODE_KEY) === null) writeString(MODE_KEY, legacy)
		remove(LEGACY_MODE_KEY)
	}
	const saved = readString(MODE_KEY)
	return isMode(saved) ? saved : 'system'
}

function loadPalette(): string {
	const saved = readString(PALETTE_KEY)
	return THEMES.some((t) => t.id === saved) ? saved! : THEMES[0].id
}

let mode = loadMode()
let palette = loadPalette()

export const getMode = () => mode
export const getPalette = () => palette
export const resolvedMode = (): Mode => (mode === 'system' ? (systemDark.matches ? 'dark' : 'light') : mode)

/** Applies palette and mode to the document and the browser chrome. */
export function applyTheme() {
	const root = document.documentElement
	const resolved = resolvedMode()
	root.dataset.theme = palette
	root.dataset.mode = resolved
	const theme = THEMES.find((t) => t.id === palette) ?? THEMES[0]
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.themeColor[resolved])
}

export function setMode(choice: ModeChoice) {
	mode = choice
	if (choice === 'system') remove(MODE_KEY)
	else writeString(MODE_KEY, choice)
	applyTheme()
}

export function setPalette(id: string) {
	if (!THEMES.some((t) => t.id === id)) return
	palette = id
	writeString(PALETTE_KEY, id)
	applyTheme()
}

// System follows the device live.
systemDark.addEventListener('change', () => {
	if (mode === 'system') applyTheme()
})
