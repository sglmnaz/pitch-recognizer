# 12. Songs: a player on the Tab strip, songs from files the user brings

Date: 2026-10-23

## Status

Accepted

## Context

Players asked for whole songs on the moving tab of Trainer → Tab (ADR 0008),
slowed down or sped up, with jumps back and forth and a loop, the paid
features of the big tab sites. Tabs of copyrighted songs are elaborations of the
composition: only the author may make or publish them (L. 633/1941, artt. 4,
18; rights last until the 70th year after the author's death, art. 25), and tab
sites were shut down over it (OLGA, 1998). The licensed services (Songsterr,
Ultimate Guitar) have no public API for tabs and their terms forbid reusing
their content. So Pluck cannot ship famous songs; a player can still play any
song the user has the right to: files they wrote (MuseScore, Guitar Pro) or
bought or downloaded under their own licence (Songsterr Plus exports Guitar Pro).

## Decision

- **Trainer → Songs**, a sixth exercise, without the mic in this first version:
  no judging, no Wait. Variant A of the mock-up approved in Claude Design: the
  Tab strip with bar numbers and the A–B band, a map of the whole song on an
  LCD and a position fader under it (as on a video), Bars −4 −1 [Play] +1 +4, Seconds −10 −5 −1 +1 +5 +10 (of listening, at
  the speed set), A / B / Loop, Speed 25–200 % with a key back to 100 %, Listen
  with its own volume, Click, Count-in, Tracks (any number on: each its own
  strip, all played together at 1/sqrt(n) each),
  the song list with Import file.
- **Content**: built-in songs are public domain only, transcribed in Pluck's
  own compact notation (`ts/music/songs-catalog.ts`, `parseBars`); licensed songs
  are only ever imported by the user and stay on the device (IndexedDB,
  `songs.store.ts`). Pluck never fetches or scrapes tabs.
- **alphaTab** (`@coderline/alphatab`, MPL-2.0, used unmodified) reads Guitar
  Pro 3–7 and MusicXML (`ts/music/song-import.ts`). Only its importer is used:
  Pluck draws the strip and plays the notes. It is ~300 kB gzipped, so it is a
  dynamic import loaded on the first import, and left out of the service
  worker's precache (`globIgnores`): imported songs are stored already read, so
  playing never needs it, offline included; importing needs the network once.
- **Fixes on what alphaTab reads**: MusicXML `<sound tempo>` marks outside a
  `<direction>` (Finale writes them so) are read by Pluck, alphaTab plays those
  scores at 120; hammer-ons, pull-offs and ties, which its MusicXML import drops,
  are read by Pluck too (`musicXmlMarks`); MusicXML fingering arrives one lower (alphaTab's thumb = 0);
  no-break spaces and quotes are cleaned from titles; a score without tab gets a
  string and fret per note from the left-hand fingering (`assignPositions`:
  finger 0 = open string, finger f on fret n = the hand at n − f + 1, else stay
  in the hand's position; greedy, note by note).
- **One clock**: notes and clicks are scheduled on the synth's AudioContext
  (`ts/core/sound.ts`, which gained a note length and a click) and the strip
  reads the same clock, so they cannot drift; the shared metronome engine and
  its own AudioContext are not used. `songs.player.ts` is DOM-free, schedules a
  lookahead window like the metronome, unrolls repeats and volta endings
  (`playOrder`) and loops A–B in played bars; `npm run check:songs` drives it
  on a fake clock, silent.
- **One strip**: the Tab strip's geometry and helpers moved to
  `ts/ui/tab-strip.ts`, used by Tab and Songs (Tab's screenshots unchanged).
- **Removable**: the code is `ts/features/songs/` plus the model in
  `ts/music/song*.ts` and `songs-catalog.ts`; nothing imports from Songs but the
  Trainer's registration. Removing it: the folder and those files, the Songs
  key and blocks in `index.html` (and the Guide's Songs sections), the
  `songs.css` import, the `song*` settings, the Italian entries, `check:songs`,
  alphaTab and its `globIgnores`, the `songs` visual tests.

## Consequences

- No mic means no feedback on the playing yet; judging can come later on the
  same session pattern as Tab (single notes) and Changes (chords).
- The six Trainer keys are sized by their labels on phones (INTERVALLI).
- Long songs draw every note of the unrolled song at once; fine for songs of a
  few hundred bars, a window of the strip would be needed beyond that.
- Positions for scores without tab are a guess where the score has no
  fingering; a file with tab (Guitar Pro, MuseScore TAB staff) is used as is.
