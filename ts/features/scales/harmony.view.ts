// Harmony under the Scales neck (Explore): the scale's chords, common
// progressions in its key and the circle of fifths; in Identify, the scales
// a marked chord fits. The Scales view owns the neck: it asks chord() which
// chord to light and redraws when told to (host.redraw). The circle is drawn
// by ./circle.ts.
import { createFretboard } from '../../ui/fretboard'
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import { chordsOfScale, identifyChords, type ChordType } from '../../music/chord-theory'
import { chordShapes, shapeString, voicingSpec, type Voicing } from '../../music/chord-shapes'
import { chordSource, keyName, keyOf, progressionsFor, resolveProgression, scalesForChord, type KeyChord } from '../../music/harmony'
import { pitchClassOf, ROOTS, scaleTitle, spellScale, type ScaleType } from '../../music/scales'
import { shapeNotes } from '../../music/chord-library'
import { OPEN_CHORD_EVENT } from '../../ui/events'
import { bindSegmented, liveRegion, scoped, setPressed } from '../../ui/dom'
import { createCircle } from './circle'

// A strum: low string to high, this far apart (a quick downstroke).
const STRUM_S = 0.025
// Progressions: four beats a bar, one chord a bar, strummed on beats 1 and 3.
const BEATS = 4
const STRUM_BEATS = [0, 2]

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

