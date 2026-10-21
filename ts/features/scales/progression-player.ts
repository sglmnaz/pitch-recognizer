// Plays a progression under the Scales neck (Harmony → Progressions): one
// chord a bar, strummed on beats 1 and 3, at the progressionBpm setting,
// looping if progressionLoop is on. The Harmony view draws the bar playing.
import * as Settings from '../../core/settings'
import * as Sound from '../../core/sound'
import type { KeyChord } from '../../music/harmony'
import { noteName } from '../../music/note-names'
import { t } from '../../core/i18n'

// Progressions: four beats a bar, one chord a bar, strummed on beats 1 and 3.
const BEATS = 4
const STRUM_BEATS = [0, 2]

export interface PlayerHooks {
	/** Strums the chord `at` seconds from now. */
	strum(chord: KeyChord, at: number): void
	announce(text: string): void
	/** A bar started: redraw the neck and the chips. */
	bar(): void
	/** Playback stopped: redraw the list, and the neck too when `redraw`. */
	stopped(redraw: boolean): void
}

export function createProgressionPlayer(hooks: PlayerHooks) {
	let playing: { index: number; chords: KeyChord[]; bar: number } | null = null
	let barTimer = 0
	let nextBarAt = 0

	// ponytail: bars are timed with setTimeout from a fixed start (no drift,
	// a few ms of jitter per bar); both strums of a bar go to the audio clock
	// at once. Move to an AudioContext lookahead like ts/core/metronome.ts if the
	// jitter is ever audible.
	function playBar() {
		if (!playing) return
		if (playing.bar >= playing.chords.length) {
			if (!Settings.get().progressionLoop) return stop(true, t('Finished'))
			playing.bar = 0
		}
		const chord = playing.chords[playing.bar]
		const beat = 60 / Settings.get().progressionBpm
		for (const b of STRUM_BEATS) hooks.strum(chord, b * beat)
		playing.bar++
		nextBarAt += BEATS * beat * 1000
		barTimer = window.setTimeout(playBar, Math.max(0, nextBarAt - performance.now()))
		hooks.bar()
	}

	/** Plays progression `index` (its resolved `list`, announced as `name`) from its first bar. */
	function play(index: number, list: KeyChord[], name: string) {
		stop()
		Sound.stopAll()
		playing = { index, chords: list, bar: 0 }
		nextBarAt = performance.now()
		hooks.announce(t('Playing {name}: {chords}', { name, chords: list.map((c) => noteName(c.symbol)).join(', ') }))
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
		if (say) hooks.announce(say)
		hooks.stopped(redraw)
	}

	return {
		play,
		stop,
		/** The progression playing (index in the list) and the next bar to play, or null. */
		playing: () => playing,
	}
}
