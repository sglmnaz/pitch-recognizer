# Benchmark

`npm run bench` runs the app's own note and chord detection (`processFrame` from
`ts/microphone.ts`, `recognizeChord` from `ts/chords.ts`) over labelled guitar
audio and reports mir_eval-style metrics, accuracy **and** response time, so
changes can be compared on the same data. Needs `ffmpeg` on the PATH.

```
npm run bench                                            # default subset (60 items per source), all conditions
npm run bench -- --task chords --limit 20 --conditions clean,phone-mid   # quick iteration (~2 min)
npm run bench -- --full                                  # everything (slow)
npm run bench -- --json results.json                     # save numbers to diff two versions
```

## Data (local only)

Datasets live in `bench/data/` — git-ignored, never bundled into the app. Delete
the folder when done; re-download to run again.

| Source | Folder | Used for |
|---|---|---|
| [IDMT-SMT-Guitar](https://zenodo.org/records/7544110) (CC BY-NC-ND 4.0) | `bench/data/idmt/IDMT-SMT-GUITAR_V2/` | notes: dataset2, plain plucked single notes; chords: dataset4 `acoustic_mic` |
| [GuitarSet](https://zenodo.org/records/3371780) (CC BY 4.0) | `bench/data/guitarset/{annotation,audio_mono-mic}/` | chords: comping excerpts, instructed chord labels |
| own recordings (optional) | `bench/audio/` | `note-E2-….m4a`, `chord-Am-….m4a`, one sound per file |

## Phone conditions

Studio recordings are degraded to simulate different phones and rooms (seeded,
so every run hears the same audio): `clean`, `phone-good` (low cut 100 Hz,
25 dB SNR, small room), `phone-mid` (150 Hz, 15 dB, medium room), `phone-cheap`
(250 Hz, 10 dB, reverberant). See `CONDITIONS` in `scripts/audio.ts`.

## Metrics

Notes (mir_eval.melody, 50-cent tolerance; frames from 300 ms after each onset):

- **RPA** right note in the right octave; **RCA** right note, octave ignored
  (RCA − RPA = octave errors); **voiced** frames with any reading
- **IQR¢** spread of the cent offset on correct frames (needle steadiness)
- **first-ok** median time from the onset to the first correct reading

Chords (frame-level chord symbol recall, MIREX reductions as mir_eval.chord;
references outside a level's vocabulary are left out of it):

- **root**, **majmin** (major/minor family), **sevenths** (maj, min, 7, maj7, min7)
- **latency** median time from a chord change until it is first named
  (the app's 250 ms display confirmation comes on top)
- **top confusions** most frequent wrong answers at the sevenths level

## Results so far (default 2026-10-16, quick set for chords)

| | notes RPA | first-ok | chords majmin | sevenths | latency |
|---|---|---|---|---|---|
| clean | 99.2 % | 155 ms | 61.7 % | 50.4 % | 274 ms |
| phone-mid | 99.0 % | 153 ms | 62.2 % | 50.9 % | 273 ms |
| phone-cheap | 96.7 % | 152 ms | | | |
