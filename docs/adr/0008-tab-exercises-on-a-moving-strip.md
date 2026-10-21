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

## Addendum (2026-10-22): 23 exercises, levels, credits

The nine exercises were too few, and some weak. Single-string bursts (one
fret picked over and over) is gone; Spider and Pentatonic in fours stay
without a credit: an exercise many teachers recommend does not need an
author. The list is now 23, generated from rules as before. Giuliani and
Carcassi, public domain, are note for note.

- **Levels**: every exercise is beginner, intermediate or advanced
  (`Tab.LEVELS`); the list filters by goal and by level (`tabGoal`,
  `tabLevel`). A new goal, Fingerstyle, holds Giuliani and Carcassi.
- **Credits**: `credit` (proper names and a short source, no link) shows
  under the exercise's instructions only, not in the list: with one or two
  exercises per player, a list by name would mean little. The sources checked
  for each (2026-10-22):
  - Steve Vai, 10-Hour Workout (Guitar World, January 1990; Hal Leonard
    reprint): permutations, rotating 1234 / 2341 / 3412 / 4123.
    https://www.groove3.com/viewbook/Steve-Vais-Guitar-Workout
  - Nita Strauss, Guitar World 2018: chromatic shift (it was credited to
    John Petrucci, which no source confirmed).
    https://www.guitarworld.com/lessons/getting-your-chops-in-tip-top-shape
  - Joe Satriani, Guitar One 1999 (Dale Turner): trills, a scale on one
    string. https://intimateaudio.com/psycho_licks.satriani.html
  - Paul Gilbert, Guitar One 1999 and Intense Rock (REH, 1988): six-note
    lick, outside picking, string skipping.
    https://intimateaudio.com/psycho_licks.gilbert.html,
    https://www.guitarworld.com/lessons/intense-rock-picking-a-brief-look-at-paul-gilberts-alternate-picking-technique
  - John Petrucci, Total Guitar 2020: legato 1-3-4 / 1-2-4.
    https://www.musicradar.com/totalguitar/john-petruccis-ultimate-warm-up-guest-lesson-533027
  - Justin Sandercoe, JustinGuitar: Finger Gym, Minimum Movement (pentatonic
    box). https://www.justinguitar.com/guitar-lessons/play-better-guitar-the-finger-gym-exercise-bg-1503
  - Andy Timmons, Guitar World 2022: bend, then the fretted note it must
    reach (B 12 / E 9, G 14 / B 12), no vibrato.
    https://www.guitarworld.com/lessons/andy-timmons-string-bending
  - Eric Johnson's fives (Phil Hilborne, MusicRadar 2019).
    https://www.musicradar.com/how-to/5-guitar-tricks-you-can-learn-from-eric-johnson-today
  - Al Di Meola's five-and-four run, taught by Alex Skolnick (Guitar Player
    2023). https://www.guitarplayer.com/lessons/vai-tremonti-bonamassa-stern-malmsteen-gilbert-skolnick-satriani-johnson
  - Frank Gambale's economy picking. https://troygrady.com/interviews/frank-gambale/
  - Eddie Van Halen's tapping (Eruption, 1978): tap, pull-off, hammer-on.
  - Mauro Giuliani, Op. 1 No. 4 (1812): https://imslp.org/wiki/Studio_per_la_chitarra,_Op.1_(Giuliani,_Mauro)
  - Matteo Carcassi, Op. 60 No. 1, bars 1–4: https://imslp.org/wiki/Etudes,_Op.60_(Carcassi,_Matteo)
- **Taps** are `tech: 't'`: struck, so judged like a pick, drawn T over the note.
- **Judging**: a pick's frames count for its note only from 40 ms on
  (`READ_AFTER_PICK_MS`). Right after a pick the window mixes two notes, and
  two a whole step apart read as the one between: on one string, a line
  played a fret off scored a third of its notes on time. `check:tab` now
  plays every exercise but the bends through the real pipeline: played
  right, 100% on time; a fret off, 0–4%.
- **The list** (after the user's review): one row per exercise, its goal
  stamped in an outline on the name's line, level, subdivision and record
  under it; only a black ▶ key loads it (a key, so it clicks and buzzes like
  the others; lit red while loaded) and brings the page back to the top,
  ready to start. The record's LCD and the lamp on the left are gone.
- **One tempo** (`tabBpm`) for every exercise: changing exercise no longer
  changes the tempo; a Tempo session ends saving the tempo it reached there.
  Records keep only the best clean BPM.
