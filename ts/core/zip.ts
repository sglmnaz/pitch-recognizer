// A .zip of a few files, stored (not compressed): field reports are opus audio
// and a short log, so deflate would gain little. Format: PKWARE APPNOTE 4.3/4.4.
// ponytail: no zip64, so under 4 GB and 65535 files; plenty for 3 reports.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	return c >>> 0
})

function crc32(bytes: Uint8Array) {
	let c = 0xffffffff
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

/** The files in one zip, each dated `when`. */
export async function zip(files: readonly File[], when = new Date()): Promise<Blob> {
	const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)
	const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
	const parts: BlobPart[] = []
	const central: Uint8Array<ArrayBuffer>[] = []
	let offset = 0
	for (const file of files) {
		const data = new Uint8Array(await file.arrayBuffer())
		const name = new TextEncoder().encode(file.name)
		const crc = crc32(data)
		// The fields a local header and its central directory entry share, from "version needed" on.
		const common = (view: DataView, at: number) => {
			view.setUint16(at, 20, true)
			view.setUint16(at + 2, 0x0800, true) // UTF-8 names
			view.setUint16(at + 4, 0, true) // stored
			view.setUint16(at + 6, time, true)
			view.setUint16(at + 8, date, true)
			view.setUint32(at + 10, crc, true)
			view.setUint32(at + 14, data.length, true)
			view.setUint32(at + 18, data.length, true)
			view.setUint16(at + 22, name.length, true)
		}
		const local = new Uint8Array(30 + name.length)
		const lv = new DataView(local.buffer)
		lv.setUint32(0, 0x04034b50, true)
		common(lv, 4)
		local.set(name, 30)
		const entry = new Uint8Array(46 + name.length)
		const ev = new DataView(entry.buffer)
		ev.setUint32(0, 0x02014b50, true)
		ev.setUint16(4, 20, true) // made by
		common(ev, 6)
		ev.setUint32(42, offset, true)
		entry.set(name, 46)
		parts.push(local, data)
		central.push(entry)
		offset += local.length + data.length
	}
	const size = central.reduce((sum, entry) => sum + entry.length, 0)
	const end = new Uint8Array(22)
	const nv = new DataView(end.buffer)
	nv.setUint32(0, 0x06054b50, true)
	nv.setUint16(8, files.length, true)
	nv.setUint16(10, files.length, true)
	nv.setUint32(12, size, true)
	nv.setUint32(16, offset, true)
	return new Blob([...parts, ...central, end], { type: 'application/zip' })
}
