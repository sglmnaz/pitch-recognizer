import { defineConfig, devices } from '@playwright/test'
import type { Options } from './tests/visual/fixtures'

// Visual regression net: every tab and sub-mode at three widths (phone,
// tablet, desktop) in the light and dark themes, plus night on phones. Baselines are generated on Windows: other
// OSes rasterize fonts differently, so regenerate there (`npm run test:visual:update`).
const PORT = 4179
const sizes = {
	phone: { width: 375, height: 812 },
	tablet: { width: 768, height: 1024 },
	desktop: { width: 1280, height: 800 },
}
const themes: Options['theme'][] = ['light', 'dark']
// Night shares the dark mode's layout: one width is enough to catch a missing token.
const extra: { size: keyof typeof sizes; theme: Options['theme'] }[] = [{ size: 'phone', theme: 'night' }]

export default defineConfig<Options>({
	testDir: 'tests/visual',
	snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	reporter: [['list']],
	expect: {
		// A pixel budget, not a ratio: 0.2 % of a phone screen (~600 px) let a removed
		// icon pass unnoticed. Rendering here is deterministic, so a few pixels suffice.
		// threshold: the per-pixel colour tolerance (default 0.2) hid a whole bevel on the
		// dark themes, whose shades sit close together.
		toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 20, threshold: 0.02 },
	},
	use: {
		baseURL: `http://localhost:${PORT}`,
		reducedMotion: 'reduce',
		// The PWA service worker would cache between tests.
		serviceWorkers: 'block',
	},
	projects: [...(Object.keys(sizes) as (keyof typeof sizes)[]).flatMap((size) => themes.map((theme) => ({ size, theme }))), ...extra].map(
		({ size, theme }) => ({
			name: `${size}-${theme}`,
			use: { ...devices['Desktop Chrome'], viewport: sizes[size], deviceScaleFactor: 1, colorScheme: theme === 'light' ? 'light' : 'dark', theme },
		})
	),
	// The production build, as deployed: built fresh every run, never a stale server.
	webServer: {
		command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
})
