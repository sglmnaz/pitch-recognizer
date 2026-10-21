// Harmony under the Scales neck (Explore): the scale's chords, common
// progressions in its key and the circle of fifths; in Identify, the scales
// a marked chord fits. The Scales view owns the neck: it asks chord() which
// chord to light and redraws when told to (host.redraw). The circle is drawn
// by ./circle.ts, progressions are played by ./progression-player.ts.
import { createFretboard } from '../../ui/fretboard'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { chordsOfScale, identifyChords } from '../../music/chord-theory'
import { chordShapes, shapeString, voicingSpec, type Voicing } from '../../music/chord-shapes'
import { chordSource, keyName, keyOf, progressionsFor, resolveProgression, scalesForChord, type KeyChord } from '../../music/harmony'
import { pitchClassOf, ROOTS, scaleTitle, spellScale, type ScaleType } from '../../music/scales'
import { shapeNotes } from '../../music/chord-library'
import { OPEN_CHORD_EVENT } from '../../ui/events'
import { liveRegion, scoped, setPressed } from '../../ui/dom'
import { clamp } from '../../core/math'
import { numberField } from '../../ui/tempo'
import { createCircle } from './circle'
import { createProgressionPlayer } from './progression-player'
import { noteName } from '../../music/note-names'
import { t } from '../../core/i18n'

// A strum: low string to high, this far apart (a quick downstroke).
const STRUM_S = 0.025

// The transport key's legend: ▶ while stopped, ■ while it plays.
const PLAY_ICON = '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1 11 7 1 13Z" fill="currentColor"/></svg>'
const STOP_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="currentColor"/></svg>'

type Pane = 'chords' | 'progressions' | 'circle'

export interface HarmonyHost {
	/** Redraw the neck (and this section) after the lit chord changed. */
	redraw(): void
	/** Show this scale in Explore. */
	setScale(rootPc: number, type: ScaleType): void
	/** A chord is about to sound: stop Play scale. */
	stopScale(): void
}

export interface HarmonyState {
	mode: 'explore' | 'identify'
	rootPc: number
	type: ScaleType
	/** Identify: marked notes as MIDI, lowest first. */
	marked: number[]
}

// Chord symbol -> its most playable voicing (chordShapes walks ~10^5 shapes
// the first time; every strum and redraw asks again).
const voicings = new Map<string, Voicing | undefined>()
function voicingOf(chord: KeyChord) {
	if (!voicings.has(chord.symbol)) voicings.set(chord.symbol, chordShapes(chord.rootPc, chord.type, { limit: 1 })[0])
	return voicings.get(chord.symbol)
}

