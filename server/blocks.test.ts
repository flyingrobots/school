// Load-time validation of a lesson set (RFC 1, "Block definitions"; flyingrobots/school#1).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockError, lastValidLoader, loadLibrary } from "./blocks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A lesson directory holding `files`, each value serialised as one lesson file. */
function lessons(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "school-blocks-"));
  dirs.push(dir);
  for (const [name, json] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(json));
  return dir;
}

const page = (id: string, children: unknown[]) => ({ type: "page", id, title: id, subtitle: "", children });
const section = (id: string, children: unknown[]) => ({ type: "section", id, title: id, children });
const quiz = (id: string, choices = [{ id: "a", text: "A", correct: false }, { id: "b", text: "B", correct: true }]) =>
  ({ type: "quiz", id, q: "Which?", choices, why: "Because." });

const loadError = (dir: string): string => {
  try {
    loadLibrary(dir);
  } catch (e) {
    if (e instanceof BlockError) return e.message;
    throw e;
  }
  throw new Error("expected a BlockError");
};

test("a quiz shared by two pages through ref loads, with its choice ids", () => {
  const dir = lessons({
    "0001.json": page("p1", [quiz("shared")]),
    "0002.json": page("p2", [{ ref: "shared" }]),
  });
  const { pages } = loadLibrary(dir);
  expect(pages.map((p) => p.id)).toEqual(["p1", "p2"]);
  const shared = pages[1]!.type === "page" ? pages[1]!.children[0] : undefined;
  expect(shared?.type === "quiz" ? shared.choices.map((c) => c.id) : []).toEqual(["a", "b"]);
});

test("a diamond (two parents ref one child) is not a cycle", () => {
  const dir = lessons({
    "0001.json": page("p1", [section("left", [quiz("leaf")]), section("right", [{ ref: "leaf" }])]),
  });
  expect(loadLibrary(dir).pages).toHaveLength(1);
});

test("a section that refs itself is rejected, naming the path", () => {
  const dir = lessons({ "0001.json": page("p1", [section("a", [{ ref: "a" }])]) });
  expect(loadError(dir)).toContain("a > a");
});

test("an indirect cycle across two files is rejected, naming the path", () => {
  const dir = lessons({
    "0001.json": page("p1", [section("a", [{ ref: "b" }])]),
    "0002.json": page("p2", [section("b", [{ ref: "a" }])]),
  });
  expect(loadError(dir)).toMatch(/cycle: (a > b > a|b > a > b)/);
});

test("a block id under school: is School's own, for what it adds to a lesson (its Review section), and is rejected", () => {
  for (const id of ["school:review", "school:x"]) {
    expect(loadError(lessons({ "0001.json": page("p1", [section(id, [quiz("q")])]) }))).toContain(`"${id}"`);
  }
  expect(() => loadLibrary(lessons({ "0001.json": page("p1", [section("schoolwork", [quiz("q")])]) }))).not.toThrow();
});

test("a choice without an id is rejected", () => {
  const dir = lessons({ "0001.json": page("p1", [quiz("q", [{ text: "A", correct: true } as never])]) });
  expect(loadError(dir)).toContain("q");
});

test("an empty choice id is rejected", () => {
  const dir = lessons({ "0001.json": page("p1", [quiz("q", [{ id: "", text: "A", correct: true }])]) });
  expect(loadError(dir)).toContain("choice id");
});

test("two choices with the same id are rejected", () => {
  const dir = lessons({
    "0001.json": page("p1", [quiz("q", [{ id: "a", text: "A", correct: false }, { id: "a", text: "B", correct: true }])]),
  });
  expect(loadError(dir)).toContain('duplicate choice id "a"');
});

test("after a valid load, a corrupted lesson set still serves the earlier lessons and reports the error", () => {
  const dir = lessons({ "0001.json": page("p1", [quiz("q")]) });
  const load = lastValidLoader();
  const first = load(dir);
  expect(first.error).toBeNull();
  expect(first.library?.pages.map((p) => p.id)).toEqual(["p1"]);

  writeFileSync(join(dir, "0001.json"), "{ not json");
  const second = load(dir);
  expect(second.library?.pages.map((p) => p.id)).toEqual(["p1"]);
  expect(second.error).toBeInstanceOf(BlockError);

  // The error is reported on every failing reload, not just the first.
  expect(load(dir).error).toBeInstanceOf(BlockError);
});

test("with no earlier valid set, a broken lesson set yields no library and the error", () => {
  const dir = lessons({ "0001.json": page("p1", [section("a", [{ ref: "a" }])]) });
  const result = lastValidLoader()(dir);
  expect(result.library).toBeNull();
  expect(result.error).toBeInstanceOf(BlockError);
});

// A lesson's hook: the question it answers, a teaser and an optional figure (flyingrobots/school#164).
test("a lesson may declare a hook, and it loads with the page", () => {
  const hook = { question: "Why do bells ring patterns?", teaser: "Physics decides.", figure: "<svg></svg>" };
  const lib = loadLibrary(lessons({ "0001.json": { ...page("l", [quiz("q")]), hook } }));
  expect(lib.pages[0]).toMatchObject({ type: "page", id: "l", hook });
  const plain = loadLibrary(lessons({ "0001.json": { ...page("l", [quiz("q")]), hook: { question: "Q?", teaser: "T." } } }));
  expect(plain.pages[0]).toMatchObject({ hook: { question: "Q?", teaser: "T." } });
  expect("figure" in (plain.pages[0] as { hook: object }).hook).toBe(false);
  expect("hook" in loadLibrary(lessons({ "0001.json": page("l", [quiz("q")]) })).pages[0]!).toBe(false);
});

test("a hook without its question or teaser, or with a figure that isn't text, is rejected, naming the lesson", () => {
  expect(loadError(lessons({ "0001.json": { ...page("l", []), hook: { teaser: "T." } } }))).toContain('"question"');
  expect(loadError(lessons({ "0001.json": { ...page("l", []), hook: { question: "Q?" } } }))).toContain('"teaser"');
  expect(loadError(lessons({ "0001.json": { ...page("l", []), hook: { question: "Q?", teaser: "T.", figure: 3 } } }))).toContain('"figure"');
  expect(loadError(lessons({ "0001.json": { ...page("l", []), hook: "Q?" } }))).toContain("hook");
  expect(loadError(lessons({ "0001.json": { ...page("l", []), hook: { teaser: "T." } } }))).toContain("l");
});