const quality = (type: ChordType) => (type.formula.includes('b5') || type.formula.includes('#5') ? 'dim' : type.formula.includes('b3') ? 'minor' : 'major')

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
	const sizeGroup = $('.harmony__size')
	const chordsNote = $<HTMLElement>('.harmony__note--chords')
	const chordRow = $<HTMLElement>('.harmony-chords')
	const legend = $<HTMLElement>('.harmony-legend')
	const detail = $<HTMLElement>('.chord-detail')
	const detailSymbol = $<HTMLElement>('.chord-detail__symbol')
	const detailName = $<HTMLElement>('.chord-detail__name')
	const detailNotes = $<HTMLElement>('.chord-detail__notes')
	const openLink = $<HTMLAnchorElement>('[data-action="open-chord"]')
	const progNote = $<HTMLElement>('.harmony__note--progressions')
	const keyNote = $<HTMLElement>('.harmony__note--key')
	const loopButton = $<HTMLButtonElement>('[data-action="loop"]')
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
	// Progression playback.
	let playing: { index: number; chords: KeyChord[]; bar: number } | null = null
	let barTimer = 0
	let nextBarAt = 0

	/* Controls ------------------------------------------------------------ */
	paneButtons.forEach((button) =>
		button.addEventListener('click', () => {
			pane = button.dataset.pane as Pane
			// Playback belongs to the Progressions pane; the tapped chord lights
			// the neck only while the Chords pane shows.
			if (pane !== 'progressions') stop(false, 'Stopped')
			host.redraw()
		})
	)
	const showSize = bindSegmented(sizeGroup, 'data-chord-view', (value) => Settings.update({ chordView: value as Settings.Settings['chordView'] }))
	loopButton.addEventListener('click', () => Settings.update({ progressionLoop: !Settings.get().progressionLoop }))
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

	// ponytail: bars are timed with setTimeout from a fixed start (no drift,
	// a few ms of jitter per bar); both strums of a bar go to the audio clock
	// at once. Move to an AudioContext lookahead like ts/core/metronome.ts if the
	// jitter is ever audible.
	function playBar() {
		if (!playing) return
		if (playing.bar >= playing.chords.length) {
			if (!Settings.get().progressionLoop) return stop(true, 'Finished')
			playing.bar = 0
		}
		const chord = playing.chords[playing.bar]
		const beat = 60 / Settings.get().progressionBpm
		for (const b of STRUM_BEATS) strum(chord, b * beat)
		playing.bar++
		nextBarAt += BEATS * beat * 1000
		barTimer = window.setTimeout(playBar, Math.max(0, nextBarAt - performance.now()))
		host.redraw()
	}

	function play(index: number, list: KeyChord[], name: string) {
		stop()
		Sound.stopAll()
		playing = { index, chords: list, bar: 0 }
		nextBarAt = performance.now()
		announce(`Playing ${name}: ${list.map((c) => c.symbol).join(', ')}`)
		playBar()
	}

	/**
	 * Stops a progression and its scheduled strums; `redraw` when nothing
	 * else is about to redraw the neck. `say` it only when the user stopped
	 * it or it ended, not when a new key or tab silently ends it.
	 */
	function stop(redraw = false, say = '') {
		if (!playing) return
		clearTimeout(barTimer)
		playing = null
		Sound.stopAll()
		if (say) announce(say)
		syncProgressions()
		if (redraw) host.redraw()
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
					button.className = `harmony-chord harmony-chord--${quality(chord.type)}`
					// Starts with the visible text (voice control), then says it in words.
					button.setAttribute('aria-label', `${chord.numeral} ${chord.symbol}, ${chord.root} ${chord.type.name}`)
					const numeral = document.createElement('span')
					numeral.className = 'harmony-chord__numeral'
					numeral.textContent = chord.numeral
					const symbol = document.createElement('span')
					symbol.className = 'harmony-chord__symbol'
					symbol.textContent = chord.symbol
					button.append(numeral, symbol)
					button.addEventListener('click', () => select(i))
					return button
				})
			)
			const scaleName = scaleTitle(spellScale(ROOTS[rootPc], type).root, type).split(' · ')[0]
			chordsNote.hidden = source === type
			if (source && source !== type)
				chordsNote.textContent = `${scaleName} is built from ${spellScale(ROOTS[rootPc], source).root} ${source.name.toLowerCase()}: these are its chords.`
		}
		setPressed(Array.from(chordRow.children), (_, i) => i === selected)
		showSize(chordView)

		detail.hidden = selected === null
		if (selected === null) return
		const chord = chords[selected]
		detailSymbol.textContent = chord.symbol
		detailName.textContent = `${chord.numeral} · ${chord.root} ${chord.type.name}`
		const voicing = voicingOf(chord)
		detailNotes.textContent = chord.notes.join(' ') + (voicing ? `  ·  ${shapeString(voicing)}` : '')
		openLink.setAttribute('aria-label', `Open ${chord.symbol} in Chords`)
		if (voicing) diagram.render(voicingSpec(voicing, chord.rootPc, chord.type))
	}

	/* Progressions -------------------------------------------------------- */
	function renderProgressions(rootPc: number, type: ScaleType) {
		const key = `${rootPc}|${type.name}`
		if (key !== progKey) {
			stop()
			progKey = key
			// 'A minor'; a mode: 'G Mixolydian' (the 12-bar blues is in G, not C).
			progKeyName = keyName(rootPc, type).split(/,| · /)[0]
			progList.replaceChildren(
				...progressionsFor(type).map((progression, index) => {
					const list = resolveProgression(progression, rootPc)
					const item = document.createElement('li')
					item.className = 'progression'
					const head = document.createElement('div')
					head.className = 'progression__head'
					const name = document.createElement('span')
					name.className = 'progression__name'
					name.textContent = progression.name
					const button = document.createElement('button')
					button.type = 'button'
					button.className = 'btn btn--small progression__play'
					button.addEventListener('click', () => (playing?.index === index ? stop(true, 'Stopped') : play(index, list, progression.name)))
					head.append(name, button)
					const row = document.createElement('ol')
					row.className = 'progression__chords'
					row.setAttribute('aria-label', list.map((c) => c.symbol).join(', '))
					row.append(
						...list.map((chord) => {
							const li = document.createElement('li')
							li.className = `progression__chord harmony-chord--${quality(chord.type)}`
							li.innerHTML = `<span class="harmony-chord__numeral"></span><span class="harmony-chord__symbol"></span>`
							li.children[0].textContent = chord.numeral
							li.children[1].textContent = chord.symbol
							return li
						})
					)
					item.append(head, row)
					return item
				})
			)
		}
		syncProgressions()
	}

	const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>'
	const STOP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'

	function syncProgressions() {
		const { progressionBpm, progressionLoop } = Settings.get()
		progNote.textContent = [progKeyName && `In ${progKeyName}`, `${progressionBpm} BPM`].filter(Boolean).join(' · ')
		loopButton.setAttribute('aria-pressed', String(progressionLoop))
		Array.from(progList.children).forEach((item, index) => {
			const on = playing?.index === index
			item.classList.toggle('progression--playing', on)
			const button = item.querySelector<HTMLButtonElement>('.progression__play')!
			const name = item.querySelector('.progression__name')!.textContent
			button.innerHTML = `${on ? STOP_ICON : PLAY_ICON}<span>${on ? 'Stop' : 'Play'}</span>`
			button.setAttribute('aria-label', `${on ? 'Stop' : 'Play'} ${name}`)
			item.querySelectorAll('.progression__chord').forEach((chip, bar) => {
				const now = on && bar === playing!.bar - 1
				chip.classList.toggle('progression__chord--now', now)
				if (now) chip.setAttribute('aria-current', 'true')
				else chip.removeAttribute('aria-current')
			})
		})
	}

	/* Circle of fifths ---------------------------------------------------- */
	const circle = createCircle($<SVGSVGElement>('.circle'), (pc, type) => host.setScale(pc, type))

	function renderCircle(rootPc: number, type: ScaleType) {
		circle.render(rootPc, type)
		keyNote.textContent = keyOf(rootPc, type) ? keyName(rootPc, type) : `${scaleTitle(spellScale(ROOTS[rootPc], type).root, type)} has no key signature.`
	}

	/* Identify: scales a marked chord fits -------------------------------- */
	function renderFits(marked: number[]) {
		const pcs = new Set(marked.map((m) => m % 12))
		const top = pcs.size >= 3 ? identifyChords(pcs, marked[0] % 12)[0] : undefined
		fits.hidden = !(top && top.missing === 0 && top.extra === 0)
		if (fits.hidden) return
		fitsChord.textContent = top!.symbol
		fitsList.replaceChildren(
			...scalesForChord(pcs, top!.rootPc).map((match) => {
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'chord-fits__scale'
				button.textContent = scaleTitle(match.root, match.type).split(' · ')[0]
				button.title = `Explore ${button.textContent}`
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
		sizeGroup.hidden = shownPane !== 'chords'
		loopButton.hidden = shownPane !== 'progressions'
		legend.hidden = shownPane !== 'chords'
	}

	return {
		render(next: HarmonyState) {
			state = next
			sync()
		},
		/** A progression is sounding: the Scales view's mic ignores what it hears. */
		playing: () => playing !== null,
		/** The chord to light on the neck: the bar playing, else the one tapped. */
		chord(): KeyChord | null {
			if (state?.mode !== 'explore') return null
			if (playing) return playing.chords[playing.bar - 1] ?? null
			return selected === null || shownPane !== 'chords' ? null : (chords[selected] ?? null)
		},
		stop,
	}
}
