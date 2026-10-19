import { defineConfig, devices } from '@playwright/test'
import type { Options } from './tests/visual/fixtures'

// Visual regression net: every tab and sub-mode at three widths (phone,
// tablet, desktop) in both themes. Baselines are generated on Windows: other
// OSes rasterize fonts differently, so regenerate there (`npm run test:visual:update`).
const PORT = 4179
const sizes = {
	phone: { width: 375, height: 812 },
	tablet: { width: 768, height: 1024 },
	desktop: { width: 1280, height: 800 },
}
const themes: Options['theme'][] = ['light', 'dark']

export default defineConfig<Options>({
	testDir: 'tests/visual',
	snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	reporter: [['list']],
	expect: {
		// A pixel budget, not a ratio: 0.2 % of a phone screen (~600 px) let a removed
		// icon pass unnoticed. Rendering here is deterministic, so a few pixels suffice.
		toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 20 },
	},
	use: {
		baseURL: `http://localhost:${PORT}`,
		reducedMotion: 'reduce',
		// The PWA service worker would cache between tests.
		serviceWorkers: 'block',
	},
	projects: Object.entries(sizes).flatMap(([size, viewport]) =>
		themes.map((theme) => ({
			name: `${size}-${theme}`,
			use: { ...devices['Desktop Chrome'], viewport, deviceScaleFactor: 1, colorScheme: theme, theme },
		}))
	),
	// The production build, as deployed: built fresh every run, never a stale server.
	webServer: {
		command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
})
