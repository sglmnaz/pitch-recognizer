/**
 * Keeps the screen on while `active()`: a sleeping phone silences the page
 * and stops the mic. The browser drops the lock whenever the page is hidden,
 * so it is taken again on return while still active. Refused or unsupported
 * (low battery, an old browser): nothing happens, the feature still runs.
 */
export function screenLock(active: () => boolean) {
	let sentinel: WakeLockSentinel | null = null

	async function hold() {
		// A sentinel the browser released (page hidden) is stale: it does not count.
		if (sentinel && !sentinel.released) return
		try {
			const lock = await navigator.wakeLock?.request('screen')
			if (!lock) return
			// Stopped (or a second request won) while this one was pending: do not leak it.
			if (!active() || (sentinel && !sentinel.released)) return void lock.release()
			sentinel = lock
			lock.addEventListener('release', () => {
				if (sentinel === lock) sentinel = null
			})
		} catch {
			// Refused: carry on without it.
		}
	}

	document.addEventListener('visibilitychange', () => {
		if (!document.hidden && active() && !sentinel) hold()
	})

	return {
		hold,
		release() {
			void sentinel?.release()
			sentinel = null
		},
	}
}
