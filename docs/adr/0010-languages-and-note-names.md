# 10. Languages and note names: English text as the key, no library

## Status

Accepted

## Context

Pluck was English only and named notes in letters. Italian players read Do Re
Mi, and the app should speak Italian too, with more languages possible later.
The two choices are independent: an Italian UI with letters, or an English UI
with Do Re Mi, must both work. All markup lives in `index.html` (~330 strings,
plus ~1,000 words of Guide); the views build ~500 more strings in TS. The
visual tests must stay at 0 diffs in English. The project has one dependency
and no framework.

i18n libraries were weighed (research notes, 2026-10-21): i18next core is
~14 KB gzip and leaves re-rendering to us without a framework; Lingui needs a
compile step; typesafe-i18n is in minimal maintenance; FormatJS brings full
ICU we do not need for English and Italian. `Intl.PluralRules` and
`Intl.NumberFormat` cover plurals and numbers natively.

## Decision

- **Note names** (`ts/music/note-names.ts`): four systems, the set MuseScore
  offers: letters, Do Re Mi (Italian, Spanish…), French (Ré) and German (H for
  B natural, B for B flat). Everything inside the app stays in letters (ids,
  stored settings, records, VexFlow keys, logs, the Node checks); only what is
  shown goes through `noteName()` / `spokenName()`, which keep the accidental
  style they are given. Chord symbols are the formatted root plus the
  unchanged suffix (`Lam7`); octaves keep the scientific number (`Do4`).
- **UI text** (`ts/core/i18n.ts`): gettext style. The English text is the key:
  `t('Match this note')`, `t('Find {note}', { note })`, `plural(n, '{n} change',
  '{n} changes')`; `context|English` where one English word means two things
  (`tuner|Chromatic`, `knob|None`). A missing translation shows English, never
  a key. Dictionaries are plain TS objects, `ts/i18n/<lang>.ts`.
- **index.html stays English**; `ts/ui/translate.ts` translates its text nodes
  and readable attributes at boot, a block mixing text and inline markup as
  one sentence (its inner HTML), text under `data-i18n="ctx"` as `ctx|text`
  first. The Guide is written per language (`<template id="help-tuner-it">`).
- **Boot** (`ts/language.ts`, the first import of `main.ts`): settings
  `language` (auto = the device's first supported language, else English) and
  `noteNames` (auto = Do Re Mi in Italian, letters otherwise) are applied
  before any view is built; a change of either reloads the app. The head
  script sets `<html lang>` and hides the page until translated, so English
  never flashes.
- Pure modules call `t()` at call time, never at module level: `settings.ts`
  evaluates some of them before the language is set.
- Both dictionaries are bundled (a few KB); split per language only when there
  are several (the service worker precaches every chunk anyway).

## Consequences

- English needs no dictionary, and its DOM is untouched: the English visual
  baselines stay as they were.
- `npm run check:i18n` finds every literal `t()` / `plural()` key and the
  table names views translate (chord and scale types, progressions,
  intervals, tunings) and fails on a missing Italian entry or a lost
  placeholder. `tests/visual/i18n.spec.ts` (Italian projects only) opens every
  screen in English and Italian and fails on any text left the same, unless
  the dictionary says it stays (an entry equal to its English).
- Changing an English sentence silently drops its translation until the
  dictionary follows; the two checks above catch it. The Italian Guide pages
  are not checked against the English ones: edit both.
- Another language is a dictionary, Guide templates, a `LANGUAGES` entry and
  the head script's list. Languages with more plural forms add `few` / `many`
  to their entries; full ICU (`intl-messageformat`) can go behind `t()` later.
