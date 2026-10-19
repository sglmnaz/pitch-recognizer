// Shared by the scripts/*-check.ts self-checks: one `ok` / `FAIL` line per
// check, and a non-zero exit when any failed (so `npm run check` stops there).
let failures = 0

export function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures++
}

/** Ends the run: the failure count and exit code 1, or the `passed` line. */
export function finish(passed: string) {
	if (failures) {
		console.error(`\n${failures} check(s) failed`)
		process.exit(1)
	}
	console.log(`\n${passed}`)
	process.exit(0)
}
