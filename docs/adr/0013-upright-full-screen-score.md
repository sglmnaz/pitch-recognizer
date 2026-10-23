# 13. An upright, full-screen score for Tab and Songs

Date: 2026-10-23

## Status

Accepted

## Context

On a phone held upright the horizontal strip of Trainer → Tab and Songs (ADR
0008, 0012) shows a few beats at a time between the plate and the keys, and
several tracks stack into thin strips. Players asked for a mode like the falling
notes of rhythm games, with the tracks one at a time. Three rounds of mock-ups in
Claude Design; the user approved variant D (Verticale 3).

## Decision

- **`ts/ui/vertical-score.ts`**, shared like `tab-strip.ts`: `createVerticalScore`
  draws one track upright (strings as lanes, thick low E on the left, a lane shaded
  every other string, round tokens with the fret falling onto a red line with a
  target per string, a tail behind a note as long as it rings, bar numbers at the
  right end of the bar line, the current one red, string names at the bottom) and
  moves only its layer of notes (one transform), as the strip does. `place(at,
  playing)` lights the notes struck last while they ring.
- **`createScoreScreen(keys, onClose)`**: a page over the whole app (tab bar
  included): ✕, the track's name with ◂ ▸ and a lamp per track, a small LCD, the
  scores in a carousel (native CSS scroll snap, swipe), the keys the view hands it
  (Songs: −1, Play, +1, Loop; Tab: Start, Loop). The view keeps wiring and state:
  its full-screen keys mirror the ones on the page. A history entry while open, so
  Android's Back leaves it.
- **Way in**: a ⛶ Full screen key under each strip; any width, no automatic
  switch on rotation or size.
- Units are the view's own: quarters for Songs, steps for Tab (`unitPx` per view).

## Consequences

- Tab's full screen hides the mic key and the status message: Start without the
  mic leaves it so both show.
- Every note of the song is drawn once per track, as on the strip; same limit as
  ADR 0012 for very long songs.
- The horizontal strip stays the default; the upright score has no visual test of
  its own beyond the new key.
