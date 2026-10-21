import * as Metronome from '../../core/metronome'
import * as Settings from '../../core/settings'
import { clamp } from '../../core/math'
import type { View } from '../../ui/view'
import { bindSegmented, onBareKey, scoped } from '../../ui/dom'
import { reducedMotion } from '../../ui/media'
import { bindRotary } from '../../ui/rotary'
import { screenLock } from '../../ui/screen-lock'
import { resetKey } from '../../ui/reset-key'
import { plural, t } from '../../core/i18n'
import { bindTempoKeys, numberField, onPress } from '../../ui/tempo'

const MAX_BEATS = 12
// Taps further apart than this start a new measurement; the average covers the
// last TAP_COUNT taps so one sloppy tap fades out instead of ruining the tempo.
const TAP_RESET_MS = 2000
const TAP_COUNT = 6
// The fader's range (index.html). The engine goes down to 10 for Trainer → Tab.
const MIN_TEMPO = 30

// Beat pad tap targets: never smaller than MIN_BEAT px, BEAT_GAP apart (match .metro-beats in metronome.css).
const MIN_BEAT = 44
const BEAT_GAP = 8

// After the user sets the tempo, beat events still queued at the old one are ignored this long.
const USER_TEMPO_QUIET_MS = 400
const MAX_FLASHES_PER_S = 3

// Conventional boundaries (BPM) between the tempo names.
const TEMPO_NAMES: [number, string][] = [
	[66, 'Largo'],
	[76, 'Adagio'],
	[108, 'Andante'],
	[120, 'Moderato'],
	[168, 'Allegro'],
	[Infinity, 'Presto'],
]
const tempoName = (bpm: number) => TEMPO_NAMES.find(([limit]) => bpm < limit)![1]

// Tapping a beat pad cycles normal → accent → mute.
const NEXT_ACCENT: Metronome.Accent[] = [1, 2, 0]

