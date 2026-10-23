// Trainer → Songs: a whole song on the Tab strip, played by Pluck at the speed
// set, with jumps by bars and seconds and an A–B loop. No microphone: this is a
// player to read and play along with (docs/adr/0012). The song model is
// ts/music/song.ts, the built-in songs ts/music/songs-catalog.ts, imported files
// ts/music/song-import.ts (alphaTab, loaded on the first import) kept by
// ./songs.store.ts; ./songs.player.ts keeps the time. This view draws and wires.
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { clamp } from '../../core/math'
import { plural, t } from '../../core/i18n'
import type { View } from '../../ui/view'
import { liveRegion, onBareKey, scoped, setPressed } from '../../ui/dom'
import { reducedMotion } from '../../ui/media'
import { detent } from '../../ui/feedback'
import { screenLock } from '../../ui/screen-lock'
import { bindTempoKeys, numberField, onPress } from '../../ui/tempo'
import { placeStrip, stringY, stripParts } from '../../ui/tab-strip'
import type { Song } from '../../music/song'
import { BUILTIN } from '../../music/songs-catalog'
import { createPlayer, type Player, type PlayerAudio } from './songs.player'
import * as Store from './songs.store'

// Paper per quarter note: enough for the closest notes of the song to read
// apart (a fret number is ~22 px wide), within these bounds.
const MIN_QUARTER_PX = 48
const MAX_QUARTER_PX = 112
const NOTE_PX = 28
// Bar numbers and beats are drawn just inside the bar line (trainer.css .tab-bar).
const BAR_LINE_LEAD = 0.25
const TICK_MS = 25
// The position fader's resolution (0 = the top, SEEK_STEPS = the end).
const SEEK_STEPS = 1000
// A second tap on × within this removes an imported song.
const ARM_MS = 3000

interface Entry {
	song: Song
	imported: boolean
	format?: string
}

const formatOf = (fileName: string) => (/\.(xml|musicxml|mxl)$/i.test(fileName) ? 'MusicXML' : 'Guitar Pro')

