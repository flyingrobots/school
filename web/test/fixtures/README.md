# Token oracles

Fixtures for `test/tokens.test.ts`. Both are change-detection oracles, captured from their sources;
replace them only from those sources, never by hand.

| File | Captured from |
| --- | --- |
| `stock-index.css` | `shadcn init -t vite -b radix -p nova` with shadcn CLI 4.23.0, file `src/index.css`, unedited. |
| `flyingrobots-theme.json` | The `@flyingrobots/theme` registry item as built (`public/r/theme.json` in `flyingrobots/shadcn-registry`). |
