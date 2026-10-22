# Design

Visual language: **old-school hardware**. The app reads like a piece of
1980s studio gear: a brushed aluminium front plate, a painted panel with fine
grain, bevelled keys that sink when latched, small rectangular lamps, LCD
windows behind black bezels, paper strips for charts. Approved mockups live in
`docs/design/` (`oldschool-screens.html`, `oldschool-components.html`,
`metronome-hardware-oldschool.html`); the tokens are in
[ts/styles/tokens.css](ts/styles/tokens.css). Decision record: docs/adr/0007.

## Themes

Settings > Appearance offers a **Theme** dropdown (System, Light, Dark, Night blue
and the themes below) and a **Display** colour (Theme, grey-green, amber, blue, Casio
yellow-green, red LED, green phosphor, VFD turquoise, white OLED, ice, violet, e-ink).
System follows the device between Light and Dark.

| Theme | Plate | Panel | Keys | LCD (default) |
|-------|-------|-------|------|---------------|
| Light (`classic`, light) | brushed aluminium | cream `#e7e1d3` | cream | grey-green, dark ink |
| Dark (`classic`, dark) | graphite | anthracite `#2a2825` | dark grey | negative amber `#ffb347` |
| Night (`night`, dark) | slate | navy `#1c222c` | blue-grey | blue, white ink |
| Sand (`sand`, light) | champagne | sand `#d8ccb2` | cream | grey-green |
| Studio white (`studio`, light) | silver | white `#efeeea` | light grey | grey-green; orange accent |
| Mint (`mint`, light) | pale aluminium | mint `#cfe2d9` | ivory | pale yellow; red Start |
| Studio grey (`graphite`, dark) | gunmetal | grey `#383b40` | grey | orange |
| Petrol (`petrol`, dark) | petrol | teal `#1e3638` | teal | turquoise |
| Walnut and brass (`walnut`, dark) | brass | walnut `#2e2219` | cream | nixie orange |
| Olive (`olive`, dark) | olive | olive `#4b5039` | khaki | green phosphor; amber lamps |
| Stage red (`stage`, dark) | red | red `#9e2b25` | black | red LED; yellow lamps |
| British stack (`brit`, dark) | gold, brushed across | black `#1b1a19` | black, gold legends, 2 px corners | red LED; black top-hat knobs, gold cap |
| Copper top (`copper`, dark) | copper, diamond weave | brown `#1f1b18` | dark brown, 4 px corners | amber; ivory chicken-head knobs |
| Citrus (`citrus`, light) | beige, grille weave | orange `#e2671f` | white; black Start | black, white figures; glossy black knobs |
| Black star (`blackstar`, dark) | graphite, perforated mesh | black `#151517` | graphite, 1 px corners; silver Start | ice white; knurled knobs, red pointer |
| Broadcast light / dark (`regia`, both modes) | grey-green / blue-grey | grey-green `#b8bdb4` / blue-grey `#27313a` | low flat caps in the screens' bezel (grey-green / near-black frame); backlit ON AIR Start | vector oscilloscope: green phosphor, thin Barlow Condensed digits, graticule, glass reflection; console knobs with blue / red caps, fader caps, bat-handle toggle, reverse-printed section legends |

The amp themes also set the knob through `--knob-rim`, `--knob-cap`,
`--knob-cap-inset`, `--knob-cap-ring`, `--knob-pointer` and, for a pointer
that is a shape, `--knob-pointer-shape` / `--knob-pointer-shadow` (defaults in
`rotary.css`: the knurled aluminium knob).

`<html data-theme="classic|night" data-mode="light|dark"
[data-display="green|amber|blue"]>`. The display attribute recolours only the
LCD windows, whatever the theme. Any subtree can force a mode with its own
`data-mode` (the fretboard's board theme, the trainer's light staff).

### How to add a theme

1. One block per mode in `ts/styles/tokens.css`, tier 2, overriding every
   material that differs (copy the classic block as a starting point). Keyed
   like night: `[data-theme='ocean'], [data-theme='ocean'] [data-mode='dark']`
   (add a light block the same way if the theme has one).
2. One entry in `THEMES` in `ts/ui/theme.ts` (id, label, palette, mode, the
   panel colour as `themeColor`), and the same id in the `themes` / `colors`
   maps of the inline script in `index.html`.
3. A button in Settings > Appearance (`data-theme-choice`).
4. Only if tokens cannot draw it (a different fader cap, a toggle instead of
   the slide, a graticule on the displays): `ts/styles/themes/<id>.css`, every
   rule scoped to `[data-theme='<id>']`, imported last in the components layer
   of `main.css` (Broadcast, `themes/regia.css`). A palette with both modes
   keys its blocks `[data-theme='<id>'][data-mode='light'], [data-theme='<id>'] [data-mode='light']`
   and the same for dark, with two `THEMES` entries.

### How to add a display colour

One `:root[data-display='<id>']` block in tier 3 of tokens.css setting the five
`--lcd-*` tokens, one entry in `DISPLAYS` (ts/ui/theme.ts) and the id in the
head script's `displays` map. The Settings select fills itself.

## Materials (tier 2 tokens)