/** m:ss of listening. */
const clock = (seconds: number) => {
	const s = Math.max(0, Math.round(seconds))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function createSongsView(root: HTMLElement): View {
	const { $, $$ } = scoped(root)
	const stage = $<HTMLElement>('.songs-stage')
	const setup = $<HTMLElement>('.songs-setup')
	const source = $<HTMLElement>('.songs-source')
	const title = $<HTMLElement>('.songs-title')
	const artist = $<HTMLElement>('.songs-artist')
	const paper = $<HTMLElement>('.songs-paper')
	const strip = $<HTMLElement>('.songs-strip')
	const map = $<HTMLElement>('.songs-map')
	const mapLabels = $<HTMLElement>('.songs-map__labels')
	const mapBars = $<HTMLElement>('.songs-map__bars')
	const seek = $<HTMLInputElement>('.songs-seek')
	const where = $<HTMLElement>('.songs-where')
	const time = $<HTMLElement>('.songs-time')
	const playKey = $<HTMLButtonElement>('.songs-play')
	const markKeys = $$<HTMLButtonElement>('.songs-mark')
	const loopKey = $<HTMLButtonElement>('.songs-loop__key')
	const announce = liveRegion($('.songs-live'), { throttleMs: 2000 })
	const speedInput = $<HTMLInputElement>('.songs-setup .tab-tempo .lcd-number')
	const slider = $<HTMLInputElement>('.songs-slider')
	const bpm = $<HTMLElement>('.songs-bpm')
	const volume = $<HTMLInputElement>('.songs-volume__slider')
	const trackSelect = $<HTMLSelectElement>('.songs-track')
	const list = $<HTMLElement>('.songs-list')
	const filterChips = $$<HTMLButtonElement>('[data-song-filter]')
	const fileInput = $<HTMLInputElement>('.songs-file')
	const message = $<HTMLElement>('.songs-message')

	let imported: Entry[] = []
	const builtins: Entry[] = BUILTIN.map((song) => ({ song, imported: false }))
	const entries = () => [...builtins, ...imported]
	const current = () => entries().find((e) => e.song.id === Settings.get().songId) ?? builtins[0]

	/* Clock and sound ----------------------------------------------------------- */
	// Notes and clicks on the synth's own context: one clock, so the strip, the
	// notes and the beat cannot drift apart.
	const audio: PlayerAudio = {
		now: () => Sound.audio().currentTime,
		heardAfter: () => (Sound.audio().outputLatency || 0) + Settings.get().audioDelayMs / 1000,
		// Squared, as the Metronome's volume: the fader's middle sounds like half as loud.
		pluck: (midi, at, length, gain) => Sound.play(midi, at - Sound.audio().currentTime, gain * Settings.get().songVolume ** 2, 0, length),
		click: (at, accented) => Sound.click(at - Sound.audio().currentTime, accented, Settings.get().metroVolume),
		stop: () => Sound.stopAll(),
	}
	const options = () => {
		const s = Settings.get()
		return { speed: s.songSpeed, listen: s.songListen, click: s.songClick, countIn: s.songCountIn, track: trackIndex() }
	}
	const trackIndex = () => Math.min(Settings.get().songTrack, current().song.tracks.length - 1)

	let player: Player | null = null
	let loadedId = ''
	let ticker = 0
	let frame = 0
	const wakeLock = screenLock(() => player?.playing() ?? false)

	/* The strip ----------------------------------------------------------------- */
	let quarterPx = MIN_QUARTER_PX
	// Notes in time order, for lighting the one sounding: [quarter, length, element].
	let sounding: { q: number; length: number; el: HTMLElement }[] = []
	let lit: HTMLElement | null = null
	let band: HTMLElement | null = null
	// Each played bar's number on the paper; the one being heard is lit.
	let barNumbers: HTMLElement[] = []
	let litNumber: HTMLElement | null = null

	function drawStrip() {
		const { song } = current()
		const tl = player!.timeline
		const bars = song.tracks[trackIndex()].bars
		// The closest two note starts in the song set the paper's scale.
		let closest = 4
		for (const notes of bars)
			for (let i = 1; i < notes.length; i++) {
				const gap = notes[i].at - notes[i - 1].at
				if (gap > 1e-6) closest = Math.min(closest, gap)
			}
		quarterPx = clamp(NOTE_PX / closest, MIN_QUARTER_PX, MAX_QUARTER_PX)
		const q = quarterPx
		const { parts, el } = stripParts()
		sounding = []
		barNumbers = []
		litNumber = null
		tl.slots.forEach((slot, i) => {
			const x = slot.quarter * q
			const bar = song.bars[slot.bar]
			const line = x - BAR_LINE_LEAD * q
			if (i) el('tab-bar', line)
			barNumbers.push(el('songs-barno', line, String(slot.bar + 1)))
			if (bar.section) el('songs-section', x, bar.section)
			const beat = 4 / bar.unit
			for (let k = 0; k * beat < slot.quarters - 1e-6; k++) el('tab-beat', x + k * beat * q, String(k + 1))
			for (const note of bars[slot.bar] ?? []) {
				const nx = x + note.at * q
				const y = stringY(note.string)
				if (note.tech === 'x') {
					sounding.push({ q: slot.quarter + note.at, length: note.length, el: el('tab-n', nx, 'x', y) })
					continue
				}
				if (note.tech) el('tab-tech', nx + (note.length * q) / 2, note.tech, y - 15)
				const label = note.bend ? `${note.fret}b${note.fret + note.bend}` : note.tied ? `(${note.fret})` : String(note.fret)
				sounding.push({ q: slot.quarter + note.at, length: note.length, el: el('tab-n', nx, label, y) })
			}
		})
		band = el('songs-ab', 0)
		band.hidden = true
		strip.style.width = `${(tl.quarters + 4) * q}px`
		strip.replaceChildren(...parts)
		sounding.sort((a, b) => a.q - b.q)
		lit = null
	}

	/** The note sounding at quarter `at` (the last one started, while it lasts). */
	function noteAt(at: number): HTMLElement | null {
		let lo = 0
		let hi = sounding.length - 1
		let found = -1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (sounding[mid].q <= at + 1e-6) {
				found = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		const note = sounding[found]
		return note && at < note.q + Math.max(note.length, 0.25) ? note.el : null
	}

	function light(el: HTMLElement | null) {
		if (el === lit) return
		lit?.classList.remove('tab-n--now')
		el?.classList.add('tab-n--now')
		lit = el
	}

	/* The map: the written bars by section, the loop and where the song is -------- */
	let cells: HTMLElement[] = []
	function drawMap() {
		const { song } = current()
		const starts = song.bars.flatMap((bar, i) => (bar.section ? [i] : []))
		// Each name as wide as its section's bars; before the first section, room without a name.
		const label = (bars: number, text = '') => Object.assign(document.createElement('span'), { textContent: text, style: `flex:${bars}` })
		mapLabels.replaceChildren(
			...(starts[0] > 0 ? [label(starts[0])] : []),
			...starts.map((start, k) => label((starts[k + 1] ?? song.bars.length) - start, song.bars[start].section))
		)
		mapLabels.hidden = !starts.length
		cells = song.bars.map((_, i) => {
			const cell = document.createElement('i')
			cell.className = 'songs-map__bar'
			cell.classList.toggle('is-start', i > 0 && starts.includes(i))
			return cell
		})
		mapBars.replaceChildren(...cells)
	}

	/* Showing where the song is ---------------------------------------------------- */
	let shownBar = -1
	function showPosition(smooth = false) {
		if (!player) return
		const tl = player.timeline
		const slot = tl.slots[player.slot()]
		const at = player.quarter()
		placeStrip(strip, at * quarterPx, smooth)
		// The bar heard: its number in red, so the one under the playhead's arrow is not taken for the next.
		const number = barNumbers[player.slot()] ?? null
		if (number !== litNumber) {
			litNumber?.classList.remove('is-now')
			number?.classList.add('is-now')
			litNumber = number
		}
		if (!seeking) seek.value = String(Math.round((player.position() / tl.duration) * SEEK_STEPS))
		light(player.playing() && !player.countingIn() ? noteAt(at) : null)
		const rate = Settings.get().songSpeed / 100
		const bars = current().song.bars.length
		const bar = slot ? slot.bar + 1 : 1
		const text =
			slot && slot.passes > 1
				? `${t('Bar {n} / {bars}', { n: bar, bars })} · ${t('pass {n} / {passes}', { n: slot.pass, passes: slot.passes })}`
				: t('Bar {n} / {bars}', { n: bar, bars })
		if (where.textContent !== text) where.textContent = text
		const clocks = `${clock(player.position() / rate)} / ${clock(tl.duration / rate)}`
		if (time.textContent !== clocks) {
			time.textContent = clocks
			seek.setAttribute('aria-valuetext', clocks)
		}
		if (bar !== shownBar) {
			cells[shownBar - 1]?.classList.remove('is-now')
			cells[bar - 1]?.classList.add('is-now')
			shownBar = bar
			paper.setAttribute('aria-label', t('Tab of {title}, bar {n}', { title: titleOf(current()), n: bar }))
			map.setAttribute('aria-label', t('Song map, bar {n} of {bars}: tap a bar for A, another for B', { n: bar, bars }))
		}
	}

	function showLoop() {
		if (!player) return
		const { a, b, on } = player.loop()
		const slots = player.timeline.slots
		markKeys.forEach((key) => {
			const at = key.dataset.mark === 'a' ? a : b
			key.setAttribute('aria-pressed', String(at !== null))
			key.querySelector('.lamp')!.classList.toggle('is-on', at !== null)
			key.querySelector('small')!.textContent = at === null ? '' : String(slots[at].bar + 1)
		})
		setPressed([loopKey], () => on)
		loopKey.disabled = a === null || b === null
		// The band over the strip, and the bars it spans on the map.
		if (band) {
			band.hidden = a === null && b === null
			const from = slots[a ?? b ?? 0]
			const to = slots[b ?? a ?? 0]
			if (from && to) {
				band.style.left = `${(from.quarter - BAR_LINE_LEAD) * quarterPx}px`
				band.style.width = `${(to.quarter + to.quarters - from.quarter) * quarterPx}px`
				band.classList.toggle('is-open', a === null || b === null)
			}
		}
		const lo = a === null ? null : slots[a].bar
		const hi = b === null ? lo : slots[b].bar
		cells.forEach((cell, i) => cell.classList.toggle('is-loop', lo !== null && hi !== null && i >= Math.min(lo, hi) && i <= Math.max(lo, hi)))
	}

	/* Loading a song ------------------------------------------------------------- */
	const titleOf = (entry: Entry) => (entry.imported ? entry.song.title : t(entry.song.title))

	function load() {
		const entry = current()
		if (player && loadedId === `${entry.song.id}:${trackIndex()}`) return
		stopRunning()
		player?.stop()
		showPlaying()
		loadedId = `${entry.song.id}:${trackIndex()}`
		player = createPlayer(entry.song, audio, options(), ended)
		const { song } = entry
		const track = song.tracks[trackIndex()]
		title.textContent = titleOf(entry)
		artist.textContent = song.artist
		artist.hidden = !song.artist
		const name = entry.imported ? track.name : t(track.name)
		source.textContent = entry.imported ? `${t('Imported')} · ${entry.format} · ${name}` : `${t('Built in')} · ${t('public domain')}`
		drawStrip()
		drawMap()
		shownBar = -1
		showPosition()
		showLoop()
		renderTracks()
	}

	function renderTracks() {
		const { song, imported: own } = current()
		trackSelect.replaceChildren(
			...song.tracks.map((track, i) => {
				const option = document.createElement('option')
				option.value = String(i)
				option.textContent = own ? track.name : t(track.name)
				return option
			})
		)
		trackSelect.value = String(trackIndex())
		trackSelect.disabled = song.tracks.length < 2
	}

	/* Transport ------------------------------------------------------------------ */
	function run() {
		clearInterval(ticker)
		ticker = setInterval(() => player?.tick(), TICK_MS) as unknown as number
		if (!frame) frame = requestAnimationFrame(animate)
		wakeLock.hold()
	}

	function stopRunning() {
		clearInterval(ticker)
		ticker = 0
		if (frame) cancelAnimationFrame(frame)
		frame = 0
		wakeLock.release()
	}

	function animate() {
		frame = 0
		showPosition()
		if (player?.playing()) frame = requestAnimationFrame(animate)
	}

	function showPlaying() {
		const playing = player?.playing() ?? false
		playKey.textContent = playing ? t('Pause') : t('Play')
		playKey.classList.toggle('key--hot', !playing)
	}

	function ended() {
		stopRunning()
		showPlaying()
		showPosition()
		announce(t('End of the song'), true)
	}

	function toggle() {
		if (!player) return
		if (player.playing()) {
			player.pause()
			stopRunning()
		} else {
			player.play()
			run()
		}
		showPlaying()
		showPosition()
	}

	function pause() {
		if (!player?.playing()) return
		player.pause()
		stopRunning()
		showPlaying()
	}

	playKey.addEventListener('click', toggle)
	onBareKey([root, stage], ['Space'], () => playKey.click())
	for (const key of $$<HTMLButtonElement>('[data-bars]'))
		onPress(key, () => {
			player?.jumpBars(Number(key.dataset.bars))
			showPosition(!player?.playing())
		})
	for (const key of $$<HTMLButtonElement>('[data-seconds]'))
		onPress(key, () => {
			player?.jumpSeconds(Number(key.dataset.seconds))
			showPosition(!player?.playing())
		})
	// The position fader, as on a video: drag anywhere in the song. While the finger
	// is on it, the clock does not move it back.
	let seeking = false
	seek.max = String(SEEK_STEPS)
	seek.addEventListener('pointerdown', () => {
		seeking = true
	})
	for (const type of ['pointerup', 'pointercancel', 'change'] as const)
		seek.addEventListener(type, () => {
			seeking = false
		})
	seek.addEventListener('input', () => {
		if (!player) return
		player.seek((Number(seek.value) / SEEK_STEPS) * player.timeline.duration)
		showPosition()
	})
	// Tapping the map: the first bar tapped is A, the next B (the loop starts), a third starts over.
	function slotOf(bar: number, from: number) {
		const slots = player!.timeline.slots
		const after = slots.findIndex((slot, i) => i >= from && slot.bar === bar)
		return after >= 0 ? after : slots.findIndex((slot) => slot.bar === bar)
	}
	map.addEventListener('pointerdown', (event) => {
		if (!player || event.button !== 0) return
		const box = mapBars.getBoundingClientRect()
		const bars = current().song.bars.length
		const bar = Math.max(0, Math.min(bars - 1, Math.floor(((event.clientX - box.left) / box.width) * bars)))
		const { a, b } = player.loop()
		if (a === null || b !== null) {
			player.setLooping(false)
			player.setMarks(slotOf(bar, player.slot()), null)
			announce(t('Loop from bar {n}: tap the bar it ends on', { n: bar + 1 }), true)
		} else {
			player.setMarks(a, slotOf(bar, a))
			player.setLooping(true)
			const { a: from, b: to } = player.loop()
			const slots = player.timeline.slots
			announce(t('Loop from bar {a} to bar {b}', { a: slots[from!].bar + 1, b: slots[to!].bar + 1 }), true)
		}
		showLoop()
		showPosition(!player.playing())
	})
	for (const key of markKeys)
		key.addEventListener('click', () => {
			player?.mark(key.dataset.mark as 'a' | 'b')
			showLoop()
		})
	loopKey.addEventListener('click', () => {
		if (!player) return
		player.setLooping(!player.loop().on)
		showLoop()
		announce(player.loop().on ? t('Loop on') : t('Loop off'), true)
	})

	// A hidden page stalls the timer: what it scheduled would run out mid-bar.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) pause()
	})

	/* Setup ------------------------------------------------------------------------ */
	const setSpeed = (speed: number) => Settings.update({ songSpeed: clamp(Math.round(speed), Settings.MIN_SONG_SPEED, Settings.MAX_SONG_SPEED) })
	bindTempoKeys(setup.querySelectorAll<HTMLElement>('[data-tempo]'), (by) => setSpeed(Settings.get().songSpeed + by))
	slider.addEventListener('input', () => setSpeed(Number(slider.value)))
	const speedField = numberField(speedInput, () => Settings.get().songSpeed, setSpeed)
	// Back to the song's own tempo.
	onPress($('.songs-reset'), () => setSpeed(100))
	volume.addEventListener('input', () => Settings.update({ songVolume: Number(volume.value) }))
	for (const input of $$<HTMLInputElement>('[data-song-option]'))
		input.addEventListener('change', () => Settings.update({ [input.dataset.songOption!]: input.checked }))
	trackSelect.addEventListener('change', () => {
		detent()
		Settings.update({ songTrack: Number(trackSelect.value) })
	})
	for (const chip of filterChips)
		chip.addEventListener('click', () => Settings.update({ songFilter: chip.dataset.songFilter as Settings.Settings['songFilter'] }))

	function renderSetup() {
		const s = Settings.get()
		speedField.show(s.songSpeed)
		slider.value = String(s.songSpeed)
		volume.value = String(s.songVolume)
		const tempo = current().song.bars[0]?.tempo ?? 100
		bpm.textContent = t('♩ = {bpm} · original {original}', { bpm: Math.round((tempo * s.songSpeed) / 100), original: Math.round(tempo) })
		for (const input of $$<HTMLInputElement>('[data-song-option]'))
			input.checked = Boolean(s[input.dataset.songOption as 'songListen' | 'songClick' | 'songCountIn'])
		setPressed(filterChips, (chip) => chip.dataset.songFilter === s.songFilter)
		renderList()
	}

	function metaOf({ song }: Entry) {
		// The song's usual meter (a pickup bar has its own).
		const meters = new Map<string, number>()
		for (const bar of song.bars) meters.set(`${bar.beats}/${bar.unit}`, (meters.get(`${bar.beats}/${bar.unit}`) ?? 0) + 1)
		const meter = [...meters].sort((a, b) => b[1] - a[1])[0][0]
		const parts = [song.artist, meter, plural(song.bars.length, '{n} bar', '{n} bars'), `♩ = ${Math.round(song.bars[0].tempo)}`]
		return parts.filter(Boolean).join(' · ')
	}

	function renderList() {
		const s = Settings.get()
		const shown = entries().filter((e) => s.songFilter === 'all' || (s.songFilter === 'imported') === e.imported)
		if (!shown.length) {
			const empty = document.createElement('li')
			empty.className = 'songs-empty'
			empty.textContent = t('No songs imported yet. Import a Guitar Pro or MusicXML file.')
			list.replaceChildren(empty)
			return
		}
		list.replaceChildren(
			...shown.map((entry) => {
				const on = entry.song.id === current().song.id
				const name = titleOf(entry)
				const li = document.createElement('li')
				li.className = 'tab-ex'
				li.classList.toggle('is-on', on)
				li.innerHTML =
					'<span class="tab-ex__text"><span class="tab-ex__head"><span class="tab-ex__name"></span><span class="tab-tag"></span></span><span class="tab-ex__meta"></span></span>' +
					'<span class="songs-row-keys"><button class="key key--dark tab-ex__load" type="button">▶</button></span>'
				li.querySelector('.tab-ex__name')!.textContent = name
				li.querySelector('.tab-tag')!.textContent = entry.imported ? t('Imported') : t('Built in')
				li.querySelector('.tab-ex__meta')!.textContent = metaOf(entry)
				const loadKey = li.querySelector<HTMLButtonElement>('.tab-ex__load')!
				loadKey.setAttribute('aria-pressed', String(on))
				loadKey.setAttribute('aria-label', t('Load {name}', { name }))
				loadKey.addEventListener('click', () => {
					Settings.update({ songId: entry.song.id, songTrack: 0 })
					window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' })
				})
				if (entry.imported) li.querySelector('.songs-row-keys')!.prepend(removeKey(entry, name))
				return li
			})
		)
	}

	// Two taps to remove an imported song: the first lights the key, the second (within ARM_MS) removes.
	function removeKey(entry: Entry, name: string) {
		const key = document.createElement('button')
		key.type = 'button'
		key.className = 'key key--step songs-remove'
		key.textContent = '×'
		key.setAttribute('aria-label', t('Remove {name}', { name }))
		let armed = 0
		key.addEventListener('click', async () => {
			if (!armed) {
				key.classList.add('is-armed')
				key.textContent = t('Remove')
				armed = setTimeout(() => {
					armed = 0
					key.classList.remove('is-armed')
					key.textContent = '×'
				}, ARM_MS) as unknown as number
				return
			}
			clearTimeout(armed)
			await Store.remove(entry.song.id).catch(() => {})
			imported = imported.filter((e) => e !== entry)
			message.textContent = t('Removed {name}', { name })
			if (Settings.get().songId === entry.song.id) Settings.update({ songId: builtins[0].song.id, songTrack: 0 })
			else renderList()
		})
		return key
	}

	/* Import ----------------------------------------------------------------------- */
	$('.songs-import').addEventListener('click', () => fileInput.click())
	fileInput.addEventListener('change', async () => {
		const files = [...(fileInput.files ?? [])]
		fileInput.value = ''
		if (!files.length) return
		message.textContent = t('Reading…')
		let last = ''
		const failed: string[] = []
		for (const file of files) {
			try {
				const bytes = new Uint8Array(await file.arrayBuffer())
				const id = `file:${crypto.randomUUID()}`
				const { importSong } = await import('../../music/song-import')
				const song = await importSong(bytes, file.name, id)
				const record: Store.StoredSong = { id, fileName: file.name, addedAt: Date.now(), song, bytes: bytes.buffer as ArrayBuffer }
				await Store.save(record).catch(() => {})
				imported.push({ song, imported: true, format: formatOf(file.name) })
				last = id
			} catch (error) {
				console.error('Import failed:', file.name, error)
				failed.push(file.name)
			}
		}
		message.textContent = failed.length
			? t('Could not read {names}: not a Guitar Pro or MusicXML file.', { names: failed.join(', ') })
			: plural(files.length, 'Imported {n} song.', 'Imported {n} songs.')
		if (last) Settings.update({ songId: last, songTrack: 0 })
		else renderList()
	})

	/* Settings ------------------------------------------------------------------------ */
	Settings.subscribe(() => {
		if (Settings.get().trainerExercise !== 'songs' || root.hidden) return
		load()
		player?.setOptions(options())
		renderSetup()
		showPosition()
	})

	// Imported songs come from storage once; the song saved last time may be one.
	const ready = Store.list().then((records) => {
		imported = records.map((r) => ({ song: r.song, imported: true, format: formatOf(r.fileName) }))
	})

	return {
		onActivate() {
			message.textContent = ''
			load()
			renderSetup()
			showPlaying()
			void ready.then(() => {
				if (Settings.get().trainerExercise !== 'songs' || root.hidden) return
				load()
				renderSetup()
			})
		},
		// Leaving the exercise or the tab: the song stops where it is.
		reset() {
			pause()
		},
		onReading() {},
		wantsMic: () => false,
	}
}
