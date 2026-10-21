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

## Addendum (2026-10-21): picks, raw pitch and the spectrum

On the phone it was practically impossible to play in time: almost every note
read as missed, and a note repeated on one fret counted once. Plucked strings
rendered and sent through the real pipeline (`processFrame`) showed why:

- the pipeline's attack rule (the level doubling over its envelope) caught 1
  pick in 40 once a note rings, so repeated notes never restarted;
- every other note was dated from the smoothed pitch (7-frame median and One
  Euro, made for the tuner's needle), 50–120 ms late and gliding through the
  notes in between;
- with two strings ringing, the frame's clarity fell under the tuner's 0.85 and
  the frame read as unpitched, or the single pitch named the other string,
  often an octave off.

So the session no longer reads the tuner's reading:

- **Picks** come from `createOnsetDetector()`, on the energy of the newest
  1024 samples of the input window: a jump over the quietest level of the last
  100 ms and over the frame before (×1.3 both). It found about 98% of the picks,
  repeated notes included.
- **Pitch** is the frame's own pitch, before smoothing (`FrameStats.pitch`),
  from clarity 0.6 (`MIN_CLARITY`), matched by **pitch class**.
- **Judging knows the note due** (`judgeHeard`): the pick nearest it counts
  if any frame in the 120 ms after it reads the note's pitch class (and that
  pitch class was not already ringing, unless the tab repeats the note), or if
  the note's pitch class rose by 8% of the frame's pitch-class profile
  (`chromaOf`, from the power spectrum the pitch detector already computes,
  `getFramePower()`). A pitch change to the note (a hammer-on, a pull-off, a
  pick the detector missed) counts too.
- The click mask is gone: a click taken for a pick counts for nothing unless
  the frames after it read the note due. Tempo also clicks every note between
  the beats (subdivision = notes per beat), and the note due is circled in red
  on the strip, so the player sees and hears which note is now.

`check:tab` now plays seven exercises this way: played right, 100% on time;
a fret off, 0–13% (a trill a fret off lands on its own other note); 160 ms
behind or ahead, late or early. Real guitars, rooms and phone mics still need
the `?debug` recordings; the constants are commented where they were tuned.
