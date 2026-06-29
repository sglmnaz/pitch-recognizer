import type { PitchReading } from '../microphone'

/** A switchable screen that consumes microphone readings while visible. */
export interface View {
	/** Called when the view becomes the active tab. */
	onActivate(): void
	/** Feeds one microphone frame (or null while silent / not listening). */
	onReading(reading: PitchReading | null): void
	/** Clears any transient state, e.g. when the microphone stops. */
	reset(): void
}
