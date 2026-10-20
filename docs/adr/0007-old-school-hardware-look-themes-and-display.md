# 7. Old-school hardware look: themes, display tier, bevelled keys

## Status

Accepted (2026-10-20), supersedes the palette model of ADR 0005 (its token
tiers and forced-mode subtrees stay). Implemented on branch `redesign/oldschool`.

## Context

The app looked like Vercel Geist: near-monochrome surfaces, pill switches,
segmented tracks. Design explorations (`docs/design/`) settled on a different
language, approved piece by piece: an aluminium front plate, a cream (or
graphite) panel with grain, bevelled keys that sink when latched, rectangular
lamps, LCD windows, paper strips for charts, rocker switches. The user wants
three themes now (light, dark, night blue), the LCD colour selectable on its
own, and room for more themes later without touching components. The Geist
look is dropped, not kept as a second style.

## Decision

- **One look, several themes.** `<html data-theme="classic|night"
  data-mode="light|dark">`. The user picks one of System / Light / Dark / Night
  (`THEMES` in `ts/ui/theme.ts`, stored under `pitch-recognizer:mode`); each
  maps to a palette (`data-theme`) and a mode. Night is dark only.
- **Display tier.** `data-display="green|amber|blue"` on `<html>` overrides only
  the `--lcd-*` tokens; absent means the theme's own LCD (green-grey on classic
  light, amber on classic dark, blue on night). Stored under
  `pitch-recognizer:display`.
- **Tokens** (`ts/styles/tokens.css`): tier 1 shape (fonts, sizes, key
  geometry, lamp size) on `:root`; tier 2 one block per theme × mode with every
  material (panel, plate, keys, lamps, window, LCD, LED, paper, rocker, degree
  and board colours, dial); tier 3 the display overrides. Generic roles (`--bg`,
  `--surface`, `--fg`, `--fg-muted`, ...) are derived from the materials on
  every mode selector, so a forced-mode subtree re-resolves them.
- **Keys** (`components/key.css`): one bevel for every pressable control, drawn
  with inset shadows inside the padding box. Latched (`aria-pressed`,
  `aria-selected`, `.is-down`) or held keys sink by a transparent top border
  and a shorter front edge: the box never changes size, so nothing around a
  key moves. Variants are five custom properties (`--k-face`, `--k-hi`,
  `--k-side`, `--k-front`, `--k-ink`).
- **Surfaces as classes**: `.plate`, `.window`, `.lcd` (+ `.lcd__big` in segments
  for large values only), `.paper`, `.silk`, `.rule`, `.lamp`, `.has-lamps`.
- **Fonts**: Barlow Semi Condensed for labels and values, Geist for running
  text, DSEG14 / DSEG7 segment displays for large display values only. Self-hosted woff2
  (OFL licences next to them); Geist Mono removed.
- Selects keep the system list; the closed select reads as an LCD and
  `ts/ui/stepper.ts` can add ◀ ▶ keys.

## Consequences

- A new theme is one block per mode in tokens.css, one `THEMES` entry, the id in
  the head script; a new LCD colour is one tier-3 block and one `DISPLAYS` entry.
- Components never carry colours; SVG drawn from TS uses classes or
  `var(--token)`.
- Every visual baseline changes once (ADR 0001): regenerated after the redesign.
- The palette picker and the Geist primitive scales are gone; old stored keys
  (`theme`, `pitch-recognizer:palette`) are migrated or dropped on first load.
