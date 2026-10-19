# Design

Visual language: **Vercel Geist**, extracted from vercel.com/geist into
`design-extract-output/` and codified as tokens in [ts/styles/tokens.css](ts/styles/tokens.css).

## Theme

Light and dark both ship; the choice follows the OS by default (System) and is
overridable under Settings > Appearance (persisted to `localStorage`). Scene: a learner tuning up at
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
  frequencies, cents, scores. Variable woff2 self-hosted in `ts/styles/fonts/`.
- Body 14px. Large readout note 84px / Geist Mono / letter-spacing -0.04em.
- Hierarchy comes from scale + weight, not color.

## Elevation

Geist uses borders, not drop shadows. Default panel elevation is a 1px hairline
border (`--shadow-sm` = border + a 1–2px ambient shadow). Reserve `--shadow-md`
for genuinely floating surfaces.

## Components

- **Tab bar** with six tabs (Tuner, Chords, Scales, Trainer, Metronome, Settings),
  icon + label: on wider screens a bordered segmented track in the header where the
  active pill gets the surface color and a hairline shadow; on phones (< 600 px) an
  opaque bar docked to the bottom edge with a quiet tint on the selected tab,
  icon-only below 360 px (labels stay for screen readers).
- **Segmented controls** for sub-modes inside a tab (Chords Listen / Library /
  Identify, Scales Explore / Identify, Trainer Notes / Intervals / Chords / Changes)
  use the same track-and-pill look.
- **Buttons**: 36px tall, 6px radius. Primary is the solid near-black (or
  near-white in dark); secondary is surface + hairline border.
- **Readout panel**: the shared note/frequency/cents display. Gains a green border
  and green note color when locked within the in-tune tolerance (±2, ±5 or ±10 cents; default ±5).
- **Cents meter**: horizontal scale -50..+50 with a center tick and a needle that
  eases (80ms linear) to the deviation. Colored tuning zones sit on the track:
  a soft green band in the centre (in tune, the tolerance setting, default ±5 cents) flanked by soft yellow
  (close), fading to neutral at the edges. Zone colors are theme-token mixes so
  they stay muted in both light and dark.
- **Settings tab**: the sixth tab, a plain scrolling page with one group per tab
  (heading over a bordered card of rows). Holds pill **switches** (track fills
  with accent when on) and a grid of monospace **note chips** that fill solid
  when selected.
- **Density**: on phones the blocks of a view sit `--stack` (12 px) apart and the
  hero type shrinks on short screens, so each view's main interaction fits one
  screen above the docked tab bar; tap targets never drop below 44 px.

## Motion

`--dur` 0.15s with `cubic-bezier(.4,0,.2,1)`. The listening-status dot pulses; the
needle tracks pitch. Nothing else moves without reason.
