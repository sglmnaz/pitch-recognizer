// In-place iterative radix-2 FFT with cached twiddle and bit-reversal tables
// (sizes are fixed per caller, so the tables are built once). Shared by the
// pitch detector (noise-subtracted autocorrelation) and the Node scripts.

const tables = new Map<number, { cos: Float64Array; sin: Float64Array; reverse: Uint32Array }>()

function tablesFor(n: number) {
	let t = tables.get(n)
	if (!t) {
		const cos = new Float64Array(n / 2)
		const sin = new Float64Array(n / 2)
		for (let k = 0; k < n / 2; k++) {
			cos[k] = Math.cos((-2 * Math.PI * k) / n)
			sin[k] = Math.sin((-2 * Math.PI * k) / n)
		}
		const reverse = new Uint32Array(n)
		for (let i = 1, j = 0; i < n; i++) {
			let bit = n >> 1
			for (; j & bit; bit >>= 1) j ^= bit
			j ^= bit
			reverse[i] = j
		}
		t = { cos, sin, reverse }
		tables.set(n, t)
	}
	return t
}

/** Forward DFT of (re, im) in place; length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
	const n = re.length
	const { cos, sin, reverse } = tablesFor(n)
	for (let i = 1; i < n; i++) {
		const j = reverse[i]
		if (i < j) {
			const [r, m] = [re[i], im[i]]
			re[i] = re[j]
			im[i] = im[j]
			re[j] = r
			im[j] = m
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1
		const step = n / size
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < half; k++) {
				const wr = cos[k * step]
				const wi = sin[k * step]
				const i = start + k
				const j = i + half
				const tr = wr * re[j] - wi * im[j]
				const ti = wr * im[j] + wi * re[j]
				re[j] = re[i] - tr
				im[j] = im[i] - ti
				re[i] += tr
				im[i] += ti
			}
		}
	}
}
