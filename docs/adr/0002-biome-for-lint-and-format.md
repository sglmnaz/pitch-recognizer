# 2. Biome for lint and format

## Status

Accepted

## Context

The house style (tabs, single quotes, no semicolons) was kept by hand, with no
formatter and no linter. ESLint + Prettier would add two tools, several plugins
and two config files to a project whose only runtime dependency is VexFlow.

## Decision

Biome 2 (`@biomejs/biome`, pinned) formats and lints `ts/`, `scripts/`, `tests/`
and the root configs; the generated `chord-model.ts` and `package-lock.json` are
excluded. `npm run format` writes, `npm run lint` reports.

- Formatter: `indentStyle: tab`, `quoteStyle: single` (JS and CSS),
  `semicolons: asNeeded`, `trailingCommas: es5` (smaller diff than `all` on this
  code). `lineWidth: 160`, measured: 120 changed 1481+/406− lines, 140 936+/291−,
  160 697+/276− (180 would be smaller still, but lines that long stop being
  readable side by side). Organize imports is off: it would reorder imports in
  most files for no behavioural gain.
- Linter: the recommended preset, with these exceptions:
  - `style/noNonNullAssertion` off: 124 hits, the code asserts DOM lookups it owns
    (`index.html` is the contract); rewriting them is churn, not safety.
  - `style/noDescendingSpecificity` off: 36 hits; reordering CSS rules changes the
    cascade, i.e. the rendering.
  - `suspicious/useIterableCallbackReturn` off: 32 concise `forEach((b) => b.x())`
    arrows, house style; the returned value is ignored by `forEach`.
  - `suspicious/noDuplicateProperties` off: flags deliberate fallbacks such as
    `min-height: 100vh; min-height: 100dvh`.
  - `suspicious/noAssignInExpressions` warn: seeded noise generators and
    `cache.set(key, (value = make()))` idioms (8).
  - `complexity/noCommaOperator` warn: test stubs in the check scripts (3).
  - `complexity/noImportantStyles` warn: two `!important` overrides in
    `style.css`; removing them changes the rendering (2).

The formatting landed in its own commit (pure formatting, verified by the
visual suite and the checks); behaviour-neutral lint fixes in another.

## Consequences

- One dev dependency, one `biome.json`; formatting and lint run in well under a
  second.
- 13 warnings remain on purpose (listed above); new code should not add to them.
- Biome formats CSS too, so the native-CSS work (ADR 0004) starts formatted.
- Editors without the Biome extension will not format on save.

Sources: https://biomejs.dev/reference/configuration/,
https://biomejs.dev/formatter/, https://biomejs.dev/linter/rules/
