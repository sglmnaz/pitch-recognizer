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
| [GuitarSet](https://zenodo.org/records/3371780) (CC BY 4.0) | `bench/data/guitarset/{annotation,audio_mono-mic}/` | acoustic guitar via microphone. Notes: solo excerpts, isolated notes ≥ 0.45 s; chords: comping excerpts, instructed labels |
| own recordings (optional) | `bench/audio/` | `note-E2-….m4a`, `chord-Am-….m4a`, one sound per file |

## Phone conditions

Studio recordings are degraded to simulate different phones and rooms (seeded,
so every run hears the same audio): `clean`, `phone-good` (low cut 100 Hz,
25 dB SNR, small room), `phone-mid` (150 Hz, 15 dB, medium room), `phone-cheap`
(250 Hz, 10 dB, reverberant), `unplugged` (an electric guitar without amp:
no body, so the strings radiate as dipoles — ~12 dB/octave lost below 300 Hz —
36 dB quieter, over pink room noise). See `CONDITIONS` in `scripts/audio.ts`.

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
| unplugged | ~29 % (low strings 0 %: below the room noise) | 131 ms | | | |

Notes above are IDMT (electric). On GuitarSet's acoustic notes (`--source guitarset
--by-note`) RPA is 88.6 % clean: the octave-up check's margin was raised from
0.02 to 0.05 after it was found pushing acoustic notes an octave down (G3 read
as G2 in 13 % of frames).

2026-10-17, gate hysteresis (new note 2× noise floor, tracked note 1.2× and
clarity 0.7): acoustic RPA 87.9 → 91.7 % clean, 84.0 → 91.0 % phone-mid; electric
phone-cheap 96.9 → 99.4 %; unplugged 24.9 → 29.1 %.

2026-10-17, field recording of an unplugged electric in a room with mains hum
(?debug recorder): hum's long periods were winning pitchy's period search. MPM
limited to guitar lags + two 70 Hz high-pass stages + new-note clarity 0.85: the A
string went from never read to 82 % of frames, no reading in silence; benchmark
acoustic 91.7 → 93.5 % clean, 91.0 → 92.6 % phone-mid; unplugged 29.1 → 41.5 %;
chords unchanged.

`unplugged` is a known physical limit: the low strings reach the mic below the
room noise. Tried and rejected (no gain or worse): pre-emphasis before MPM,
a looser noise margin (25 → 28 %, but more gate openings on noise), an 8192
window (worse, +35 ms). The fix is placement: the phone ~10 cm from the strings
instead of ~50 cm is ~+14 dB.
