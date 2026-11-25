// The block reference's examples (flyingrobots/school#196): every complete `json` example on
// docs/topics/course-format/blocks.md loads through School's own loader, and between them they
// show every block type and a `ref`, so the page cannot drift from server/blocks.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLibrary } from "./blocks.ts";

const PAGE = join(import.meta.dir, "..", "docs", "topics", "course-format", "blocks.md");
const TYPES = ["page", "section", "prose", "card", "quote", "aside", "quiz", "explain", "nest"];

const examples = [...readFileSync(PAGE, "utf8").matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
const root = mkdtempSync(join(tmpdir(), "school-block-reference-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every `type` and whether a `ref` appears anywhere in the example. */
function walk(v: unknown, seen: { types: Set<string>; ref: boolean }) {
  if (Array.isArray(v)) for (const x of v) walk(x, seen);
  if (!isObj(v)) return;
  if (typeof v.type === "string") seen.types.add(v.type);
  if (typeof v.ref === "string") seen.ref = true;
  for (const x of Object.values(v)) walk(x, seen);
}

describe("the block reference", () => {
  test("has examples", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  test.each(examples.map((e, i) => [i + 1, e] as const))("example %d loads through loadLibrary", (i, text) => {
    const block: unknown = JSON.parse(text);
    // A block that is not a page is shown on its own; a lesson file's root must be a page, so wrap it.
    const page = isObj(block) && block.type === "page" ? block : { type: "page", id: `wrap-${i}`, title: "Example", subtitle: "", children: [block] };
    const dir = join(root, `example-${i}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "0001.json"), JSON.stringify(page));
    expect(() => loadLibrary(dir)).not.toThrow();
  });

  test("shows every block type and a ref", () => {
    const seen = { types: new Set<string>(), ref: false };
    for (const e of examples) walk(JSON.parse(e), seen);
    expect(TYPES.filter((t) => !seen.types.has(t))).toEqual([]);
    expect(seen.ref).toBe(true);
  });
});
