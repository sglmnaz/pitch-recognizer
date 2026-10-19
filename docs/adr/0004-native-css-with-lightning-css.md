# 4. Native CSS + Lightning CSS instead of SCSS

## Status

Accepted, implemented: `css.transformer` / `build.cssMinify` are
`lightningcss`, targets from `browserslist` in package.json (iOS / Safari 16.2+,
the floor set by `color-mix()` with custom properties; current Chrome, Edge,
Firefox). The stylesheet is split under `ts/styles/main.css` into `@layer`ed
files with nesting.

## Context

`ts/styles/style.css` is ~4,000 lines of flat CSS. Nesting, mixins and partials
would make it easier to maintain, and SCSS is the usual answer. But:

- The themes switch at runtime (`data-theme` on `<html>`, and on the fretboard
  to force its own palette). Sass variables are resolved at compile time and
  cannot follow a runtime switch; only CSS custom properties can, so tokens must
  stay custom properties whatever the preprocessor.
- Native CSS nesting now covers the main reason to reach for Sass. Its relaxed
  syntax (nesting element selectors without `&`) needs Safari / iOS Safari
  17.2+; the PWA should keep working on older iPhones.
- Vite 5 drives Sass through its legacy JS API by default, which Dart Sass has
  deprecated (warnings now, removal in Dart Sass 2.0); opting into the modern
  API is per-project configuration, and Vite 6 changes the default.

## Decision

Write native CSS (nesting, custom properties, every rule inside `@layer tokens, base, components`: unlayered CSS would beat all layers) and let
Lightning CSS lower it for the browser targets, via Vite's
`css.transformer: 'lightningcss'` (and `build.cssMinify: 'lightningcss'`), with
targets from the app's browser support. No SCSS.

## Consequences

- No preprocessor dependency or Sass API migration; the source is the CSS the
  platform will eventually run unchanged.
- Older iOS Safari gets flattened selectors from Lightning CSS; the visual suite
  (ADR 0001) guards that the output renders identically.
- Vite marks its Lightning CSS integration experimental, and Lightning CSS does
  not support every PostCSS plugin (none are used today).
- Mixins and loops are not available; repeated patterns become shared classes
  or custom properties.

Sources: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_nesting,
https://caniuse.com/css-nesting, https://lightningcss.dev/transpilation.html,
https://vite.dev/guide/features#lightning-css,
https://sass-lang.com/documentation/variables/,
https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties,
https://sass-lang.com/documentation/breaking-changes/legacy-js-api/,
https://v5.vite.dev/config/shared-options#css-preprocessoroptions
