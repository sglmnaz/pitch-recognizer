# Design

Visual language: **Vercel Geist**, extracted from vercel.com/geist into
`design-extract-output/` and codified as tokens in [ts/tokens.css](ts/tokens.css).

## Theme

Light and dark both ship; the choice follows the OS by default and is overridable
with the header toggle (persisted to `localStorage`). Scene: a learner tuning up at
a desk, sometimes in a bright room, sometimes practising at night. Neither lighting
condition is the canonical one, so neither theme is the default; the system decides.

## Color

Near-monochrome, the Geist signature. Neutrals carry a faint cool tint (~hue 220,
chroma well under 0.01) so greys never read dead, while staying faithful to Geist.

| Role | Light | Dark |
|------|-------|------|
| Page background | `#fbfbfc` | `#0a0a0b` |
| Surface (panels) | `#ffffff` | `#121214` |
| Border (hairline) | `#ebebec` | `#2a2a2e` |
| Foreground | `#18181b` | `#ededee` |
| Muted | `#8f8f96` | `#71717a` |
| Accent (blue) | `#0072f5` | `#3b9eff` |
| Lock / in-tune (green) | `#1a8245` | `#5ec27a` |
| Solid button | `#18181b` (white text) | `#ededee` (black text) |

Color strategy: **restrained**. One accent (blue) for the needle/focus, one
semantic green for the in-tune lock. Everything else is neutral.

## Typography

- **Geist** (sans) for UI text. **Geist Mono** for all data: note names,
  frequencies, cents, scores. Variable woff2 self-hosted in `ts/fonts/`.
- Body 14px. Large readout note 84px / Geist Mono / letter-spacing -0.04em.
- Hierarchy comes from scale + weight, not color.

## Elevation

Geist uses borders, not drop shadows. Default panel elevation is a 1px hairline
border (`--shadow-sm` = border + a 1–2px ambient shadow). Reserve `--shadow-md`
for genuinely floating surfaces.

## Components

- **Segmented tabs** for Trainer/Tuner: bordered track, active pill gets the
  surface color and a hairline shadow.
- **Buttons**: 36px tall, 6px radius. Primary is the solid near-black (or
  near-white in dark); secondary is surface + hairline border.
- **Readout panel**: the shared note/frequency/cents display. Gains a green border
  and green note color when locked within 5 cents.
- **Cents meter**: horizontal scale -50..+50 with a center tick and a needle that
  eases (80ms linear) to the deviation.
- **Settings popover**: gear-triggered floating panel (border + `--shadow-md`,
  closes on outside-click/Escape). Holds pill **switches** (track fills with accent
  when on) and a grid of monospace **note chips** that fill solid when selected.

## Motion

`--dur` 0.15s with `cubic-bezier(.4,0,.2,1)`. The listening-status dot pulses; the
needle tracks pitch. Nothing else moves without reason.
