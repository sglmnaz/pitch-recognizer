import browserslist from 'browserslist'
import { browserslistToTargets } from 'lightningcss'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// CSS browser support: "browserslist" in package.json. iOS / Safari 16.2 is the
// floor because color-mix() with custom properties cannot be lowered.
const browsers = browserslist()
// Vite's Lightning CSS minifier reads esbuild-style build.cssTarget, not
// css.lightningcss.targets, so the same list is mirrored there.
const esbuildName: Record<string, string> = {
	chrome: 'chrome',
	and_chr: 'chrome',
	edge: 'edge',
	firefox: 'firefox',
	and_ff: 'firefox',
	safari: 'safari',
	ios_saf: 'ios',
}
const cssTarget = browsers.flatMap((b) => {
	const [name, version] = b.split(' ')
	return name in esbuildName ? [esbuildName[name] + version.split('-')[0]] : []
})

// Vite serves the project root as-is and uses index.html as the entry point.
// `index.html` references `ts/main.ts` directly, so there is no separate
// compile step the way Webpack required.
export default defineConfig({
	server: {
		// getUserMedia only works on a secure origin; localhost counts as one.
		open: true,
	},
	// Native CSS (nesting, @layer) lowered for the targets by Lightning CSS (docs/adr/0004).
	css: {
		transformer: 'lightningcss',
		lightningcss: { targets: browserslistToTargets(browsers) },
	},
	build: {
		outDir: 'dist',
		target: 'es2020',
		cssTarget,
		cssMinify: 'lightningcss',
	},
	plugins: [
		VitePWA({
			registerType: 'autoUpdate',
			includeAssets: ['apple-touch-icon-180x180.png', 'favicon-64x64.png'],
			manifest: {
				name: 'Pluck',
				short_name: 'Pluck',
				description: 'Guitar tuner, chord recognition and ear training from your microphone.',
				lang: 'en',
				theme_color: '#0a0a0b',
				background_color: '#0a0a0b',
				display: 'standalone',
				orientation: 'portrait',
				start_url: '/',
				scope: '/',
				categories: ['music', 'education'],
				icons: [
					{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
					{ src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
					{ src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
				],
			},
			workbox: {
				// VexFlow is large; raise the precache limit so it is cached for offline use.
				maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
				globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
			},
		}),
	],
})
