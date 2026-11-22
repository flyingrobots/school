# Token oracles

Fixtures for `test/tokens.test.ts`. Both are change-detection oracles, captured from their sources;
replace them only from those sources, never by hand.

| File | Captured from |
| --- | --- |
| `stock-index.css` | `shadcn init -t vite -b radix -p nova` with shadcn CLI 4.23.0, file `src/index.css`, unedited. |
| `flyingrobots-theme.json` | The `@flyingrobots/theme` registry item as built (`public/r/theme.json` in `flyingrobots/shadcn-registry`). |

`registry-examples.sha256` lists the SHA-256 of every `src/components/*-example.tsx` exactly as
`shadcn add @shadcn/<name>-example` wrote it (CLI 4.23.0, radix-nova style, 2026-11-22), installed
in a scratch copy of this app so no stock component was overwritten. The examples are the theme
sandbox's content (`src/demo/`); the hashes prove they are unedited. Regenerate only from a fresh
CLI install.

`quiz-example.tsx`, `explain-example.tsx` and `nest-example.tsx` are the exceptions: each is `shadcn
add @flyingrobots/<name>-example` from School's registry (`flyingrobots/shadcn-registry`),
installed the same way, and its hash is of that file.
