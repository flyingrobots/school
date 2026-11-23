// Zero custom CSS tokens. The app's tokens are stock shadcn's, with values from exactly one place:
// the @flyingrobots/theme registry item (theme-book colors). Anything else is custom and fails here.
//
// Oracles (change detection, captured from their sources; see test/fixtures/README.md):
//   stock-index.css         - shadcn CLI 4.23.0, `init -t vite -b radix -p nova`, src/index.css
//   flyingrobots-theme.json - the @flyingrobots/theme registry item as built
//   flyingrobots-markdown.json - the @flyingrobots/markdown registry item as built (its css @source)
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const web = join(import.meta.dir, "..");
const src = join(web, "src");
const stock = readFileSync(join(import.meta.dir, "fixtures", "stock-index.css"), "utf8");
const theme = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "flyingrobots-theme.json"), "utf8")) as {
  cssVars: { light: Record<string, string>; dark: Record<string, string> };
};
const index = readFileSync(join(src, "index.css"), "utf8");
const markdown = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "flyingrobots-markdown.json"), "utf8")) as {
  css: Record<string, unknown>;
};
/** The `@source` lines installed registry items declare. A source tells Tailwind where to find class names; it is not a token. */
const sources = Object.keys(markdown.css).filter((at) => at.startsWith("@source ")).map((at) => `${at};`);

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
  });
}

/** Every custom property declaration (`--name: value;`) in a stylesheet, in order. */
const declarations = (css: string) => [...css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({ name: m[1]!, value: m[2]!.trim() }));

/** The declarations directly inside a top-level block such as `:root {` or `.dark {`. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`));
  if (start === -1) return new Map();
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return new Map(declarations(css.slice(open + 1, close)).map((d) => [d.name, d.value]));
}

const stockNames = new Set(declarations(stock).map((d) => d.name));

test("every custom property in the app's stylesheets is a stock shadcn token", () => {
  const found = files(src, ".css").flatMap((f) => declarations(readFileSync(f, "utf8")).map((d) => `${relative(web, f)} ${d.name}`));
  const custom = found.filter((entry) => !stockNames.has(entry.split(" ")[1]!));
  console.log(`harvested ${found.length} custom property declarations; ${custom.length} not stock`);
  expect(found.length).toBeGreaterThan(0); // zero witnesses would mean the harvest read nothing
  expect(custom).toEqual([]);
});

test("index.css is the app's only stylesheet", () => {
  expect(files(src, ".css").map((f) => relative(src, f))).toEqual(["index.css"]);
});

test("index.css carries every @source a registry item declares, once", () => {
  expect(sources.length).toBeGreaterThan(0); // zero witnesses would mean the fixture read nothing
  for (const line of sources) expect(index.split("\n").filter((l) => l.trim() === line)).toEqual([line]);
});

test("index.css adds no rules: with token values and registry-declared @source lines removed it is the stock file", () => {
  const shape = (css: string) => css.replace(/(--[\w-]+)\s*:\s*[^;{}]+;/g, "$1: <value>;").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
  const declared = new Set(sources);
  const withoutSources = index.split("\n").filter((l) => !declared.has(l.trim())).join("\n");
  expect(shape(withoutSources)).toBe(shape(stock));
});

test.each([
  [":root", "light"],
  [".dark", "dark"],
] as const)("every %s token value is the registry theme's, or stock where the theme sets none", (selector, mode) => {
  const expected = new Map(block(stock, selector));
  for (const [name, value] of Object.entries(theme.cssVars[mode])) expected.set(`--${name}`, value);
  expect(Object.fromEntries(block(index, selector))).toEqual(Object.fromEntries(expected));
});
