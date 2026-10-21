// A new version, offered when it is there. The PWA updates itself
// (vite-plugin-pwa autoUpdate: the new service worker skips waiting and claims
// the page), but the page keeps running the code it opened with until it
// reloads, and an installed app is resumed far more often than reopened. So:
// look for a new version on opening and whenever the app comes back to the
// front; once a new worker controls the page, a bar offers Update (a reload).
// The first install also claims the page: no bar then (there was no worker).

export function watchForUpdates(bar: HTMLElement) {
	const worker = navigator.serviceWorker
	if (!worker) return
	const hadController = worker.controller !== null
	worker.addEventListener('controllerchange', () => {
		if (hadController) bar.hidden = false
	})
	bar.querySelector('[data-action="update-now"]')!.addEventListener('click', () => location.reload())
	bar.querySelector('[data-action="update-later"]')!.addEventListener('click', () => {
		bar.hidden = true
	})
	const check = () =>
		worker
			.getRegistration()
			.then((registration) => registration?.update())
			.catch(() => {})
	check()
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') check()
	})
}