export function createMetronomeView(root: HTMLElement): View & { stop(): void } {
	const { $, $$ } = scoped(root)
	const bpmValue = $<HTMLInputElement>('.metro-bpm__value')
	const name = $<HTMLElement>('.metro-name')
	const meter = $<HTMLElement>('.metro-meter')
	const trainerLegend = $<HTMLElement>('.metro-trn')
	const beatsBox = $<HTMLElement>('.metro-beats')
	const slider = $<HTMLInputElement>('.metro-slider')
	const startButton = $<HTMLButtonElement>('[data-action="start"]')
	const startLabel = $<HTMLElement>('.metro-start__label')
	const tapButton = $<HTMLButtonElement>('[data-action="tap"]')
	const beatsValue = $<HTMLElement>('[data-value="beats"]')
	const volume = $<HTMLInputElement>('[data-action="volume"]')
	const trainerSwitch = $<HTMLInputElement>('[data-action="trainer"]')
	const trainerDesc = $<HTMLElement>('.metro-trainer .switch__desc')
	const progress = $<HTMLElement>('.metro-progress')
	const progressFill = $<HTMLElement>('.metro-progress__bar span')
	const progressText = $<HTMLElement>('.metro-progress__text')
	const trainerConfig = $<HTMLElement>('.metro-trainer__config')
	const flash = $<HTMLElement>('.metro-flash')

	let beats: HTMLButtonElement[] = []
	let lit: HTMLElement | null = null
	let barInStep = 0
	let taps: number[] = []
	// True while the engine runs from this tab's Start (not the Trainer's
	// Changes exercise, which shares it): this view configures it, keeps the
	// screen on and follows its beats only then.
	let owned = false
	let dragging = false
	let userTempoAt = 0

	/* Tempo ----------------------------------------------------------------- */
	/** The one way the user changes tempo: engine first, then the stored setting. */
	function setBpm(bpm: number) {
		userTempoAt = performance.now()
		bpm = clamp(Math.round(bpm), MIN_TEMPO, Metronome.MAX_BPM)
		Metronome.setTempo(bpm)
		Settings.update({ metroBpm: bpm })
	}
	const nudge = (by: number) => setBpm(Metronome.getState().bpm + by)

	slider.addEventListener('input', () => setBpm(Number(slider.value)))
	slider.addEventListener('pointerdown', () => (dragging = true))
	for (const type of ['pointerup', 'pointercancel']) slider.addEventListener(type, () => (dragging = false))

	bindTempoKeys($$('[data-tempo]'), nudge)

	// Tap the number to type a tempo.
	const bpmField = numberField(bpmValue, () => Metronome.getState().bpm, setBpm)

	onPress(tapButton, () => {
		const now = performance.now()
		if (taps.length && now - taps[taps.length - 1] > TAP_RESET_MS) taps = []
		taps = [...taps, now].slice(-TAP_COUNT)
		if (taps.length >= 2) setBpm((60000 * (taps.length - 1)) / (taps[taps.length - 1] - taps[0]))
	})

	/* Time signature, accents, subdivision, sound ---------------------------- */
	for (const button of $$('[data-beats]')) {
		const direction = Number(button.dataset.beats)
		onPress(button, () => Settings.update({ metroBeats: clamp(Settings.get().metroBeats + direction, 1, MAX_BEATS) }), true)
	}
	const showUnit = bindSegmented(root, 'data-unit', (value) => Settings.update({ metroUnit: Number(value) }))
	const showSub = bindRotary($('[data-rotary="sub"]'), (value) => Settings.update({ metroSubdivision: Number(value) }))
	const showSound = bindRotary($('[data-rotary="sound"]'), (value) => Settings.update({ metroSound: value as Metronome.Sound }))
	volume.addEventListener('input', () => Settings.update({ metroVolume: Number(volume.value) }))

	function setAccent(beat: number, accent: number) {
		const accents = [...Settings.get().metroAccents]
		accents[beat] = accent
		Settings.update({ metroAccents: accents })
	}

	function buildBeats(count: number) {
		beats = Array.from({ length: count }, (_, beat) => {
			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'metro-beat'
			button.dataset.feedback = 'key'
			// A rubber pad with a small display: two bars = accent, one = normal,
			// none = muted. The printed number below counts the beats.
			const pad = document.createElement('span')
			pad.className = 'metro-beat__pad'
			const display = document.createElement('span')
			display.className = 'metro-beat__display'
			display.append(document.createElement('i'), document.createElement('i'))
			pad.append(display)
			const number = document.createElement('span')
			number.className = 'metro-beat__num'
			number.textContent = String(beat + 1)
			button.append(pad, number)
			button.addEventListener('click', () => setAccent(beat, NEXT_ACCENT[Settings.get().metroAccents[beat] ?? 1]))
			return button
		})
		lit = null
		beatsBox.replaceChildren(...beats)
		layoutBeats()
	}

	// Even rows, wrapping as soon as a single row would shrink the beats below a
	// thumb-sized tap target (the CSS sizes each one from --per-row).
	function layoutBeats() {
		const width = beatsBox.clientWidth
		if (!width || !beats.length) return // hidden tab: the ResizeObserver calls again
		const fit = Math.max(1, Math.floor((width + BEAT_GAP) / (MIN_BEAT + BEAT_GAP)))
		const rows = Math.ceil(beats.length / fit)
		beatsBox.style.setProperty('--per-row', String(Math.ceil(beats.length / rows)))
	}
	new ResizeObserver(layoutBeats).observe(beatsBox)

	/** Lights the pad of `beat` and only that one (null: none). */
	function light(beat: number | null) {
		lit?.classList.remove('is-now')
		lit = beat === null ? null : (beats[beat] ?? null)
		lit?.classList.add('is-now')
	}

	/* Run / stop ------------------------------------------------------------ */
	// The screen stays on while it clicks; only on this tab's Start: the
	// Trainer's Changes exercise may be what runs the engine.
	const wakeLock = screenLock(() => owned && Metronome.getState().running)

	function run() {
		owned = true
		Metronome.start()
		barInStep = 0
		wakeLock.hold()
		sync()
	}

	function halt() {
		if (!owned) return
		owned = false
		Metronome.stop()
		wakeLock.release()
		light(null)
		barInStep = 0
		sync()
	}

	const toggle = () => (owned ? halt() : run())
	startButton.addEventListener('click', toggle)

	// Space starts and stops where it does nothing else: the bare page, or the
	// tempo slider. (Buttons, switches and selects act on Space themselves.)
	onBareKey([root], ['Space'], toggle, (target) => target instanceof HTMLInputElement && target.type === 'range')

	/* Beats ----------------------------------------------------------------- */
	function showBpm(bpm: number, force = false) {
		bpmField.show(bpm, force)
		slider.value = String(bpm)
		name.textContent = t(tempoName(bpm))
	}

	Metronome.onBeat((event) => {
		if (!owned) return
		// The tempo only moves by itself under the speed trainer. Events still queued
		// at the old tempo must not overwrite what the user just set or is dragging.
		if (Settings.get().metroTrainerOn && !dragging && performance.now() - userTempoAt > USER_TEMPO_QUIET_MS) showBpm(event.bpm)
		if (event.sub !== 0) return
		light(event.beat)
		if (event.beat === 0) {
			barInStep = event.bar % Settings.get().metroTrainerBars
			// WCAG 2.3.1: never more than 3 flashes a second, and none for reduced motion.
			const perSecond = event.bpm / Settings.get().metroBeats / 60
			if (Settings.get().metroFlash && perSecond <= MAX_FLASHES_PER_S && !reducedMotion.matches) {
				flash.animate([{ opacity: 0.22 }, { opacity: 0 }], { duration: 320, easing: 'ease-out' })
			}
		}
		renderTrainer()
	})

	/* Speed trainer ---------------------------------------------------------- */
	const TRAINER_LIMITS = {
		step: { key: 'metroTrainerStep', min: 1, max: 20, by: 1 },
		bars: { key: 'metroTrainerBars', min: 1, max: 16, by: 1 },
		target: { key: 'metroTrainerTarget', min: MIN_TEMPO, max: Metronome.MAX_BPM, by: 5 },
	} as const
	const trainerValues = Object.fromEntries(Object.keys(TRAINER_LIMITS).map((name) => [name, $<HTMLElement>(`[data-value="${name}"]`)])) as Record<
		keyof typeof TRAINER_LIMITS,
		HTMLElement
	>

	trainerSwitch.addEventListener('change', () => {
		const on = trainerSwitch.checked
		const { metroBpm, metroTrainerTarget } = Settings.get()
		// A target at or under the start tempo would do nothing: start 40 BPM higher.
		const target = metroTrainerTarget > metroBpm ? metroTrainerTarget : Math.min(Metronome.MAX_BPM, Math.ceil((metroBpm + 40) / 5) * 5)
		Settings.update({ metroTrainerOn: on, metroTrainerTarget: target })
	})

	for (const button of $$('[data-trainer]')) {
		const limits = TRAINER_LIMITS[button.dataset.trainer as keyof typeof TRAINER_LIMITS]
		const direction = Number(button.dataset.by)
		onPress(
			button,
			() => {
				const current = Settings.get()[limits.key]
				// Snap to the step grid first, so 163 goes to 165 or 160, then by whole steps.
				const snapped = direction > 0 ? Math.floor(current / limits.by) * limits.by : Math.ceil(current / limits.by) * limits.by
				Settings.update({ [limits.key]: clamp(snapped + direction * limits.by, limits.min, limits.max) })
			},
			true
		)
	}

	// The target can be typed too.
	const targetField = numberField(
		trainerValues.target as HTMLInputElement,
		() => Settings.get().metroTrainerTarget,
		(bpm) => Settings.update({ metroTrainerTarget: clamp(Math.round(bpm), MIN_TEMPO, Metronome.MAX_BPM) })
	)

	function renderTrainer() {
		const { metroTrainerOn: on, metroTrainerStep: step, metroTrainerBars: bars, metroTrainerTarget: target, metroBpm: start } = Settings.get()
		const barsText = plural(bars, '{n} bar', '{n} bars')
		trainerDesc.textContent = on ? t('From {start} BPM, +{step} every {bars}', { start, step, bars: barsText }) : t('Speeds up while you play')
		trainerValues.step.textContent = `+${step}`
		trainerValues.bars.textContent = barsText
		targetField.show(target)
		trainerConfig.hidden = !on
		progress.hidden = !on
		// The TRN legend on the tempo LCD lights while the trainer is on.
		trainerLegend.classList.toggle('lcd__dim', !on)
		if (!on) return
		const { running, bpm } = Metronome.getState()
		const span = target - start
		progressFill.style.width = `${span > 0 ? clamp(((bpm - start) / span) * 100, 0, 100) : 0}%`
		progressText.textContent =
			span <= 0
				? t('Set “Up to” above {start} BPM', { start })
				: !running
					? t('Starts at {start} BPM', { start })
					: bpm >= target
						? t('Target reached · {target} BPM', { target })
						: `${bpm} → ${target} BPM${bars > 1 ? ` · ${t('bar {n} of {bars}', { n: barInStep + 1, bars })}` : ''}`
	}

	/* Rendering from settings ----------------------------------------------- */
	function sync() {
		const s = Settings.get()
		const accents = s.metroAccents as Metronome.Accent[]
		// The device's delay holds for every click, the Changes exercise's too.
		Metronome.configure({ outputDelayMs: s.audioDelayMs })
		// The engine is shared with the Trainer's Changes exercise, which sets its
		// own meter: configure it only from this tab, or while its own clicks run
		// (Settings changes the sound and volume of a running metronome).
		if (!root.hidden || owned)
			Metronome.configure({
				beats: s.metroBeats,
				accents,
				subdivision: s.metroSubdivision,
				sound: s.metroSound,
				volume: s.metroVolume,
				trainer: { enabled: s.metroTrainerOn, step: s.metroTrainerStep, bars: s.metroTrainerBars, target: s.metroTrainerTarget },
			})

		if (beats.length !== s.metroBeats) buildBeats(s.metroBeats)
		const labels = ['muted', 'normal', 'accent']
		beats.forEach((button, beat) => {
			const accent = accents[beat] ?? 1
			button.dataset.accent = String(accent)
			button.setAttribute('aria-label', t('Beat {n}, {level}. Tap to change', { n: beat + 1, level: t(labels[accent]) }))
		})

		showBpm(Metronome.getState().bpm)
		meter.textContent = `${s.metroBeats}/${s.metroUnit}`
		beatsValue.textContent = String(s.metroBeats)
		showUnit(s.metroUnit)
		showSub(s.metroSubdivision)
		showSound(s.metroSound)
		volume.value = String(s.metroVolume)
		trainerSwitch.checked = s.metroTrainerOn
		renderTrainer()

		const running = owned
		startLabel.textContent = running ? t('Stop') : t('Start')
		startButton.setAttribute('aria-pressed', String(running))
	}

	Metronome.setTempo(Settings.get().metroBpm)
	Settings.subscribe(sync)
	sync()

	// Reset (two taps): every metronome setting back to its default, tempo included.
	const metroKeys = (Object.keys(Settings.get()) as (keyof Settings.Settings)[]).filter((key) => key.startsWith('metro'))
	const reset = resetKey(t('the metronome'), () => {
		Settings.reset(metroKeys)
		Metronome.setTempo(Settings.get().metroBpm)
	})
	// A small key in the tab's foot, before the Guide.
	reset.className = 'foot-key reset-key'
	$<HTMLElement>('.view-foot [data-help]').before(reset)

	return {
		onActivate() {
			// Changes may have left the engine at its own tempo.
			if (!Metronome.getState().running) Metronome.setTempo(Settings.get().metroBpm)
			sync()
		},
		// No microphone here; stopping on leaving the tab is stop()'s job, called by
		// main.ts (reset() also runs when the mic is stopped or blocked, which must not stop the clicks).
		onReading() {},
		reset() {},
		wantsMic: () => false,
		/** Stops clicks this tab started (the Changes drill's are not its own). */
		stop: halt,
	}
}
