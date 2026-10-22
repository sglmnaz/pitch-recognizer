# 11. Fonts the user picks, beside theme and display

Date: 2026-10-22

## Status

Accepted

## Context

Themes set every material, and the LCD colour (`data-display`, ADR 0007) is
already chosen apart from the theme. The user asked to choose the typefaces
too: the labels and keys, and the large values on the screens, independent of
both. The faces were already tokens (`--font-ui`, `--font-display`) read by
every component, so no component names a face.

## Decision

Two more attributes on `<html>`, `data-font-ui` and `data-font-display`,
stored under their own localStorage keys like the theme and the display and
applied before first paint by the head script (absent = the theme's own). A
tokens-layer file, `ts/styles/typefaces.css`, holds the extra `@font-face`
rules and one block per font overriding the token on `:root` (and, for the
display face, on every `[data-mode]` subtree, where a theme can set it again).

Faces are normalised in `@font-face`, not in component rules: UI faces get
their own family name and a `size-adjust` from their uppercase width against
Barlow Semi Condensed, so labels laid out for Barlow still fit; display faces
are scaled to Chakra Petch's cap height and declared for weights 100–900, so a
single file answers the 600 the views ask for without a synthesised bold.

## Consequences

- Adding a font touches the font folder, typefaces.css, `ts/ui/theme.ts`, the
  head script, the Italian dictionary and the visual tests (DESIGN.md lists
  the steps); no component changes.
- Small LCD values keep the UI font: only the large values follow the
  display font.
- Every face is precached by the service worker (about 15 KB each, latin only).
- `size-adjust` needs Safari 17 / Chrome 92: on older Safari the faces show at
  their natural size, still readable, some labels a little wider.
