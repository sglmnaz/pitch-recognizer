# 9. A calibration page, and field diagnostics instead of guesses

## Status

Accepted

## Context

Changes In time and Tab judge timing from the mic, and on a phone that only
works once two delays are known: when the click really reaches the ears (Audio
delay: the browser's own figure can be off) and how late the mic hears the
guitar (Mic delay: speaker, room, input path, ~300 ms on a Xiaomi). They sat as
two rows deep in Settings → Metronome, and nobody could tell they mattered or
how to set them.

Tuning the detectors on that phone went badly by guessing from summaries: three
fixes in a row were built on hypotheses, and two made Changes worse (reverted
in 567d68b). The phone's own audio and timing were the missing evidence.

## Decision

- **A page of its own, `#calibration`** (`ts/features/calibration/`), with no
  tab: Settings stays lit in the tab bar, Back returns to the page you came
  from. Two guided steps, each saying what it needs before it starts, showing
  its state (lamp, value, date: `audioCalibratedAt`, `micCalibratedAt`) and
  redoable:
  1. *Your ears*: tap along with the clicks (Audio delay, beat lights).
  2. *The microphone*: the phone hears its own clicks (Mic delay, Changes and Tab).
- **Ways in**: a Calibration card on top of Settings, and a calibration row in
  Changes In time and Tab (`ts/ui/cal-key.ts`): until the mic is calibrated a
  blinking amber lamp, "Mic not calibrated" and Calibrate; then the Mic delay
  and Redo. (A "CAL" key with a lamp above it broke the rows it sat in and
  said nothing to the player.) The delays' rows left Settings → Metronome for the
  page's Fine-tune by hand.
- **Diagnostics on the same page**:
  - *Field report*: while on, records the mic of every Changes In time or Tab
    session (MediaRecorder on the stream the app analyses, voice processing
    off) with the session's whole timing log, settings and device: two files
    per report, each downloaded or shared to an app, or all of them in one
    share or one .zip (`ts/core/zip.ts`, stored). The log goes as .txt: Android
    Chrome shares neither .json nor .zip. Replayed offline through the same
    code, a field problem is fixed on the sound that caused it. The last 3 are
    kept in memory until the app closes.
  - *Mic check*: live level and room noise, each strum counted with a lamp (only
    if the sound 80 ms on is tonal: a breath or a blow is as flat as noise,
    `Changes.spectralFlatness` ≥ 0.48 against ≤ 0.06 for strums), the chord
    heard and how long naming it took.
  - *Last session*: the timeline (`changesTimeline`: per judged change, the
    strums around its downbeat, the one that dated it, when the chord was
    named, the offset; outliers in red), the log, Copy.
- The timing log (`timing-probe.ts`) is always kept per session (a few entries
  a beat) and shown only on this page, never under the exercise.

## Consequences

- One place explains and holds the calibration; the exercises point there.
- A field report is the first step of any timing bug on a device: no more
  constants tuned from summaries. `npm run replay` lines a report's audio up
  with its log by the recorded clicks and tries the detectors and dating rules
  on the real sound. The first report (a Xiaomi) showed the recognizer names a
  chord 160–450 ms after the strum (not the ~1 s guessed from summaries), the
  old strum rule firing on the clicks and missing strums after the fingers'
  noise, and the player strumming ~110 ms ahead of the click; the strum
  detector and the choice of strum were retuned on it (35 of 36 changes within
  60 ms of the real strum, against 30).
- Three reports later the recognizer still dated changes late or skipped them:
  right after a change its window holds the old chord, and it calls close
  relatives by other names. In time now hears changes by sound alone: each
  strum's pitch-class profile 40–200 ms on picks one of the drill's chords
  (`Changes.drillChord`; 105 of 105 change strums right), a change is a strum
  sounding unlike the chord ringing, unless one 3× louder follows within
  300 ms (the lifted fingers' open strings). 103 of 105 changes within 60 ms
  of the strum. The recognizer only shows what it hears, and runs One-minute.
- Reports are lost when the app closes (no IndexedDB for now); sharing them is
  the way to keep one.
