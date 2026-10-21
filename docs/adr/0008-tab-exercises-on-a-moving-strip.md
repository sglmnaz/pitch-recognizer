# 8. Tab exercises on a strip that moves by itself

## Status

Accepted

## Context

The Trainer had no technique work: Notes, the ear drills and Changes train the
ear and chord changes, not agility, picking or legato. Technique exercises are
read from tab while both hands are busy, so a page the player has to scroll does
not work. Exercises published by well-known players come from books and videos
we cannot copy, and the mic only gives one smoothed pitch per frame, no note
list.

## Decision

- **Trainer → Tab**, a fifth exercise. `ts/music/tab.ts` (pure) generates nine
  exercises from rules (fingerings, scale positions, sequences), one or more per
  goal: agility, sync, speed, string changes, legato, sweep, bends. `from` names
  whose idea each one is (Paul Gilbert, Joe Satriani, Frank Gambale, …); nothing
  is transcribed.
- **A strip that moves under a still playhead** (`tab.view.ts`, the Nastro mock-up
  approved in Claude Design): strings, clef and the red playhead band stay put,
  only the notes slide. Two copies of the loop side by side make the wrap
  seamless. Two ways to follow, one setting (`tabFollow`):
  - *Tempo*: one bar of count-in on the shared metronome, then the strip's
    position is the last heard beat plus the time since (`BeatEvent.heardAt`,
    so the audio-delay setting applies), capped so a stalled timer cannot run
    it ahead.
  - *Wait*: no clock; the strip steps to each note once the mic hears the one
    before. A wrong note is named with how many frets off it is.
  A page layout (one bar per row) can come later on the same note list.
- **Judging from note starts, not frames.** `createNoteFollower()` turns frames
  into note starts: a new pitch that holds two frames, or the same pitch after
  an attack. Picked notes are dated at their attack, hammer-ons and pull-offs
  (no attack) by `LEGATO_LATENCY_MS`. Readings during the pipeline's attack
  blank are skipped: it repeats the previous note there. `judgeNote` marks a due
  note on time within a third of a step (60–110 ms), early or late within half a
  step, else missed; each start counts for one note only. Bends are judged on
  reaching the target pitch within 30 cents while they last.
- **Clicks through a speaker** are heard as attacks; one within 40 ms of a click
  is ignored (as in Changes) unless the tab has the same note again right there,
  where only the attack tells a repeated note apart.
- The session is DOM-free (`tab.session.ts`, like Changes) and `npm run check:tab`
  plays every mode with a simulated guitarist against a fake metronome.
  Records per exercise (`pitch-recognizer:tab:<id>`): the fastest clean loop and
  the tempo last used, where the next session starts.

## Consequences

- Fast passages depend on the pitch pipeline's latency: the two latency
  constants are calibration knobs to tune on `?debug` recordings of real
  playing; Wait works at any speed.
- One pitch per frame means single-note lines only: no chords in tab exercises.
- New exercises are a builder in `tab.ts` plus a line in `exercises()`; the
  check's generic tests (whole bars, ordered, playable) cover them.