export function createHarmony(root: HTMLElement, host: HarmonyHost) {
	const { $ } = scoped(root)
	const section = $('.harmony')
	const { $$ } = scoped(section)
	const paneButtons = $$<HTMLButtonElement>('[data-pane]')
	const panes = $$('[data-pane-body]')
	const sizeSwitch = $<HTMLInputElement>('[data-action="sevenths"]')
	const chordsNote = $<HTMLElement>('.harmony__note--chords')
	const chordRow = $<HTMLElement>('.harmony-chords')
	const detail = $<HTMLElement>('.chord-detail')
	const detailSymbol = $<HTMLElement>('.chord-detail__symbol')
	const detailName = $<HTMLElement>('.chord-detail__name')
	const detailNotes = $<HTMLElement>('.chord-detail__notes')
	const openLink = $<HTMLAnchorElement>('[data-action="open-chord"]')
	const progNote = $<HTMLElement>('.harmony__note--progressions')
	const keyNote = $<HTMLElement>('.harmony__note--key')
	// Tap the number to type a tempo.
	const bpm = numberField(
		$<HTMLInputElement>('.harmony__bpm .lcd-number'),
		() => Settings.get().progressionBpm,
		(value) => Settings.update({ progressionBpm: clamp(Math.round(value), 60, 140) })
	)
	const loopSwitch = $<HTMLInputElement>('[data-action="loop"]')
	const progList = $<HTMLElement>('.progressions')
	const announce = liveRegion($('.harmony__live'))
	const fits = $<HTMLElement>('.chord-fits')
	const fitsChord = $<HTMLElement>('.chord-fits__chord')
	const fitsList = $<HTMLElement>('.chord-fits__list')
	const diagram = createFretboard($<SVGSVGElement>('.chord-detail__neck'), null, { autoRender: true })

	// The pane picked, and the one showing: a scale without chords or
	// progressions (whole tone) shows the circle, without forgetting the pick.
	let pane: Pane = 'chords'
	let shownPane: Pane = 'chords'
	let state: HarmonyState | null = null
	let chords: KeyChord[] = []
	let selected: number | null = null
	let chordsKey = ''
	let progKey = ''
	let progKeyName = ''
	// Each progression's chords, and the step tapped to hear it alone: its
	// lamp stays lit (and the neck shows it) while it rings.
	let progChords: KeyChord[][] = []
	let preview: { index: number; bar: number } | null = null
	let previewTimer = 0

	/* Controls ------------------------------------------------------------ */
	paneButtons.forEach((button) =>
		button.addEventListener('click', () => {
			pane = button.dataset.pane as Pane
			// Playback belongs to the Progressions pane; the tapped chord lights
			// the neck only while the Chords pane shows.
			if (pane !== 'progressions') stop(false, t('Stopped'))
			endPreview()
			host.redraw()
		})
	)
	sizeSwitch.addEventListener('change', () => Settings.update({ chordView: sizeSwitch.checked ? 'sevenths' : 'triads' }))
	loopSwitch.addEventListener('change', () => Settings.update({ progressionLoop: loopSwitch.checked }))
	for (const button of $$<HTMLButtonElement>('[data-bpm]'))
		button.addEventListener('click', () => Settings.update({ progressionBpm: clamp(Settings.get().progressionBpm + Number(button.dataset.bpm), 60, 140) }))
	$<HTMLButtonElement>('[data-action="strum"]').addEventListener('click', () => {
		if (selected === null) return
		Sound.stopAll()
		strum(chords[selected])
	})
	$<HTMLButtonElement>('[data-action="chord-clear"]').addEventListener('click', () => {
		// The button is about to vanish: focus goes back to the chord it closes.
		if (selected !== null) (chordRow.children[selected] as HTMLElement | undefined)?.focus()
		select(null)
	})
	openLink.addEventListener('click', (event) => {
		event.preventDefault()
		if (selected === null) return
		// Fired first so the dictionary can stash the symbol; the hashchange
		// that switches tabs comes after, asynchronously.
		window.dispatchEvent(new CustomEvent(OPEN_CHORD_EVENT, { detail: { symbol: chords[selected].symbol } }))
		location.hash = '#chords'
	})

	function select(index: number | null) {
		stop()
		selected = index === selected ? null : index
		Sound.stopAll()
		if (selected !== null) strum(chords[selected])
		host.redraw()
	}

	/* Sound --------------------------------------------------------------- */
	/** The chord's most playable voicing, low string to high, `at` seconds from now. */
	function strum(chord: KeyChord, at = 0) {
		host.stopScale()
		const voicing = voicingOf(chord)
		if (!voicing) return
		// The mic ignores the whole note (NOTE_MS), not just its attack, or it
		// would hear the chord as notes played. Callers cut what still sounds
		// (a bar's second strum must not cut its first).
		Sound.strum(shapeNotes(voicing.frets).midis, { step: STRUM_S, at, ringMs: Sound.NOTE_MS, stop: false })
	}

	const player = createProgressionPlayer({
		strum,
		announce,
		bar: () => host.redraw(),
		stopped(redraw) {
			syncProgressions()
			if (redraw) host.redraw()
		},
	})
	const stop = player.stop

	/** Plays one bar of a progression on its own; a progression playing stops. */
	function previewBar(index: number, bar: number) {
		stop()
		Sound.stopAll()
		strum(progChords[index][bar])
		preview = { index, bar }
		clearTimeout(previewTimer)
		previewTimer = window.setTimeout(() => {
			endPreview()
			host.redraw()
		}, Sound.NOTE_MS)
		host.redraw()
	}

	function endPreview() {
		clearTimeout(previewTimer)
		preview = null
		syncProgressions()
	}

	/* Chords -------------------------------------------------------------- */
	function renderChords(rootPc: number, type: ScaleType) {
		const { chordView } = Settings.get()
		const source = chordSource(type)
		const key = `${rootPc}|${type.name}|${chordView}`
		if (key !== chordsKey) {
			// A new scale drops the chord; triads ↔ sevenths keeps its degree.
			if (chordsKey.split('|').slice(0, 2).join('|') !== `${rootPc}|${type.name}`) selected = null
			chordsKey = key
			chords = source
				? chordsOfScale(rootPc, source).map((d) => {
						const c = chordView === 'sevenths' ? d.seventh : d.triad
						return { numeral: c.numeral, root: c.root, rootPc: pitchClassOf(c.root), type: c.type, symbol: c.symbol, notes: c.notes }
					})
				: []
			chordRow.replaceChildren(
				...chords.map((chord, i) => {
					const button = document.createElement('button')
					button.type = 'button'
					button.className = 'key harmony-chord'
					// It strums the chord: no key click over it.
					button.dataset.feedback = 'none'
					// Starts with the visible text (voice control), then says it in words.
					button.setAttribute('aria-label', `${chord.numeral} ${noteName(chord.symbol)}, ${noteName(chord.root)} ${t(chord.type.name)}`)
					const numeral = document.createElement('span')
					numeral.className = 'harmony-chord__numeral'
					numeral.textContent = chord.numeral
					const symbol = document.createElement('span')
					symbol.className = 'harmony-chord__symbol'
					symbol.textContent = noteName(chord.symbol)
					button.append(numeral, symbol)
					button.addEventListener('click', () => select(i))
					return button
				})
			)
			const scaleName = scaleTitle(noteName(spellScale(ROOTS[rootPc], type).root), type).split(' · ')[0]
			chordsNote.hidden = source === type
			if (source && source !== type)
				chordsNote.textContent = t('{scale} is built from {source}: these are its chords.', {
					scale: scaleName,
					source: `${noteName(spellScale(ROOTS[rootPc], source).root)} ${t(source.name).toLowerCase()}`,
				})
		}
		setPressed(Array.from(chordRow.children), (_, i) => i === selected)
		sizeSwitch.checked = chordView === 'sevenths'

		detail.hidden = selected === null
		if (selected === null) return
		const chord = chords[selected]
		detailSymbol.textContent = noteName(chord.symbol)
		detailName.textContent = `${chord.numeral} · ${noteName(chord.root)} ${t(chord.type.name)}`
		const voicing = voicingOf(chord)
		detailNotes.textContent = chord.notes.map(noteName).join(' ') + (voicing ? `  ·  ${shapeString(voicing)}` : '')
		openLink.setAttribute('aria-label', t('Open {chord} in Chords', { chord: noteName(chord.symbol) }))
		if (!voicing) return
		// The printed card: finger numbers in the dots (like the Chords library's 'fingers' labels).
		const spec = voicingSpec(voicing, chord.rootPc, chord.type, { labels: 'none', fingers: false, name: noteName })
		for (const dot of spec.dots) dot.label = String(voicing.fingers[dot.string] || '')
		diagram.render(spec)
	}

	/* Progressions -------------------------------------------------------- */
	function renderProgressions(rootPc: number, type: ScaleType) {
		const key = `${rootPc}|${type.name}`
		if (key !== progKey) {
			stop()
			endPreview()
			progKey = key
			// 'A minor'; a mode: 'G Mixolydian' (the 12-bar blues is in G, not C).
			progKeyName = keyName(rootPc, type, noteName).split(/,| · /)[0]
			const progressions = progressionsFor(type)
			progChords = progressions.map((progression) => resolveProgression(progression, rootPc))
			progList.replaceChildren(
				...progressions.map((progression, index) => {
					const list = progChords[index]
					const item = document.createElement('li')
					item.className = 'progression'
					const name = document.createElement('span')
					name.className = 'progression__name'
					name.textContent = t(progression.name)
					// A step sequencer: the transport key at the head of the row, then
					// one small key per bar with its lamp in the cap and the degree
					// printed under it. A step plays its chord alone.
					const row = document.createElement('div')
					row.className = 'progression__row'
					const button = document.createElement('button')
					button.type = 'button'
					button.className = 'key progression__play'
					button.dataset.feedback = 'none'
					button.addEventListener('click', () => (player.playing()?.index === index ? stop(true, t('Stopped')) : play(index, list, t(progression.name))))
					const steps = document.createElement('ol')
					steps.className = 'progression__chords'
					steps.setAttribute('aria-label', list.map((c) => noteName(c.symbol)).join(', '))
					steps.append(
						...list.map((chord, bar) => {
							const li = document.createElement('li')
							li.innerHTML =
								'<button type="button" class="progression__step" data-feedback="none"><span class="key progression__chord"><span class="lamp"></span><span></span></span><span class="progression__numeral"></span></button>'
							const step = li.firstElementChild as HTMLButtonElement
							step.querySelector('.progression__chord')!.lastElementChild!.textContent = noteName(chord.symbol)
							step.lastElementChild!.textContent = chord.numeral
							// Starts with the visible text (voice control), then says it in words.
							step.setAttribute('aria-label', `${noteName(chord.symbol)} ${chord.numeral}, ${noteName(chord.root)} ${t(chord.type.name)}`)
							step.addEventListener('click', () => previewBar(index, bar))
							return li
						})
					)
					row.append(button, steps)
					item.append(name, row)
					return item
				})
			)
		}
		syncProgressions()
	}

	function play(index: number, list: KeyChord[], name: string) {
		endPreview()
		player.play(index, list, name)
	}

	function syncProgressions() {
		const { progressionBpm, progressionLoop } = Settings.get()
		const playing = player.playing()
		progNote.textContent = progKeyName && t('In {key}', { key: progKeyName })
		bpm.show(progressionBpm)
		loopSwitch.checked = progressionLoop
		Array.from(progList.children).forEach((item, index) => {
			const on = playing?.index === index
			const button = item.querySelector<HTMLButtonElement>('.progression__play')!
			const name = item.querySelector('.progression__name')!.textContent
			button.innerHTML = on ? STOP_ICON : PLAY_ICON
			// Like a tape deck's transport key: down and lit while it plays.
			button.classList.toggle('is-down', on)
			button.classList.toggle('key--lit', on)
			button.setAttribute('aria-label', on ? t('Stop {name}', { name }) : t('Play {name}', { name }))
			item.querySelectorAll('.progression__step').forEach((step, bar) => {
				const now = on ? bar === playing!.bar - 1 : preview?.index === index && preview.bar === bar
				const cap = step.firstElementChild!
				cap.classList.toggle('is-down', now)
				cap.firstElementChild!.classList.toggle('is-on', now)
				if (now && on) step.setAttribute('aria-current', 'true')
				else step.removeAttribute('aria-current')
			})
		})
	}

	/* Circle of fifths ---------------------------------------------------- */
	const circle = createCircle($<SVGSVGElement>('.circle'), (pc, type) => host.setScale(pc, type))

	function renderCircle(rootPc: number, type: ScaleType) {
		circle.render(rootPc, type)
		keyNote.textContent = keyOf(rootPc, type)
			? keyName(rootPc, type, noteName)
			: t('{scale} has no key signature.', { scale: scaleTitle(noteName(spellScale(ROOTS[rootPc], type).root), type) })
	}

	/* Identify: scales a marked chord fits -------------------------------- */
	function renderFits(marked: number[]) {
		const pcs = new Set(marked.map((m) => m % 12))
		const top = pcs.size >= 3 ? identifyChords(pcs, marked[0] % 12)[0] : undefined
		fits.hidden = !(top && top.missing === 0 && top.extra === 0)
		if (fits.hidden) return
		fitsChord.textContent = noteName(top!.symbol)
		fitsList.replaceChildren(
			...scalesForChord(pcs, top!.rootPc).map((match) => {
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'key chord-fits__scale'
				button.textContent = scaleTitle(noteName(match.root), match.type).split(' · ')[0]
				button.title = t('Explore {scale}', { scale: button.textContent })
				button.addEventListener('click', () => host.setScale(match.rootPc, match.type))
				return button
			})
		)
	}

	/* Rendering ----------------------------------------------------------- */
	function sync() {
		if (!state) return
		const explore = state.mode === 'explore'
		section.hidden = !explore
		if (!explore) {
			stop()
			return renderFits(state.marked)
		}
		fits.hidden = true
		const { rootPc, type } = state
		renderChords(rootPc, type)
		renderProgressions(rootPc, type)
		renderCircle(rootPc, type)
		const has: Record<Pane, boolean> = { chords: chords.length > 0, progressions: progList.childElementCount > 0, circle: true }
		shownPane = has[pane] ? pane : (Object.keys(has) as Pane[]).find((p) => has[p])!
		paneButtons.forEach((b) => {
			b.hidden = !has[b.dataset.pane as Pane]
			b.setAttribute('aria-pressed', String(b.dataset.pane === shownPane))
		})
		panes.forEach((p) => (p.hidden = p.dataset.paneBody !== shownPane))
	}

	return {
		render(next: HarmonyState) {
			state = next
			sync()
		},
		/** A progression is sounding: the Scales view's mic ignores what it hears. */
		playing: () => player.playing() !== null,
		/** The chord to light on the neck: the bar playing or the step ringing, else the one tapped. */
		chord(): KeyChord | null {
			if (state?.mode !== 'explore') return null
			const playing = player.playing()
			if (playing) return playing.chords[playing.bar - 1] ?? null
			if (preview) return progChords[preview.index]?.[preview.bar] ?? null
			return selected === null || shownPane !== 'chords' ? null : (chords[selected] ?? null)
		},
		stop,
	}
}
