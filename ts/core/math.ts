/** `value` limited to min…max. (Stored settings use the validating clamp in settings.ts.) */
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
