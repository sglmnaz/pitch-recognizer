# 5. Theming: palette × mode, three token tiers

## Status

Proposed (planned; not implemented)

## Context

`ts/styles/tokens.css` defines one flat set of custom properties per theme under
`[data-theme='light']` / `[data-theme='dark']`. "Theme" there means light or dark
only: there is no way to add a second look (another accent, a high-contrast
palette) without copying every token twice. Raw colours, their roles
(`--fg`, `--surface`, `--accent`) and component values (`--board-*`, `--root-*`,
`--tone-*`) sit in the same blocks, so changing one hue means finding every
place it was pasted. The fretboard already forces a palette on its own subtree
with a local `data-theme`, which shows the mechanism scales to subtrees.

## Decision

Split the two axes and tier the tokens:

- **Palette** (`data-theme`, e.g. `geist`): which hues the app uses.
- **Mode** (`data-mode`: `light` / `dark`, resolved from the setting or
  `prefers-color-scheme` before first paint as today): how they map to light
  and dark.
- **Tiers**:
  1. *Primitive*: raw values per palette (`--blue-600`, `--grey-100`), never
     used by components.
  2. *Semantic*: roles per palette × mode (`--fg`, `--surface`, `--accent`,
     `--success`), pointing at primitives.
  3. *Component*: per component (`--board-wood`, `--readout-lock`), pointing at
     semantic tokens.

Components read only tier 3 (or tier 2 for plain text and surfaces). Any
subtree can set its own `data-theme` / `data-mode`, as the fretboard does now.

## Consequences

- A new palette is one primitive block plus its semantic mapping; components do
  not change.
- More custom properties and one more indirection when tracing a colour.
- The migration touches every colour in `style.css`; it follows ADR 0004 and is
  verified screen by screen by the visual suite (ADR 0001), which must show no
  diff for the existing palette.

Sources: https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties,
https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/data-*,
https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme,
https://www.designtokens.org/
