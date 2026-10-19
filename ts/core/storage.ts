// localStorage that never throws: private mode, a full quota, blocked site
// data or Node (the check scripts) make every access fail, and then the app
// simply keeps its state in memory for the visit.

export function readString(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

export function writeString(key: string, value: string) {
	try {
		localStorage.setItem(key, value)
	} catch {
		// Unavailable: the value lasts this visit.
	}
}

export function remove(key: string) {
	try {
		localStorage.removeItem(key)
	} catch {
		// Unavailable: nothing stored to remove.
	}
}

/** The parsed value under `key`; `fallback` when missing, unreadable or broken JSON. Callers validate its shape. */
export function readJSON(key: string, fallback: unknown): unknown {
	try {
		const raw = localStorage.getItem(key)
		return raw === null ? fallback : JSON.parse(raw)
	} catch {
		return fallback
	}
}

export function writeJSON(key: string, value: unknown) {
	writeString(key, JSON.stringify(value))
}
