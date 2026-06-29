# Pitch Recognizer

An ear-training and tuning web app: it listens through your microphone and detects
the pitch you sing or play. It has two modes:

- **Trainer** — a guessing game. A note is shown on the staff; match it by ear to
  build your score and streak.
- **Tuner** — a continuous chromatic tuner showing the nearest note, its frequency,
  and how many cents sharp or flat you are.

Built with **TypeScript**, [**pitchy**](https://github.com/ianprime0509/pitchy) for
pitch detection, [**VexFlow**](https://www.vexflow.com/) for music notation, styled
in [**Vercel Geist**](https://vercel.com/geist) (light & dark), and bundled with
[**Vite**](https://vitejs.dev/).

## How to use

1. Press **Listen** and allow microphone access.
2. Switch between **Trainer** and **Tuner** with the tabs in the header. Toggle the
   theme with the button on the right.

**Trainer:** a note appears on the staff (with its English and Italian solfège
names). Sing or play it; the readout shows the note you are producing and how far
off you are. Hold the correct note in tune for a moment to win the round and bump
your score and streak. **Skip** passes on a note.

Open the **settings** menu (gear icon) to:

- **Match any octave** — accept the right note in any octave, not just the one
  drawn (handy when the target sits outside your range).
- **Sharps & flats** — add accidentals to the note pool.
- **Light staff** — keep the staff on a light background even in dark mode.
- **Target notes** — enable or disable individual notes so you only train the ones
  you want (with All / None shortcuts). Settings are saved between sessions.

**Tuner:** play any note. The readout shows the nearest note, frequency in Hz, and
cents deviation. The meter has a green centre zone (in tune) flanked by yellow
(close); the readout locks green when you are within 5 cents.

## Install (PWA)

The app is a Progressive Web App: on a deployed (HTTPS) instance you can install it
to your home screen. On Android Chrome use the install prompt or *Add to Home
screen*; on iOS Safari use *Share → Add to Home Screen*. Once installed it launches
standalone and works offline.

## Getting started

Requires [Node.js](https://nodejs.org/) 18+.

```sh
# Install dependencies
npm install

# Start the dev server (opens http://localhost:5173 with hot reload)
npm run dev

# Type-check and build for production into dist/
npm run build

# Preview the production build locally
npm run preview
```

## Deploy to Vercel

The repo is Vercel-ready ([vercel.json](vercel.json) pins the Vite preset, build
command, and `dist` output, and sets no-cache headers on the service worker and
manifest so updates land immediately).

- **Dashboard:** import the GitHub repo at [vercel.com/new](https://vercel.com/new);
  the defaults are detected automatically. No environment variables are needed.
- **CLI:** `npm i -g vercel && vercel` (then `vercel --prod`).

Vercel serves over HTTPS, which the microphone and the PWA install/service worker
require.

> The microphone only works on a secure origin. `localhost` (the dev server and
> preview) counts as secure; if you deploy the contents of `dist/`, serve them
> over HTTPS.

## Project structure

```
index.html              App shell; loads ts/index.ts as a module
vite.config.ts          Vite configuration
tsconfig.json           TypeScript configuration (type-check only)
PRODUCT.md / DESIGN.md  Product and design-system context
ts/
  index.ts              App shell: theme, tab routing, settings popover, mic lifecycle
  microphone.ts         Web Audio capture + pitch detection
  game.ts               Round logic, scoring, sustain detection
  settings.ts           Persisted settings + active note pool
  music-renderer.ts     Renders the target note with VexFlow
  notes.ts              Note/frequency table and helpers
  tokens.css            Geist design tokens (light + dark)
  style.css             Layout and component styles
  fonts/                Self-hosted Geist Sans + Geist Mono
  views/
    view.ts             Shared View interface
    trainer.ts          Trainer (guessing game) view
    tuner.ts            Tuner view
    settings-panel.ts   Settings popover (switches + note chips)
```

## How pitch detection works

`microphone.ts` captures audio with the Web Audio API and analyses each frame with
pitchy's autocorrelation detector. A reading is only accepted when it is both loud
enough (RMS above a floor) and confident enough (pitchy **clarity** ≥ 0.9, which
rejects noise and unvoiced sounds). Accepted frequencies are median-smoothed over a
short window to absorb the occasional octave jump.

## License

MIT
