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
import { screenLock } from '../../ui/screen-lock'
import { bindTempoKeys, numberField, onPress } from '../../ui/tempo'
import { placeStrip, stringY, stripParts } from '../../ui/tab-strip'
import { createScoreScreen, type ScoreSpec, unitPxFor, type VerticalScore } from '../../ui/vertical-score'
import { secondsAtQuarter, type Song, type Timeline } from '../../music/song'
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
// The full-screen score: paper per quarter between these (unitPxFor: more where notes are close);
// 150 is a 16th's room for a token, and a quarter at 120 BPM crosses a phone in about 2 s.
const MIN_SCORE_PX = 56
const MAX_SCORE_PX = 150
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
	const papers = $<HTMLElement>('.songs-papers')
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
	const tracksBox = $<HTMLElement>('.songs-tracks')
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
	// currentTime moves in whole audio blocks (10–40 ms on Android phones): read as is, the
	// notes moved in steps, plain to see at slow speeds. Between two steps it runs on
	// performance.now(), never back and never more than 50 ms past the last step.
	let step = { at: -1, perf: 0, last: 0 }
	const now = () => {
		const at = Sound.audio().currentTime
		const perf = performance.now()
		if (at !== step.at) step = { at, perf, last: step.last }
		step.last = Math.max(step.last > at + 0.05 ? at : step.last, at + Math.min(0.05, (perf - step.perf) / 1000))
		return step.last
	}
	const audio: PlayerAudio = {
		now,
		heardAfter: () => (Sound.audio().outputLatency || 0) + Settings.get().audioDelayMs / 1000,
		// Squared, as the Metronome's volume: the fader's middle sounds like half as loud.
		pluck: (midi, at, length, gain, bend) => Sound.play(midi, at - Sound.audio().currentTime, gain * Settings.get().songVolume ** 2, 0, length, bend),
		click: (at, accented) => Sound.click(at - Sound.audio().currentTime, accented, Settings.get().metroVolume),
		stop: () => Sound.stopAll(),
	}
	const options = () => {
		const s = Settings.get()
		return { speed: s.songSpeed, listen: s.songListen, click: s.songClick, countIn: s.songCountIn, tracks: activeTracks() }
	}
	/** The tracks played, those of the song only; none of them = the first. */
	const activeTracks = () => {
		const count = current().song.tracks.length
		const on = Settings.get().songTracks.filter((i) => i < count)
		return on.length ? on : [0]
	}
	const trackName = (entry: Entry, i: number) => (entry.imported ? entry.song.tracks[i].name : t(entry.song.tracks[i].name))

	let player: Player | null = null
	let loadedId = ''
	let ticker = 0
	let frame = 0
	const wakeLock = screenLock(() => player?.playing() ?? false)

	/* The strips: one per track played, all on one scale and one clock --------------- */
	let quarterPx = MIN_QUARTER_PX

	interface Strip {
		track: number
		paper: HTMLElement
		strip: HTMLElement
		// Notes in time order, for lighting those sounding: [quarter, length, element].
		sounding: { q: number; length: number; el: HTMLElement }[]
		lit: HTMLElement[]
		band: HTMLElement
		// Each played bar's number on the paper; the one being heard is lit.
		barNumbers: HTMLElement[]
		litNumber: HTMLElement | null
	}
	let strips: Strip[] = []
	let drawnStrips = ''

	/** A window of tab paper (still playhead, a moving strip), named when several are shown. */
	function newPaper(name: string) {
		const box = document.createElement('div')
		box.className = 'songs-strip-box'
		box.innerHTML =
			'<span class="silk songs-strip-name"></span><div class="window"><div class="tab-paper" role="img"><span class="tab-strings" aria-hidden="true"></span>' +
			'<div class="tab-track" aria-hidden="true"><div class="tab-strip"></div></div>' +
			'<span class="tab-now" aria-hidden="true"></span></div></div>'
		const label = box.querySelector<HTMLElement>('.songs-strip-name')!
		label.textContent = name
		label.hidden = !name
		return { box, paper: box.querySelector<HTMLElement>('.tab-paper')!, strip: box.querySelector<HTMLElement>('.tab-strip')! }
	}

	function drawStrips() {
		const entry = current()
		const tracks = activeTracks()
		drawnStrips = `${entry.song.id}:${tracks.join()}`
		// The closest two note starts of the tracks shown set the paper's scale, the same for all.
		let closest = 4
		for (const track of tracks)
			for (const notes of entry.song.tracks[track].bars)
				for (let i = 1; i < notes.length; i++) {
					const gap = notes[i].at - notes[i - 1].at
					if (gap > 1e-6) closest = Math.min(closest, gap)
				}
		quarterPx = clamp(NOTE_PX / closest, MIN_QUARTER_PX, MAX_QUARTER_PX)
		const boxes: HTMLElement[] = []
		strips = tracks.map((track) => {
			const { box, paper, strip } = newPaper(tracks.length > 1 ? trackName(entry, track) : '')
			boxes.push(box)
			return drawStrip(track, paper, strip)
		})
		papers.replaceChildren(...boxes)
	}

	function drawStrip(track: number, paper: HTMLElement, strip: HTMLElement): Strip {
		const { song } = current()
		const tl = player!.timeline
		const bars = song.tracks[track].bars
		const q = quarterPx
		const { parts, el, mark } = stripParts()
		const sounding: Strip['sounding'] = []
		const barNumbers: HTMLElement[] = []
		// The note before on each string: a legato or slide is drawn from it.
		const before = new Map<number, number>()
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
				const from = before.get(note.string)
				if (note.tech && from !== undefined) mark(note.tech, from, nx, y)
				if (note.bend) mark('b', nx, nx, y, note.fret + note.bend)
				before.set(note.string, nx)
				const label = note.tied ? `(${note.fret})` : String(note.fret)
				sounding.push({ q: slot.quarter + note.at, length: note.length, el: el('tab-n', nx, label, y) })
			}
		})
		const band = el('songs-ab', 0)
		band.hidden = true
		strip.style.width = `${(tl.quarters + 4) * q}px`
		strip.replaceChildren(...parts)
		sounding.sort((a, b) => a.q - b.q)
		return { track, paper, strip, sounding, lit: [], band, barNumbers, litNumber: null }
	}

	/** The notes sounding at quarter `at`: those struck last (a chord, a double stop: all of them), while they last. */
	function notesAt({ sounding }: Strip, at: number): HTMLElement[] {
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
		const struck = sounding[found]?.q
		const out: HTMLElement[] = []
		for (let i = found; i >= 0 && Math.abs(sounding[i].q - struck) < 1e-6; i--)
			if (at < sounding[i].q + Math.max(sounding[i].length, 0.25)) out.push(sounding[i].el)
		return out
	}

	function light(strip: Strip, els: HTMLElement[]) {
		const { lit } = strip
		if (els.length === lit.length && els.every((el) => lit.includes(el))) return
		for (const el of lit) el.classList.remove('tab-n--now')
		for (const el of els) el.classList.add('tab-n--now')
		strip.lit = els
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
		const sounding = player.playing() && !player.countingIn()
		for (const strip of strips) {
			placeStrip(strip.strip, at * quarterPx, smooth)
			// The bar heard: its number in red, so the one under the playhead's arrow is not taken for the next.
			const number = strip.barNumbers[player.slot()] ?? null
			if (number !== strip.litNumber) {
				strip.litNumber?.classList.remove('is-now')
				number?.classList.add('is-now')
				strip.litNumber = number
			}
			light(strip, sounding ? notesAt(strip, at) : [])
		}
		if (screen.isOpen() && scrubAt === null) for (const score of scores) score.place(at, sounding)
		if (!seeking) seek.value = String(Math.round((player.position() / tl.duration) * SEEK_STEPS))
		const rate = Settings.get().songSpeed / 100
		const bars = current().song.bars.length
		const bar = slot ? slot.bar + 1 : 1
		// The part of the song heard (Solo, Chorus…): the last section named at or before this bar, as in the file.
		let section = ''
		for (let i = bar - 1; i >= 0 && !section; i--) section = current().song.bars[i].section ?? ''
		const barText = section ? `${t('Bar {n} / {bars}', { n: bar, bars })} · ${section}` : t('Bar {n} / {bars}', { n: bar, bars })
		const text = slot && slot.passes > 1 ? `${barText} · ${t('pass {n} / {passes}', { n: slot.pass, passes: slot.passes })}` : barText
		if (where.textContent !== text) where.textContent = text
		screen.setText(t('Bar {n} / {bars}', { n: bar, bars }), section)
		showScreenTempo()
		const clocks = `${clock(player.position() / rate)} / ${clock(tl.duration / rate)}`
		if (time.textContent !== clocks) {
			time.textContent = clocks
			seek.setAttribute('aria-valuetext', clocks)
		}
		if (bar !== shownBar) {
			cells[shownBar - 1]?.classList.remove('is-now')
			cells[bar - 1]?.classList.add('is-now')
			shownBar = bar
			for (const strip of strips) {
				const title = strips.length > 1 ? `${titleOf(current())} · ${trackName(current(), strip.track)}` : titleOf(current())
				strip.paper.setAttribute('aria-label', t('Tab of {title}, bar {n}', { title, n: bar }))
			}
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
		setPressed([loopKey, screenLoop], () => on)
		loopKey.disabled = screenLoop.disabled = a === null || b === null
		// The band over each strip and full-screen score, and the bars it spans on the map.
		const from = slots[a ?? b ?? 0]
		const to = slots[b ?? a ?? 0]
		for (const score of scores)
			score.setBand(
				(a === null && b === null) || !from || !to
					? null
					: { from: from.quarter - BAR_LINE_LEAD, to: to.quarter + to.quarters - BAR_LINE_LEAD, open: a === null || b === null }
			)
		for (const { band } of strips) {
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

	/** A new song: a new player. New tracks of the same song: new strips (the player keeps its place and loop). */
	function load() {
		const entry = current()
		if (!player || loadedId !== entry.song.id) {
			stopRunning()
			player?.stop()
			showPlaying()
			loadedId = entry.song.id
			player = createPlayer(entry.song, audio, options(), ended)
			const { song } = entry
			title.textContent = titleOf(entry)
			artist.textContent = song.artist
			artist.hidden = !song.artist
			source.textContent = entry.imported ? `${t('Imported')} · ${entry.format}` : `${t('Built in')} · ${t('public domain')}`
			drawnStrips = ''
			drawMap()
			shownBar = -1
		}
		if (drawnStrips !== `${entry.song.id}:${activeTracks().join()}`) {
			drawStrips()
			if (screen.isOpen()) drawScores()
			shownBar = -1
			showPosition()
			showLoop()
		}
		renderTracks()
	}

	// One row per track with a 0/1 switch; the last one on stays on.
	function renderTracks() {
		const entry = current()
		const on = activeTracks()
		tracksBox.replaceChildren(
			...entry.song.tracks.map((_, i) => {
				const row = document.createElement('label')
				row.className = 'switch'
				row.innerHTML =
					'<span class="switch__text"><span class="switch__title"></span></span><input type="checkbox" class="switch__input" /><span class="switch__track"></span>'
				row.querySelector('.switch__title')!.textContent = trackName(entry, i)
				const input = row.querySelector<HTMLInputElement>('.switch__input')!
				input.checked = on.includes(i)
				input.addEventListener('change', () => {
					const now = activeTracks()
					const next = input.checked ? [...now, i].sort((a, b) => a - b) : now.filter((n) => n !== i)
					if (next.length) Settings.update({ songTracks: next })
					else input.checked = true
				})
				return row
			})
		)
		// One track: nothing to choose.
		tracksBox.closest<HTMLElement>('.songs-tracks-group')!.hidden = entry.song.tracks.length < 2
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
		for (const key of [playKey, screenPlay]) {
			key.textContent = playing ? t('Pause') : t('Play')
			key.classList.toggle('key--hot', !playing)
		}
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

	/* Full screen: the scores upright, one a page (a track each), the keys that matter while playing. */
	const screenKey = (className: string, text: string, label?: string) => {
		const key = document.createElement('button')
		key.type = 'button'
		key.className = className
		key.textContent = text
		if (label) key.setAttribute('aria-label', label)
		return key
	}
	const screenBack4 = screenKey('key key--step', '−4', t('Back 4 bars'))
	const screenBack = screenKey('key key--step', '−1', t('Back 1 bar'))
	const screenPlay = screenKey('btn btn--large key--hot', t('Play'))
	const screenNext = screenKey('key key--step', '+1', t('Forward 1 bar'))
	const screenNext4 = screenKey('key key--step', '+4', t('Forward 4 bars'))
	const screenLoop = screenKey('key key--lit', t('Loop'))
	// A and B as on the page: they mark the bar heard (again clears it), the lamp lit and the bar under the letter.
	const screenMarks = (['a', 'b'] as const).map((which) => {
		const key = screenKey('key score-screen__mark', '')
		key.dataset.mark = which
		key.setAttribute('aria-pressed', 'false')
		key.innerHTML = `<span class="lamp"></span>${which.toUpperCase()}<small></small>`
		key.addEventListener('click', () => {
			player?.mark(which)
			showLoop()
		})
		markKeys.push(key)
		return key
	})
	for (const [key, by] of [
		[screenBack4, -4],
		[screenBack, -1],
		[screenNext, 1],
		[screenNext4, 4],
	] as const)
		onPress(key, () => {
			player?.jumpBars(by)
			showPosition(!player?.playing())
		})
	screenPlay.addEventListener('click', toggle)
	screenLoop.addEventListener('click', () => loopKey.click())
	const screen = createScoreScreen(
		[
			{ el: screenBack4 },
			{ el: screenBack },
			{ el: screenPlay, grow: 1.9 },
			{ el: screenNext },
			{ el: screenNext4 },
			{ el: screenMarks[0], place: 'top' },
			{ el: screenMarks[1], place: 'top' },
			{ el: screenLoop, place: 'top' },
		],
		{
			onClose: () => showPosition(),
			onTempo: (by) => setSpeed(Settings.get().songSpeed + by),
			onScrub: (units, done) => {
				if (!player) return
				const tl = player.timeline
				const last = tl.slots.at(-1)
				const end = last ? last.quarter + last.quarters : 0
				scrubFrom ??= player.quarter()
				const at = clamp(scrubFrom + units, 0, end)
				if (done) {
					scrubFrom = null
					scrubAt = null
					player.seek(secondsAtQuarter(tl, at))
					showPosition(!player.playing())
				} else {
					scrubAt = at
					for (const score of scores) score.place(at, false)
				}
			},
		}
	)
	// While a finger drags the score: where it began and where it stands (the scores stay there).
	let scrubFrom: number | null = null
	let scrubAt: number | null = null
	let scores: VerticalScore[] = []

	function scoreSpec(song: Song, track: number, tl: Timeline, unitPx: number): ScoreSpec {
		const spec: ScoreSpec = { notes: [], bars: [], sections: [], tuning: song.tracks[track].tuning, unitPx }
		for (const slot of tl.slots) {
			spec.bars.push({ at: slot.quarter, label: String(slot.bar + 1) })
			const section = song.bars[slot.bar].section
			if (section) spec.sections!.push({ at: slot.quarter, text: section })
			for (const note of song.tracks[track].bars[slot.bar] ?? [])
				spec.notes.push({
					at: slot.quarter + note.at,
					length: note.length,
					string: note.string,
					label: note.tech === 'x' ? 'x' : note.tied ? `(${note.fret})` : String(note.fret),
					...(note.tech && note.tech !== 'x' ? { tech: note.tech } : {}),
					...(note.bend ? { bentTo: note.fret + note.bend } : {}),
				})
		}
		return spec
	}

	function drawScores() {
		const entry = current()
		const tracks = activeTracks()
		const specs = tracks.map((track) => scoreSpec(entry.song, track, player!.timeline, 0))
		// One scale for every track, so they run together: room for the closest notes of any.
		const unitPx = Math.max(...specs.map((spec) => unitPxFor(spec.notes, MIN_SCORE_PX, MAX_SCORE_PX)))
		scores = screen.setScores(tracks.map((track) => trackName(entry, track)))
		specs.forEach((spec, i) => scores[i].draw({ ...spec, unitPx }))
		showLoop()
	}

	$('.songs-full').addEventListener('click', () => {
		if (!player) return
		drawScores()
		screen.open()
		showPosition()
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
	for (const chip of filterChips)
		chip.addEventListener('click', () => Settings.update({ songFilter: chip.dataset.songFilter as Settings.Settings['songFilter'] }))

	/** The quarter-note tempo of the bar heard, as written. */
	function barTempo() {
		const slot = player?.timeline.slots[player.slot()]
		return current().song.bars[slot?.bar ?? 0]?.tempo ?? 100
	}

	function showScreenTempo() {
		const speed = Settings.get().songSpeed
		screen.setTempo(`${speed} %`, `♩ = ${Math.round((barTempo() * speed) / 100)}`)
	}

	function renderSetup() {
		const s = Settings.get()
		showScreenTempo()
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
					Settings.update({ songId: entry.song.id, songTracks: [0] })
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
			if (Settings.get().songId === entry.song.id) Settings.update({ songId: builtins[0].song.id, songTracks: [0] })
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
		if (last) Settings.update({ songId: last, songTracks: [0] })
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
			screen.close()
		},
		onReading() {},
		wantsMic: () => false,
	}
}
