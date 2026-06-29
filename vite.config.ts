import { defineConfig } from 'vite'

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
})
