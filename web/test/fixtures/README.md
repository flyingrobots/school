# Token oracles

Fixtures for `test/tokens.test.ts`. All are change-detection oracles, captured from their sources;
replace them only from those sources, never by hand.

`index.css` is the stock file with the theme's token values, plus the `@source` lines that
installed registry items declare in their `css` (written by `shadcn add`, never by hand). A
`@source` tells Tailwind which files to scan for class names; it declares no token and no rule.
The test permits exactly the `@source` lines in `flyingrobots-markdown.json`, requires each once,
and fails on any other addition.

| File | Captured from |
| --- | --- |
| `stock-index.css` | `shadcn init -t vite -b radix -p nova` with shadcn CLI 4.23.0, file `src/index.css`, unedited. |
| `flyingrobots-theme.json` | The `@flyingrobots/theme` registry item as built (`public/r/theme.json` in `flyingrobots/shadcn-registry`). |
| `flyingrobots-markdown.json` | The `@flyingrobots/markdown` registry item as built (`public/r/markdown.json` in `flyingrobots/shadcn-registry`, at 7045f91). |

`registry-examples.sha256` lists the SHA-256 of every `src/components/*-example.tsx` exactly as
`shadcn add @shadcn/<name>-example` wrote it (CLI 4.23.0, radix-nova style, 2026-11-22), installed
in a scratch copy of this app so no stock component was overwritten. The examples are the theme
sandbox's content (`src/demo/`); the hashes prove they are unedited. Each hash is of the file with
any leading `"use client"` removed, for the CLI defect described under
[Stock components](#stock-components). Regenerate only from a fresh CLI install, with the same
`perl` correction.

`quiz-example.tsx`, `explain-example.tsx` and `nest-example.tsx` are the exceptions: each is `shadcn
add @flyingrobots/<name>-example` from School's registry (`flyingrobots/shadcn-registry`),
installed the same way, and its hash is of that file.

## Stock components

`stock-components.sha256` lists the SHA-256 of every `src/components/ui/*.tsx`, read by
`test/stock-components.test.ts`. Each one is the file `shadcn add <name>` writes (CLI 4.23.0,
`components.json` as committed), with one correction described below. Bare names such as `button`
are not in the `@flyingrobots` registry; the CLI resolves them to the built-in `@shadcn` registry
at `https://ui.shadcn.com/r/styles/{style}/{name}.json`, here `styles/radix-nova/`
(`REGISTRY_URL` overrides the host).

The correction: `components.json` sets `rsc: false`, so the CLI's transform means to remove a
leading `"use client"` from every file it writes. In 4.23.0 that transform tests each file with
one shared regular expression carrying the `g` flag, so `RegExp.test` keeps its `lastIndex` from
the previous match and the directive is removed from only every other file in a run. Which files
keep it depends on install order, so each reinstall flipped the line in a different set of files.
The fixture records the files with the directive removed, which is what the transform intends, and
the test also refuses `"use client"` at the top of any file under `src/components/`.

Regenerate it only from a fresh install, in a scratch copy of `web/`, never in place:

```sh
cp -R web "$SCRATCH/web" && cd "$SCRATCH/web"
npx shadcn add $(command ls src/components/ui | sed 's/\.tsx$//') --overwrite -y
perl -0pi -e 's/\A"use client"\n\n//' src/components/ui/*.tsx
(cd src/components/ui && shasum -a 256 *.tsx) > "$OLDPWD/web/test/fixtures/stock-components.sha256"
```

A changed hash is then a real upstream change: review the diff of the file before committing the
new copy and its hash together. A new stock component (one a block pulls in) gets its line the
same way. After any `shadcn add`, remove the `"use client"` line the CLI may have left with the
same `perl` command.
