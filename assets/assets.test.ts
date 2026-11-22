// The stylesheets are not covered by `theme-book audit`, which checks token pairs and has no
// idea these files exist. These tests cover the two ways that gap has already bitten:
//
//   1. a `var()` with nothing behind it fails silently — `font-family: var(--font-sans)` falls
//      back to the browser default and `border-radius: var(--radius)` does nothing;
//   2. a shadcn *surface* token used as a text or border colour renders near-invisible.
//      `.lbl { color: var(--muted) }` measured 1.05:1 against the surface behind it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const SHEETS = ["style.css", "item.css", "nest.css"] as const;

const defined = new Set([...read("tokens.css").matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

test("tokens.css defines the non-colour tokens, which theme-book does not emit", () => {
  for (const t of ["--font-sans", "--font-serif", "--font-mono", "--radius", "--shadow-sm"]) {
    expect(defined.has(t)).toBe(true);
  }
});

test.each([...SHEETS])("every var() in %s resolves to a defined token", (sheet) => {
  const used = new Set([...read(sheet).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
  expect([...used].filter((t) => !defined.has(t))).toEqual([]);
});

/**
 * Tokens that name *only* a surface. Text on them is `<name>-foreground`, never the surface.
 *
 * `--primary` and `--destructive` are deliberately absent: shadcn uses both ways — as a fill with
 * `-foreground` on top, and as accent text on a light surface. `.edge { color: var(--primary) }`
 * measures 7.51:1 here. A surface token as text is the error; a dual-use token is not.
 */
const SURFACES = ["--background", "--card", "--popover", "--muted", "--accent", "--secondary", "--input"];

test.each([...SHEETS])("%s never uses a surface token as a text colour", (sheet) => {
  const offenders: string[] = [];
  for (const m of read(sheet).matchAll(/(^|[;{\s])color:\s*var\((--[a-z0-9-]+)/g)) {
    const token = m[2]!;
    if (SURFACES.includes(token)) offenders.push(`color: var(${token})`);
  }
  expect(offenders).toEqual([]);
});
