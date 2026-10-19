# Pluck

A guitar practice web app that listens through the microphone: a tuner, a chord
recognizer and library, a scale and harmony explorer, ear training and chord-change
drills, and a metronome. Installable as a PWA, works offline.

Vanilla **TypeScript** (no framework), [**VexFlow**](https://www.vexflow.com/) for
notation (the only runtime dependency), styled after
[**Vercel Geist**](https://vercel.com/geist) (light and dark), bundled with
[**Vite**](https://vitejs.dev/), deployed on Vercel. Pitch detection and chord
recognition are the app's own code.

## The six tabs

The tab bar sits at the top on wide screens and docks to the bottom edge on phones.
The microphone starts on load (if the browser waits for a gesture, the status says
"Tap to start"); tabs that do not listen turn it off and back on when you leave.

- **Tuner**: pick a tuning (Standard, Drop D, half / whole step down, DADGAD, open
  G / D / E / C…) to read cents off the nearest string, or **Chromatic** for the
  nearest note of any pitch. A needle meter with a green in-tune band (±2, ±5 or
  ±10 cents) and a readout that locks green; tap a string chip to hear its reference
  tone. A4 is adjustable (415–466 Hz) and used by every tab that names notes.
- **Chords**:
  - **Listen**: strum and let it ring; names major, minor, 7, m7, maj7, 9, sus2 and
    sus4 chords, with a live pitch-class profile. Tap the chord to open it in the
    Library.
  - **Library**: pick a root and type for the spelled notes and degrees, the keys
    the chord belongs to, and up to eight playable voicings (tap to strum or
    arpeggiate).
  - **Identify**: mark one note per string on a neck and get the chord, slash
    chords included.
- **Scales**: an SVG fretboard with real fret spacing. **Explore** a root and scale
  (degree colours, note or interval labels, positions 1–5, play the scale, the note
  you play lights up) or **Identify** a scale from marked or played notes. Below the
  neck, a harmony section: the chords of the scale (triads or sevenths), common
  progressions to play along with, and the circle of fifths; Identify suggests
  chords that fit.
- **Trainer**:
  - **Notes**: a note on the staff; sing or play it and hold it in tune to score.
  - **Intervals** and **Chords**: ear training; hear an interval or a chord
    quality and tap the answer (intervals can also be answered by singing).
  - **Changes**: chord-change drills, One-minute (count the changes) or In time
    with the metronome (each change judged early / on time / late; headphones work
    best there, since the mic can hear the clicks).
- **Metronome**: 30–300 BPM with tap tempo, beats and beat note, per-beat accent /
  mute, subdivisions, three sounds, a speed trainer and an optional beat-1 flash.
- **Settings**: one scrolling page with every tab's options plus the theme
  (System / Light / Dark) and the fretboard (board theme, left-handed). Settings are
  saved in the browser.

## Getting started

Requires [Node.js](https://nodejs.org/) **24** (the check scripts run the
TypeScript sources directly).

```sh
npm install
npm run dev       # http://localhost:5173 (localhost counts as a secure origin for the mic)
npm run build     # tsc --noEmit (strict), then vite build into dist/
npm run preview   # serve the production build
```

Self-checks (no test framework; each prints `ok` / `FAIL` lines and exits non-zero
on failure, through the shared `scripts/check.ts`). `npm run check` runs them all
in turn and stops at the first failure; `npm run typecheck` type-checks `ts/` and,
with `tsconfig.scripts.json`, the Node-side `scripts/` and `tests/`:

| Script | Checks |
|---|---|
| `check:pitch` | synthetic plucked strings through the detection pipeline |
| `check:chords` | synthetic strummed chords through the recognizer |
| `check:scales` | scale spelling and the scale identifier |
| `check:tunings` | tuning presets, nearest string, A4 clamp |
| `check:metronome` | click engine on a fake audio clock (spacing, accents, subdivisions, speed trainer, stalls) |
| `check:chord-theory` | chord spelling, identifier, diatonic chords, chord-book voicings |
| `check:ear` | ear-training questions, playback timing, sung answers, scoring |
| `check:chord-library` | Library helpers (labels, keys containing a chord, symbol parsing) |
| `check:harmony` | keys, progressions, circle of fifths, scales for a chord |
| `check:changes` | chord-change drill: stabilizer, change counter, in-time judging, records |
| `check:settings` | the settings loader against corrupt and stale stored values |

Visual regression ([Playwright](https://playwright.dev/), Chromium only; once:
`npx playwright install chromium`): `npm run test:visual` builds the app, serves
the production build on port 4179 and compares every tab and sub-mode at 375×812,
768×1024 and 1280×800 in light and dark against the baselines in
`tests/visual/__screenshots__/`, plus a few behaviour checks (hash routing,
settings after a reload, help dialog, metronome Start / Stop). The microphone is
always refused and `Math.random` seeded, so every run renders the same. After an
intended visual change, `npm run test:visual:update` rewrites the baselines:
review the changed PNGs before committing them. The baselines were generated on
Windows; another OS rasterizes fonts differently, so regenerate them there.

`npm run bench` scores note and chord detection on labelled guitar datasets
(downloaded locally, never bundled; needs `ffmpeg`). See
[bench/README.md](bench/README.md).

Add `?debug` to the URL for a live line with what the noise gate sees and a button
that records 20 s of the raw mic stream, to replay field problems through the
scripts.

## How detection works

**Notes** (`ts/core/microphone.ts`): the mic stream (browser voice processing off) is
band-limited to the guitar (two 70 Hz high-pass stages, 1.4 kHz low-pass) and
analysed every animation frame with the McLeod Pitch Method, the autocorrelation
computed from the power spectrum after subtracting the learned room noise. An
adaptive noise gate with hysteresis, onset detection per pluck, an octave check and
lock, a median window and a One Euro filter keep the readout steady. On the test
split of the benchmark it reads the right note in the right octave in ~98.5 % of
frames on clean electric recordings.

**Chords** (`ts/music/chords.ts`): a small learned model (10.7k parameters, its weights a
separate chunk loaded on first use) turns a log-frequency, harmonically stacked
spectrum into per-semitone salience, then chroma and bass features, and scores the
8 chord types on all 12 roots plus "no chord"; an HMM smooths it over time.
Benchmark, test split, clean: root 77.5 %, major/minor 74.0 %, sevenths 62.6 %,
~283 ms to name a change. Those totals are optimistic, because the test takes share
pieces and guitars with the training takes. The GuitarSet-only row is the honest
one: root 74.4 %, major/minor 68.4 %, sevenths 51.5 %. Expect less on a new guitar
in a new room. Details in [bench/README.md](bench/README.md).

## Project structure

```
index.html              App shell: all markup; TS only wires it up
vite.config.ts          Vite + PWA (manifest, Workbox precache)
ts/
  main.ts               Tab routing and bootstrap
  core/                 Runtime services
    microphone.ts       Web Audio capture + MPM pitch detection loop
    fft.ts              FFT used by the detector
    sound.ts            Plucked-string synth and reference tones
    metronome.ts        Lookahead click engine (own AudioContext)
    settings.ts         Persisted, validated settings store
    notes.ts            Note table and helpers
  music/                Pure music logic (the checks run it under Node)
    chords.ts           Learned chord recognizer (+ chord-model.ts weights)
    tuning.ts           Tuning presets
    scales.ts           Scale formulas, fretboard constants, scale identifier
    chord-theory.ts     Chord spelling, identifier, chords of a scale
    chord-shapes.ts     Playable voicing generator
    chord-library.ts    Library helpers (labels, keys, symbol parsing)
    harmony.ts          Keys, progressions, circle of fifths
    ear.ts / changes.ts Ear-training and chord-change drill logic
    game.ts             Notes trainer rounds and scoring
  ui/                   Shared UI: view.ts (the View interface), fretboard.ts
                        (SVG neck), music-renderer.ts (VexFlow staff), help.ts,
                        mic-block.ts (the mic and the shared #mic block),
                        waveform.ts, debug.ts (?debug line and recorder)
  features/<tab>/       One folder per tab, a factory per view (*.view.ts):
                        tuner, chords (+ chord-library), scales (+ harmony,
                        circle, progression-player), trainer (+ ear, changes,
                        changes.session, changes.recognizer), metronome, settings
  styles/               tokens.css / style.css (Geist tokens, light + dark /
                        layout and components), fonts/
scripts/                Self-checks, benchmark, chord-model training data
bench/                  Benchmark notes and results
tests/visual/           Playwright visual regression suite and its baselines
docs/adr/               Architecture decision records
```

## Install (PWA) and deploy

On an HTTPS deployment the app can be installed: *Add to Home Screen* on Android
Chrome or iOS Safari. It then launches standalone and works offline.

The repo is Vercel-ready: [vercel.json](vercel.json) pins the Vite preset and the
`dist` output and sets no-cache headers on the service worker and manifest so
updates land immediately. Import the repo at [vercel.com/new](https://vercel.com/new)
or run `vercel`; no environment variables are needed. The microphone and the
service worker need a secure origin (HTTPS, or localhost in development).

## License

MIT
