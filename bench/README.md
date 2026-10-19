# Benchmark

`npm run bench` runs the app's own note and chord detection (`processFrame` from
`ts/microphone.ts`, `trackChord` from `ts/chords.ts`) over labelled guitar
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

2026-10-18, tune/test split introduced (constants are tuned on `--split tune`,
numbers reported on the test split). Spectral subtraction of the room noise
inside the autocorrelation, test split: clean 98.4 → 98.5 %, phone-mid 98.5 →
98.8 %, phone-cheap 95.8 → 97.1 %, unplugged 19.3 → 33.1 % (first reading 129 →
85 ms). Field recording: G3 19 → 84 %, E4 41 → 67 %, D3 35 → 61 %, E2 0 → 30 %,
no reading in silence. Tried and rejected: minimum-statistics noise tracking
(erases long-held notes); learning noise from every quiet frame (learns note
tails, −2 points clean).

`unplugged` is a known physical limit: the low strings reach the mic below the
room noise. Tried and rejected (no gain or worse): pre-emphasis before MPM,
a looser noise margin (25 → 28 %, but more gate openings on noise), an 8192
window (worse, +35 ms). The fix is placement: the phone ~10 cm from the strings
instead of ~50 cm is ~+14 dB.

## 2026-10-19: learned chord recognizer

`ts/chords.ts` no longer matches templates against a hand-made chroma. Per
analyser frame (16384-point spectrum, unchanged): log-frequency spectrum at 3
bins per semitone on the A4 reference → harmonic stacking (sub-harmonics 1/5–1/2
and harmonics 1–7, as Basic Pitch's HCQT: Bittner et al., ICASSP 2022) → three
convolutions along pitch, shared at every pitch → a salience per semitone C2–B6
(learned approximate transcription, the role of NNLS chroma — Mauch & Dixon,
ISMIR 2010 — and of the deep chroma extractor — Korzeniowski & Widmer, ISMIR
2016) → chroma + bass chroma + pooled features, rotated to each root and scored
by one MLP shared by all 12 roots → softmax over 12 × 8 types + "no chord" →
HMM forward filtering with a uniform switch rate (no lag; Cho & Bello, IEEE/ACM
TASLP 2014: enforcing continuity is what matters). 10.7k parameters, weights in
`ts/chord-model.ts` (~100 KB), ~0.6 ms per frame in Node.

Training (tune split only — test-split audio is never read):

```
node scripts/chord-data.ts --out <dir>              # GuitarSet 00-01 + IDMT "fast", 5 conditions
node scripts/chord-data.ts --out <dir> --synth 160  # synthetic strums, every chord type equally often
python scripts/chord-train.py --data <dir> --synth --labels perf          # -> ts/chord-model.ts
python scripts/chord-train.py --data <dir> --synth --labels perf --val    # hold out GuitarSet 01 + half of IDMT
```

Targets: chord class per frame (GuitarSet's performed annotation, IDMT's
labels; single-note solo frames and silence = "no chord") plus the notes
sounding (GuitarSet per-string annotations, exact for synthetic takes). The HMM
switch rate, evidence power, "no chord" offset and type offsets were chosen on
the held-out part of the tune split (`--val`), never on the test split. The
type offsets (9: −1.75, maj7: −1 log-odds) undo the synthetic takes' flat
type prior: they move held-out scores by < 1 point and keep the check's
dominant-7th voicings from reading as 9ths (`check:chords`: soft 45/45, bright
43/45, single notes, silence, noise and A4 = 432 / 466 Hz all pass).

Test split, default subset (120 items), before → after:

| | root | majmin | sevenths | latency |
|---|---|---|---|---|
| clean | 67.5 → **77.5 %** | 59.9 → **74.0 %** | 46.0 → **62.6 %** | 283 → 283 ms |
| phone-good | 67.7 → **79.3 %** | 60.9 → **75.6 %** | 46.5 → **63.9 %** | 282 → 281 ms |
| phone-mid | 68.1 → **79.1 %** | 61.1 → **75.2 %** | 47.0 → **63.3 %** | 282 → 282 ms |
| phone-cheap | 67.1 → **75.7 %** | 60.2 → **72.1 %** | 45.3 → **61.0 %** | 281 → 284 ms |
| unplugged | 31.3 → **55.2 %** | 24.9 → **52.4 %** | 9.0 → **46.8 %** | 429 → 372 ms |

Overfitting: on the tune split it was trained on it scores 87.4 / 84.5 / 75.7 %
(clean), against 77.5 / 74.0 / 62.6 % on test: a 10–13 point gap, which is why
only test numbers are reported. The held-out validation inside the tune split
(model trained without GuitarSet player 01 and half the IDMT progressions)
gave 86 / 80 / 74 % on GuitarSet and 72 / 72 / 66 % on IDMT. The most frequent
remaining error is "no chord" during a chord (soft strums, single bass notes in
bossa / fingerpicked comping). The app's display confirmation went from
250 ms to 100 ms, because the HMM now does the smoothing, so a change shows
~150 ms sooner than the latency column suggests.

Tried and rejected (held-out validation unless noted):
- **GuitarSet's instructed labels** instead of the performed ones: +2.5 points on
  GuitarSet, −3 sevenths on IDMT, and it teaches that a played maj7 is "maj",
  against the synthetic data and the check's voicings. Kept the performed ones.
- **No synthetic takes**: the model learns the recordings' prior and drops colour
  notes (an early real-data-only model: 26/45 on the check's soft suite).
- **Basic Pitch's single sub-harmonic (1/2)**: 1–2 points lower on GuitarSet,
  and overtones of the fifth read as played 9ths (check: 41–44/45 soft).
- **Bigger model** (24 channels, 48 hidden; or 20 epochs): no gain. **Note-loss
  weight 3**: −1 to −3 points.
- **"≥ 3 notes" gate** on the learned chroma (as the old MIN_NOTES): −11 points
  root, single-note rejection 94 → 98 %. Synthetic ringing single notes
  labelled "no chord" fixed the check's single notes instead.
- **HMM without the "no chord" offset**: smoothing let "no chord" win whenever it
  was a steady second best (unplugged 26 → 15 % root); the offset of 1.5 keeps
  single-note rejection at the unsmoothed level (94 %) while gaining ~15 points
  root on GuitarSet.
  Higher self-transition (0.8–0.95 per 100 ms) or tempered evidence (power 0.5)
  cost a frame of latency for nothing.
