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
- **Turned sideways** (approved mock-up Orizzontale 2): the same score on its side,
  high E on top, the red line near the left edge, the notes coming from the right
  (`setSide`, `.vscore--side`: the draw swaps the axes); the top row and the keys
  share one row at the bottom (✕, ↻, track, display, the view's keys, Loop last).
  That row was too full: on its side the page has a bar on top (✕, ↻, track,
  display, the keys placed 'top': Loop) and one under the score (Songs −4 −1 Play
  +1 +4, Tab Start, then the tempo). The tempo ▼ [♩ = 96 · 80 %] ▲ steps 5 BPM
  (Songs: the speed that makes the bar's tempo 5 BPM faster or slower; Tab: the
  exercise's tempo, before Start); upright it has a row over the keys. The bar
  display adds the part of the song (the last section named), on the page too.
- **Round three** (field test, mock-ups Schermo intero loop and Segni 2, "game"): the tempo
  keys step the speed by 5 % in Songs (BPM stay Tab's); A and B as on the page, with Loop,
  in the row over the transport upright (−4 −1 Play +1 +4 under it) and in the top bar
  on its side; the A–B loop shaded on the score (`setBand`). A drag along the strings
  moves through the song (`onScrub`, `secondsAtQuarter`); tracks change only by ◂ ▸ (one
  shown at a time). Marks drawn between the two notes they join, in SVG from the first
  token: legato a slur with H / P, slide a slanted line with SL, both over a soft band,
  the note not picked hollow; a bend a curved arrow toward the high strings to a hollow
  token with the fret reached (turned back where the edge leaves no room). Spacing
  (`unitPxFor`): notes of a string 40 px apart, 64 px when a mark joins them, no
  ceiling (the 160 px/quarter cap let 32nds and triplets overlap). The position reads
  `currentTime` smoothed by `performance.now()` between audio blocks: Android advances
  it 10–40 ms at a time, and at slow speeds the notes moved in visible steps.
- **Round four**: the spacing from the closest pair ran away (a grace note or a strum
  written as notes a hair apart gave thousands of px per quarter): now 36 / 48 px for
  nine pairs in ten, Songs within 56–150 px per quarter. The page opens on its side
  (`pitch-recognizer:score-turn` keeps the last choice); ↻ is drawn in SVG. The page's
  strip shows the same signs in print size (`stripParts().mark`: slur with H / P,
  slanted line with SL, bend arrow up to the fret reached).
  The player turns it with ↻: the page is rotated a quarter in CSS
  (`.score-screen--turned`). The manifest holds the app upright and unlocking it
  needs the browser's full screen, which shows Chrome's "swipe to exit" banner
  the user rejected; following the phone by its gravity sensor was rejected too
  (the player chooses). A landscape viewport (a browser tab) lays it down by itself.
- Units are the view's own: quarters for Songs, steps for Tab (`unitPx` per view).

## Consequences

- Tab's full screen hides the mic key and the status message: Start without the
  mic leaves it so both show.
- Every note of the song is drawn once per track, as on the strip; same limit as
  ADR 0012 for very long songs.
- The horizontal strip stays the default; the upright score has no visual test of
  its own beyond the new key.