| Group | Tokens | Used by |
|-------|--------|---------|
| Panel | `--panel`, `--panel-grain`, `--panel-sunk`, `--panel-raised`, `--ink` … `--ink-4`, `--rule`, `--rule-strong`, `--outline`, `--hole` | body, rows, wells |
| Plate | `--plate`, `--plate-edge`, `--plate-ink`, `--plate-ink-2`, `--plate-shine` | `.plate` |
| Keys | `--key-face`, `--key-hi`, `--key-side`, `--key-front`, `--key-ink`, `--key-drop`, `--key-lip`, `--key-drop-down`; grey `--key2-*`; hot `--key3-*` | key.css |
| Lamps | `--lamp-off/on/glow`, `--lamp-ok-*`, `--lamp-warn-*`, `--lamp-ring` | lamp.css, tab bar, readout |
| Window, LCD | `--window`, `--window-shadow`; `--lcd-bg`, `--lcd-ink`, `--lcd-dim`, `--lcd-glow`, `--lcd-shadow`; derived `--lcd-ok` / `--lcd-warn` / `--lcd-bad` (lamp colours mixed into the ink: verdicts on any LCD) | `.window`, `.lcd`, selects, readouts, Changes meter |
| LED | `--led-bg`, `--led-on`, `--led-off`, `--led-glow`, `--led-unlit` | counters, VU bars |
| Paper | `--paper`, `--paper-ink`, `--paper-grid`, `--paper-pen`, `--paper-edge` | staff, charts, diagrams, guide |
| Rocker, track | `--rocker-plate`, `--rocker-up`, `--rocker-down`, `--rocker-ink`, `--track` | switches, faders |
| Music | `--root-*`, `--tone-*`, `--note-*`, `--board-*`, `--dial-face`, `--dial-near`, `--dial-ok` | necks, degree keys, tuning dial |
| Signals | `--accent` (red ink: needles, marks, focus), `--success`, `--warning` | |

Generic roles (`--bg`, `--surface`, `--surface-2`, `--border`, `--fg`,
`--fg-secondary`, `--fg-muted`, `--shadow-border`, `--staff-*`) are derived from
the materials, so plain text and rules need nothing theme-specific.

## Typography

- **Barlow Semi Condensed** (500/600/700) for labels, keys and values:
  uppercase, tracked out like silk-screen print (`--font-ui`).
- **Geist** for running text: hints, descriptions, the guide (`--font-text`).
- **Chakra Petch** (600) for the large display values, roughly 28 px and up:
  the note and chord name, the tempo (`--font-display`, `.lcd__big`); Broadcast
  sets thin **Barlow Condensed** instead. **DSEG7** (seven-segment) for the
  LED counters only (`--font-segment`). Small values on an LCD stay in Barlow.
- All self-hosted in `ts/styles/fonts/` with their OFL licences.

### Fonts the user picks

Settings → Appearance → UI font / Display font, independent of the theme and
the LCD colour: `<html data-font-ui data-font-display>` (absent = the theme's
own), set by the head script and `ts/ui/theme.ts` (`UI_FONTS`,
`DISPLAY_FONTS`, keys `pitch-recognizer:font-ui` / `:font-display`). The faces
and the overrides of `--font-ui` / `--font-display` are in
`ts/styles/typefaces.css`, a tokens-layer file after tokens.css; no component
CSS names a face. UI faces carry their own family name (`'Inter Tight UI'`)
and a `size-adjust` so their uppercase labels fit where Barlow's do (the
Italian tab bar is the tightest); display faces are scaled to Chakra Petch's
cap height and declared for weights 100–900, since views ask for 600 (or
200–300 in Broadcast) and one file must answer without a faux bold.

To add a font: the latin woff2 and its OFL text in `ts/styles/fonts/`, the
`@font-face` and the `:root[data-font-…='<id>']` block in typefaces.css (measure
cap height and uppercase width against Barlow or Chakra Petch for the
`size-adjust`), the entry in `UI_FONTS` / `DISPLAY_FONTS`, the id in the head
script's `fontsUi` / `fontsDisplay`, the name in `ts/i18n/it.ts` (kept as is),
the id in the visual tests' font list. Check the Italian tab bar at 375 px.

## Components

- **Keys** (`.key`, `.btn`, `.chip`, `.link-btn`, segmented keys): a lit top
  chamfer, shaded cheeks, a front edge, a dark outline. Latched keys sink 3 px
  and go a shade darker while the panel lip shades their top; the box never
  changes size and nothing animates. Variants: `.key--step` (grey ◀ ▶ ▼ ▲),
  `.key--hot` (orange Start), `.key--lit` (legend lights red when on: Listen),
  `.key--flat` (no drop shadow).
- **Interlocked keys** (`.segmented`): a dark well holding a row of keys,
  exactly one down. The mode switch at the top of a view carries a lamp above
  each key (`.has-lamps`).
- **Rocker switches** (`.switch`): label left, an O / I rocker right; the I
  half lights red when on.
- **Selects**: an LCD window; the open list is the system's. `withStepper()`
  (ts/ui/stepper.ts) adds ◀ ▶ keys.
- **Readout**: an LCD with the note in dot matrix, Hz and cents below, a green
  IN TUNE lamp; the cents meter is a hi-fi tuning dial (printed ruler, amber
  near band, green band = tolerance, red needle).
- **Plate**: the aluminium front of each view with the brand ("PLUCK" + model);
  edge to edge on phones, framed on wider screens.
- **Tab bar**: icons and silk labels on the panel, a lamp above each, lit on
  the tab in view; docked to the bottom on phones.
- **Guide**: a page of the operator's manual (paper, numbered steps).
- **Settings**: a band per group (name + rule), printed rows, the right
  control on the right (rocker, LCD select, fader, LCD number).
- **Density**: on phones blocks sit `--stack` apart and hero type shrinks on
  short screens so each view's main interaction fits one screen; tap targets
  never drop below 44 px.

## Motion

Keys snap, they don't animate. The needle tracks pitch (80 ms linear); lamps
switch instantly. Reduced motion turns off what little else moves.
