// Trainer → Songs: imported songs, kept on this device only (IndexedDB: a song
// can be larger than localStorage allows). Each record holds the Song as read
// at import (so playing it never loads alphaTab again) and the file's bytes,
// should a later Pluck read files better. Nothing leaves the device.
import type { Song } from '../../music/song'

const DB = 'pluck-songs'
const STORE = 'songs'

export interface StoredSong {
	id: string
	fileName: string
	addedAt: number
	song: Song
	bytes: ArrayBuffer
}

let opening: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
	opening ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB, 1)
		request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => {
			opening = null
			reject(request.error)
		}
	})
	return opening
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return db().then(
		(database) =>
			new Promise<T>((resolve, reject) => {
				const request = work(database.transaction(STORE, mode).objectStore(STORE))
				request.onsuccess = () => resolve(request.result)
				request.onerror = () => reject(request.error)
			})
	)
}

/** Every imported song, oldest first; [] where storage is unavailable (private mode). */
export async function list(): Promise<StoredSong[]> {
	try {
		const all = await run<StoredSong[]>('readonly', (store) => store.getAll())
		return all.sort((a, b) => a.addedAt - b.addedAt)
	} catch {
		return []
	}
}

export const save = (record: StoredSong) => run('readwrite', (store) => store.put(record))

export const remove = (id: string) => run('readwrite', (store) => store.delete(id))
