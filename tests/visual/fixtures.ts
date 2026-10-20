import { test as base, expect, type Page } from '@playwright/test'

export type Options = { theme: 'light' | 'dark' | 'night' }

/**
 * Runs in the page before any app script, on every load. Everything a
 * screenshot depends on is pinned: the theme, a seeded Math.random (trainer
 * targets, ear questions), and a microphone that is always refused (so every
 * tab shows the same "unavailable" state instead of a live waveform).
 * `settings` seeds the stored settings on the first load of a test only, so
 * a reload sees what the app itself saved.
 */
function init({ theme, settings }: { theme: string; settings: Record<string, unknown> | null }) {
	if (!sessionStorage.getItem('pw:init')) {
		sessionStorage.setItem('pw:init', '1')
		localStorage.clear()
		localStorage.setItem('theme', theme)
		if (settings) localStorage.setItem('pitch-recognizer:settings', JSON.stringify(settings))
	}

	// mulberry32: tiny, good enough, same sequence every load.
	let seed = 0x9e3779b9
	Math.random = () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = seed
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}

	const refuse = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
	if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = refuse
	else Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: refuse } })
}

export const test = base.extend<Options & { open: (hash: string, settings?: Record<string, unknown>) => Promise<void> }>({
	theme: ['light', { option: true }],
	open: async ({ page, theme }, use) => {
		await use(async (hash, settings) => {
			await page.addInitScript(init, { theme, settings: settings ?? null })
			await page.goto(`/${hash}`)
			await settle(page)
		})
	},
})

/** Fonts loaded and two frames painted: the refused mic and first layout are done. */
export async function settle(page: Page) {
	await page.evaluate(async () => {
		await document.fonts.ready
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	})
}

/** Viewport screenshot; the waveform canvas is masked (it draws every frame). */
export async function shot(page: Page, name: string, options: { fullPage?: boolean } = {}) {
	await settle(page)
	await expect(page).toHaveScreenshot(`${name}.png`, { mask: [page.locator('canvas')], ...options })
}

export { expect }
