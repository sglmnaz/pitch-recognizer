# 6. One mic module, views signal their need

## Status

Accepted

## Context

`main.ts` held the mic state machine (start / stop / resume, `micResume`,
blocked), the shared `#mic` block's UI, the waveform renderer and the `?debug`
recorder next to the tab routing. Views told it that `wantsMic()` changed in two
ways: an `onMicNeed` callback threaded through the Trainer, Chords and Chord
modes factories, and a separate `MicControl` object (state + listen) passed to
Scales, whose `syncMic()` `main.ts` called back. Changes reached into the DOM for
`#micButton`.

## Decision

- `ts/ui/mic-block.ts` owns the mic and the `#mic` block. Exports:
  `micNeedChanged()` (the old `syncMicNeed`), `micState()`, `setListening(on)`
  (Scales' toggle; `false` = stop without resetting the view), `onMicChange(fn)`
  (runs whenever the button and status are redrawn), `focusMicButton()`, and for
  `main.ts` only `initMic(activeView)` / `bootMic()`.
- It never imports a feature view: `main.ts` passes the active view as a getter,
  views import the module. No cycle.
- `ts/ui/waveform.ts` and `ts/ui/debug.ts` hold the strip and `?debug`.
- `main.ts` keeps routing and bootstrap; `activate()` also stops the
  Metronome tab's clicks on any tab but Metronome and Settings (was a
  `hashchange` listener in the Metronome view, which ran just before it).

## Consequences

- One way to say "my mic need changed"; factories lose their callback
  parameters.
- `mic-block.ts` looks up `#mic`, `#micButton`, `#status` and `#waveform` when
  first imported, like `main.ts` did: it must only be imported by browser code.
- Construction order of the views is unchanged (Scales first), so listener
  order is too.
