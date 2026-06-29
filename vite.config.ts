import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Vite serves the project root as-is and uses index.html as the entry point.
// `index.html` references `ts/index.ts` directly, so there is no separate
// compile step the way Webpack required.
export default defineConfig({
	server: {
		// getUserMedia only works on a secure origin; localhost counts as one.
		open: true,
	},
	build: {
		outDir: 'dist',
		target: 'es2020',
	},
	plugins: [
		VitePWA({
			registerType: 'autoUpdate',
			includeAssets: ['apple-touch-icon-180x180.png'],
			manifest: {
				name: 'Pitch Recognizer',
				short_name: 'Pitch',
				description: 'Ear-training and tuning: detect pitch from the microphone and match notes by ear.',
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
