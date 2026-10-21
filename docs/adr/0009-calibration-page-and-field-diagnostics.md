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
- **Ways in**: a Calibration card on top of Settings, and a CAL key in Changes
  In time and Tab whose lamp blinks until the mic is calibrated
  (`ts/ui/cal-key.ts`). The delays' rows left Settings → Metronome for the
  page's Fine-tune by hand.
- **Diagnostics on the same page**:
  - *Field report*: records the mic of the next Changes In time or Tab session
    (MediaRecorder on the stream the app analyses, voice processing off) with
    the session's whole timing log, settings and device, shared as two files.
    Replayed offline through the same code, a field problem is fixed on the
    sound that caused it. Kept in memory until the app closes.
  - *Mic check*: live level and room noise, each strum counted with a lamp, the
    chord heard and how long naming it took.
  - *Last session*: the timeline (`changesTimeline`: per judged change, the
    strums around its downbeat, the one that dated it, when the chord was
    named, the offset; outliers in red), the log, Copy.
- The timing log (`timing-probe.ts`) is always kept per session (a few entries
  a beat); the Timing log switch only shows it under the exercise as well.

## Consequences

- One place explains and holds the calibration; the exercises point there.
- A field report is the first step of any timing bug on a device: no more
  constants tuned from summaries. A replay script that feeds a report through
  `processFrame` and the sessions is the next piece, written when the first
  report arrives.
- Reports are lost when the app closes (no IndexedDB for now); sharing them is
  the way to keep one.
