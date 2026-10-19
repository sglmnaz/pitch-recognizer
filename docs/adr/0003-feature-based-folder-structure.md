# 3. Feature-based folder structure

## Status

Accepted

## Context

`ts/` held 21 modules side by side plus `views/` with 11 more. Runtime services
(microphone, synth, metronome engine, settings), pure music logic (scales, chord
theory, the recognizer) and shared UI (fretboard, staff, help) were
indistinguishable by location, and a tab's code was spread across both levels
(e.g. the Trainer: `views/trainer.ts`, `views/ear.ts`, `views/changes.ts`,
`ear.ts`, `changes.ts`, `game.ts`).

## Decision

One pure-move commit (`git mv`, only import paths change):

- `ts/core/`: runtime services: `microphone`, `fft`, `sound`, `metronome`,
  `settings`, `notes`.
- `ts/music/`: music logic the `check:*` scripts run under Node: `scales`,
  `chord-theory`, `chord-shapes`, `harmony`, `tuning`, `chords` (+ the lazy
  `chord-model` chunk), `ear`, `changes`, `game`, `chord-library`.
- `ts/ui/`: shared UI: `view.ts` (the `View` interface), `fretboard`,
  `music-renderer`, `help`.
- `ts/features/<tab>/`: one folder per tab, views named `*.view.ts`:
  `tuner/`, `chords/` (+ `chord-library.view.ts`), `scales/`
  (+ `harmony.view.ts`), `trainer/` (+ `ear.view.ts`, `changes.view.ts`),
  `metronome/`, `settings/`.
- `ts/main.ts` (was `index.ts`), `ts/styles/` (`tokens.css`, `style.css`,
  `fonts/`, moved together so the CSS `url()`s are unchanged).

Modules the scripts import keep explicit `.ts` extensions (Node 24 type
stripping). The dynamic `import('./chord-model.ts')` still produces its own
chunk.

## Consequences

- A tab's views live together; shared code has an obvious home.
- `core/settings.ts` imports from `music/` (tunings, ear and changes defaults):
  the layers are a map, not an enforced dependency rule.
- Paths in comments and docs were updated in a follow-up commit; `CLAUDE.md` is
  maintained separately.
- `git log --follow` is needed to see a file's history across the move.
