import { readString, remove, writeString } from '../core/storage'

/*
 * Theme and display (docs/adr/0007). <html data-theme="classic|night|sand|…"
 * data-mode="light|dark" [data-display="green|amber|…"]>: the theme picks
 * the materials of the whole app, the mode drives color-scheme and lets a
 * subtree force light or dark (the fretboard, the trainer staff), the display
 * recolours only the LCD windows (absent = the theme's own LCD). The inline
 * script in index.html sets the same attributes before first paint from the
 * same keys, so a reload never flashes: keep THEMES, the keys and the theme
 * colours in step with it. A new theme is one block per mode in
 * ts/styles/tokens.css plus one entry here (DESIGN.md, "How to add a theme").
 */

export type Mode = 'light' | 'dark'

export interface Theme {
	/** What the user picks, stored under THEME_KEY. */
	id: string
	label: string
	/** data-theme: the palette block in tokens.css. */
	palette: string
	/** data-mode it forces; absent = follow the device (System). */
	mode?: Mode
	/** Browser chrome colour (<meta name="theme-color">) per resolved mode: the panel colour. */
	themeColor: Partial<Record<Mode, string>>
}

const CLASSIC = { light: '#e7e1d3', dark: '#2a2825' }

export const THEMES: readonly Theme[] = [
	{ id: 'system', label: 'System', palette: 'classic', themeColor: CLASSIC },
	{ id: 'light', label: 'Light', palette: 'classic', mode: 'light', themeColor: CLASSIC },
	{ id: 'dark', label: 'Dark', palette: 'classic', mode: 'dark', themeColor: CLASSIC },
	{ id: 'night', label: 'Night blue', palette: 'night', mode: 'dark', themeColor: { dark: '#1c222c' } },
	{ id: 'sand', label: 'Sand', palette: 'sand', mode: 'light', themeColor: { light: '#d8ccb2' } },
	{ id: 'studio', label: 'Studio white', palette: 'studio', mode: 'light', themeColor: { light: '#efeeea' } },
	{ id: 'mint', label: 'Mint', palette: 'mint', mode: 'light', themeColor: { light: '#cfe2d9' } },
	{ id: 'graphite', label: 'Studio grey', palette: 'graphite', mode: 'dark', themeColor: { dark: '#383b40' } },
	{ id: 'petrol', label: 'Petrol', palette: 'petrol', mode: 'dark', themeColor: { dark: '#1e3638' } },
	{ id: 'walnut', label: 'Walnut and brass', palette: 'walnut', mode: 'dark', themeColor: { dark: '#2e2219' } },
	{ id: 'olive', label: 'Olive', palette: 'olive', mode: 'dark', themeColor: { dark: '#4b5039' } },
	{ id: 'stage', label: 'Stage red', palette: 'stage', mode: 'dark', themeColor: { dark: '#9e2b25' } },
	{ id: 'brit', label: 'British stack', palette: 'brit', mode: 'dark', themeColor: { dark: '#1b1a19' } },
	{ id: 'copper', label: 'Copper top', palette: 'copper', mode: 'dark', themeColor: { dark: '#1f1b18' } },
	{ id: 'citrus', label: 'Citrus', palette: 'citrus', mode: 'light', themeColor: { light: '#e2671f' } },
	{ id: 'blackstar', label: 'Black star', palette: 'blackstar', mode: 'dark', themeColor: { dark: '#151517' } },
]

/** LCD colours; 'auto' = the theme's own. */
export const DISPLAYS = [
	{ id: 'auto', label: 'Theme' },
	{ id: 'green', label: 'Grey-green' },
	{ id: 'amber', label: 'Amber' },
	{ id: 'blue', label: 'Blue' },
	{ id: 'casio', label: 'Casio yellow-green' },
	{ id: 'red', label: 'Red LED' },
	{ id: 'phosphor', label: 'Green phosphor' },
	{ id: 'vfd', label: 'VFD turquoise' },
	{ id: 'oled', label: 'White OLED' },
	{ id: 'ice', label: 'Ice' },
	{ id: 'violet', label: 'Violet' },
	{ id: 'eink', label: 'E-ink' },
] as const
export type Display = (typeof DISPLAYS)[number]['id']

const THEME_KEY = 'pitch-recognizer:mode'
const DISPLAY_KEY = 'pitch-recognizer:display'
/** Older keys: the mode as 'theme' (pre-palette), the Geist palette id. */
const LEGACY_KEYS = ['theme', 'pitch-recognizer:palette']

const systemDark = matchMedia('(prefers-color-scheme: dark)')

function loadTheme(): Theme {
	const legacyMode = readString('theme')
	if (legacyMode !== null && readString(THEME_KEY) === null) writeString(THEME_KEY, legacyMode)
	for (const key of LEGACY_KEYS) remove(key)
	const saved = readString(THEME_KEY)
	return THEMES.find((t) => t.id === saved) ?? THEMES[0]
}

function loadDisplay(): Display {
	const saved = readString(DISPLAY_KEY)
	return DISPLAYS.find((d) => d.id === saved)?.id ?? 'auto'
}

let theme = loadTheme()
let display = loadDisplay()

export const getTheme = () => theme.id
export const getDisplay = () => display

/** Applies theme, mode and display to the document and the browser chrome. */
export function applyTheme() {
	const root = document.documentElement
	const mode: Mode = theme.mode ?? (systemDark.matches ? 'dark' : 'light')
	root.dataset.theme = theme.palette
	root.dataset.mode = mode
	if (display === 'auto') delete root.dataset.display
	else root.dataset.display = display
	const color = theme.themeColor[mode] ?? CLASSIC[mode]
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

export function setTheme(id: string) {
	const next = THEMES.find((t) => t.id === id)
	if (!next) return
	theme = next
	if (next.id === 'system') remove(THEME_KEY)
	else writeString(THEME_KEY, next.id)
	applyTheme()
}

export function setDisplay(id: string) {
	const next = DISPLAYS.find((d) => d.id === id)
	if (!next) return
	display = next.id
	if (display === 'auto') remove(DISPLAY_KEY)
	else writeString(DISPLAY_KEY, display)
	applyTheme()
}

// System follows the device live.
systemDark.addEventListener('change', () => {
	if (!theme.mode) applyTheme()
})
