# 1. Visual regression testing with Playwright

## Status

Accepted

## Context

Pluck has no UI tests: the `check:*` scripts cover the pure logic, but the six
tabs, their sub-modes, two themes and three layouts (phone, tablet, desktop) were
only ever checked by eye. A refactor that moves files, reformats code or rewrites
CSS must leave every screen exactly as it was, and nobody can eyeball ~150 states
after each step.

## Decision

A Playwright suite (`tests/visual/`, Chromium only) screenshots every tab and
sub-mode at 375×812, 768×1024 and 1280×800 in light and dark (one project per
size × theme, 150 baselines in `tests/visual/__screenshots__/`), against the
production build served by `vite preview` on port 4179.

Determinism comes from an init script that runs before the app: the theme and
any settings are seeded into `localStorage` on a test's first load only (so a
reload sees what the app saved), `Math.random` is a seeded mulberry32,
`getUserMedia` always rejects with `NotAllowedError` (every tab shows the same
"unavailable" mic state), service workers are blocked, reduced motion is on,
animations are disabled and the caret hidden in screenshots, canvases are
masked, and each shot waits for fonts and two frames. A vertical neck sizes
itself to the layout at draw time, so that test sends one `resize` (the app's
own redraw) before the shot. Tolerance is `maxDiffPixelRatio: 0.002`.

A few cheap behaviour checks run in the desktop-light project only: hash
routing, settings surviving a reload, the help dialog closing on Escape, the
metronome's Start / Stop label.

`npm run test:visual` compares; `npm run test:visual:update` rewrites the
baselines after an intended change.

## Consequences

- Any visual change, intended or not, fails the suite until the baselines are
  regenerated and the changed PNGs reviewed in the commit.
- Baselines were generated on Windows. Font rasterization differs per OS, so a
  run on macOS or Linux (e.g. CI) needs its own baselines.
- About 25 s per run (build included); ~9 MB of PNGs in the repository.
- The live microphone path (waveform, readings) is not covered; the `check:*`
  scripts remain the net for detection.

Sources: https://playwright.dev/docs/test-snapshots,
https://playwright.dev/docs/emulation, https://playwright.dev/docs/api/class-browsercontext#browser-context-add-init-script
