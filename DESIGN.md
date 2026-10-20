# Design

Visual language: **Vercel Geist**, extracted from vercel.com/geist into
`design-extract-output/` and codified as tokens in [ts/styles/tokens.css](ts/styles/tokens.css).

## Theme

Light and dark both ship; the choice follows the OS by default (System) and is
overridable under Settings > Appearance (persisted to `localStorage`). Scene: a learner tuning up at
a desk, sometimes in a bright room, sometimes practising at night. Neither lighting
condition is the canonical one, so neither theme is the default; the system decides.

A theme is a **palette** (`data-theme` on `<html>`, only `default` today) shown
in a **mode** (`data-mode`: `light` / `dark`). Tokens come in three tiers in
`ts/styles/tokens.css`: primitives (raw scales: `--gray-*`, `--blue-*`,
`--teal-*`, `--stone-*`, `--green-*`, `--orange-*`), semantic roles per mode
(`--bg`, `--surface`, `--fg`, `--accent`, `--success`, ...) and component tokens
(`--root-*` / `--tone-*` / `--note-*` degree colours, `--board-*`, `--staff-*`,
`--shadow-*`). Components read only semantic and component tokens. Any subtree
can force a mode with its own `data-mode` (the fretboard's board theme, the
trainer's light staff); it keeps the active palette. Details: docs/adr/0005.

### How to add a theme

1. One CSS block at the end of `ts/styles/tokens.css`, overriding the semantic
   tokens (and any primitives or component tokens it needs) for both modes.
   The descendant selectors make forced-mode subtrees follow the palette too:

   ```css
   [data-theme='ocean'][data-mode='light'],
   [data-theme='ocean'] [data-mode='light'] {
   	--accent: #0a7ea4;
   	--accent-hover: #086a8a;
   	/* ...every role that differs */
   }

   [data-theme='ocean'][data-mode='dark'],
   [data-theme='ocean'] [data-mode='dark'] {
   	--accent: #4cc3e6;
   	--accent-hover: #74d2ee;
   }
   ```

2. One entry in `THEMES` in `ts/ui/theme.ts` (id, label, and the `--bg` of
   each mode as `themeColor`, for the browser chrome), and the id in the
   allow-list of the inline script in `index.html`.

With more than one entry, Settings > Appearance shows a Palette picker by itself.

### Shape and material tokens

A palette changes hues; a **style theme** changes what the controls are made
of (bevelled hardware keys, an LCD readout). Tier 3 carries a shape and
material group for that, at the end of `ts/styles/tokens.css`. The base
components read these tokens, and the defaults resolve to exactly the Geist
look, so a style theme is mostly overrides.

| Group | Controls | Tokens |
|-------|----------|--------|
| Keys | `.btn` and variants, `.chip`, `.chord-root`, `.string-chip`, `.ear-answer`, `.metro-step`, `.mic-toggle` | `--key-radius`, `--key-radius-lg` (large buttons, Start / Tap), `--key-bg`, `--key-bg-hover`, `--key-fg`, `--key-border`, `--key-shadow`, `--key-font-weight`, `--key-letter-spacing`, `--key-text-transform`; held down: `--key-pressed-bg`, `--key-pressed-fg`, `--key-shadow-pressed`, `--key-pressed-offset` (a `translate`, `none` today); primary: `--key-solid-bg`, `--key-solid-bg-hover`, `--key-solid-fg`, `--key-solid-shadow` |
| Segmented | `.segmented` and the tab bar (from 601 px; the docked phone bar keeps its own look) | `--seg-track-bg`, `--seg-track-shadow`, `--seg-gap`, `--seg-radius`, `--seg-key-radius`, `--seg-fg`, `--seg-on-bg`, `--seg-on-fg`, `--seg-on-shadow` |
| Switch | `.switch__track` and its knob | `--switch-track-bg`, `--switch-track-on-bg`, `--switch-radius`, `--switch-knob-bg`, `--switch-knob-shadow`, `--switch-knob-radius` |
| Range | `.range`, `.metro-slider` (native sliders) | `--range-fill` (their `accent-color`) |
| Panels | `.panel` | `--panel-bg`, `--panel-border`, `--panel-radius`, `--panel-shadow` |
| Readouts | the Tuner / Trainer / Chords readout, the metronome tempo hero | `--readout-bg`, `--readout-fg`, `--readout-shadow`, `--readout-font` (the note, tempo and their sub lines) |
| Indicator | the accent ring of a selected or live control (mic listening, loop on, chosen scale or chord, a voicing being pressed) | `--indicator-on` |

Shapes (radii, borders, weights, offsets, fonts) are declared once on `:root`;
materials (colours, shadows) on every `[data-mode]`, like the derived tokens,
so a forced-mode subtree resolves them against its own roles. A style theme
therefore overrides them on the theme root and on any forced subtree:

```css
/* ts/styles/themes/oldschool.css, imported last in main.css */
@layer tokens {
	[data-theme='oldschool'][data-mode='light'],
	[data-theme='oldschool'] [data-mode='light'] {
		--key-bg: #d9d4c7;
		--key-shadow: inset 0 -3px 0 rgb(0 0 0 / 0.25), 0 1px 0 rgb(0 0 0 / 0.4);
		--key-pressed-offset: 0 2px;
		--key-text-transform: uppercase;
		/* ...every token that differs, and the dark block likewise */
	}
}

@layer components {
	/* What tokens can't express: a lamp above a key that is on. */
	[data-theme='oldschool'] .chip[aria-pressed='true']::before {
		content: '';
		/* ... */
	}
}
```

Keep the structural part small: a few rules for what tokens can't say (an
`::before` lamp on `[aria-pressed='true']`, `appearance: none` plus thumb
pseudo-elements for a fader-like range, interlocked segmented keys). Anything
two themes would both need belongs in a token instead.

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
