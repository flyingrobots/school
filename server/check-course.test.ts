// `school check` (flyingrobots/school#197), run as a process on course folders the tests write:
// every line it prints validates against its published schema (server/schemas/check/).
// docs/topics/course-format/test-plan.md lists these cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishedIn, type Line } from "./testing/schemas.ts";

const CHECK = join(import.meta.dir, "check-course.ts");
const schemas = publishedIn(join(import.meta.dir, "schemas", "check"));
const root = mkdtempSync(join(tmpdir(), "school-check-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", CHECK, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}
/** Every line on both streams, each validated against its schema. */
const lines = (r: { stdout: string; stderr: string }) => ({ out: schemas.validated(r.stdout), err: schemas.validated(r.stderr) });

const quiz = (id: string, correct = [true, false]) => ({ type: "quiz", id, q: "Which?", why: "Because.",
  choices: correct.map((c, i) => ({ id: `c${i}`, text: `Choice ${i}`, correct: c })) });
const page = (id: string, children: unknown[]) => ({ type: "page", id, title: `Lesson ${id}`, subtitle: "", children });

let n = 0;
/** A course folder: `course` is course.json's text (none when undefined), `lessons` file name to JSON value or raw text. */
function course(o: { course?: string; lessons?: Record<string, unknown> }) {
  const dir = join(root, `c${++n}`);
  mkdirSync(join(dir, "lessons"), { recursive: true });
  if (o.course !== undefined) writeFileSync(join(dir, "course.json"), o.course);
  for (const [file, v] of Object.entries(o.lessons ?? {})) writeFileSync(join(dir, "lessons", file), typeof v === "string" ? v : JSON.stringify(v));
  return dir;
}

describe("school check", () => {
  test("CHECK-1: a valid course exits 0 with what School would serve", async () => {
    const dir = course({ course: JSON.stringify({ title: "Bells" }), lessons: {
      "0001-a.json": page("a", [quiz("a-q1"), { type: "explain", id: "a-e1", prompt: "Why?", model: "So." }]),
      "0002-b.json": page("b", [quiz("b-q1"), { ref: "a-q1" }]),
    } });
    const r = await run([dir]);
    expect(r.code).toBe(0);
    const { out, err } = lines(r);
    expect(err).toEqual([]);
    expect(out.map((l) => l._schema.id)).toEqual(["school.check.start", "school.check.done"]);
    expect(out[0]).toMatchObject({ folder: dir });
    expect(out[1]).toMatchObject({ ok: true, folder: dir, title: "Bells", quizzes: 2, explains: 1, lessons: [
      { file: "0001-a.json", id: "a", title: "Lesson a", quizzes: 1, explains: 1 },
      { file: "0002-b.json", id: "b", title: "Lesson b", quizzes: 2, explains: 0 },
    ] });
  });

  test("CHECK-2: a folder with no lessons and no course.json is a valid, empty course", async () => {
    const r = await run([course({})]);
    expect(r.code).toBe(0);
    expect(lines(r).out.at(-1)).toMatchObject({ title: null, summary: null, author: null, license: null, format: null, lessons: [], quizzes: 0, explains: 0 });
  });

  const invalid: [string, Parameters<typeof course>[0], string | null, string][] = [
    ["a malformed course.json", { course: "{ nope" }, "course.json", "not valid JSON"],
    ["a course.json with an unknown key", { course: JSON.stringify({ title: "T", colour: "red" }) }, "course.json", "not a course file"],
    ["a course.json with a whitespace-only summary", { course: JSON.stringify({ title: "T", summary: "  " }) }, "course.json", '"summary"'],
    ["a course.json whose author is not a string", { course: JSON.stringify({ title: "T", author: 7 }) }, "course.json", '"author"'],
    ["a course.json with an unknown SPDX id", { course: JSON.stringify({ title: "T", license: "Frobnicate-1.0" }) }, "course.json", "Frobnicate-1.0"],
    ["a course.json in format 2", { course: JSON.stringify({ title: "T", format: 2 }) }, "course.json", '"format" is 2'],
    ["a lesson that is not JSON", { lessons: { "0001.json": "{" } }, "0001.json", "invalid JSON"],
    ["a duplicate block id", { lessons: { "0001.json": page("a", [quiz("q")]), "0002.json": page("b", [quiz("q")]) } }, "0002.json", "duplicate block id"],
    ["two correct choices", { lessons: { "0001.json": page("a", [quiz("q", [true, true])]) } }, "0001.json", "exactly one choice must be correct"],
    ["an unknown block type", { lessons: { "0001.json": page("a", [{ type: "video", id: "v" }]) } }, "0001.json", 'unknown block type "video"'],
    ["an unknown ref", { lessons: { "0001.json": page("a", [{ ref: "nowhere" }]) } }, null, 'unknown ref "nowhere"'],
  ];
  test.each(invalid)("CHECK-3: %s exits 1, naming the file and the rule", async (_, o, file, rule) => {
    const r = await run([course(o)]);
    expect(r.code).toBe(1);
    const { out, err } = lines(r);
    expect(out.map((l) => l._schema.id)).toEqual(["school.check.start"]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({ _schema: { id: "school.check.error.invalid" }, error: "invalid", code: 1, file });
    expect(String(err[0]!.message)).toContain(rule);
  });

  test.each([[[] as string[]], [["/no/such/course"]], [["a", "b"]], [["--frobnicate"]]])("CHECK-4: %j is a usage error, exit 2, checking nothing", async (args) => {
    const r = await run(args);
    expect(r.code).toBe(2);
    const { out, err } = lines(r);
    expect(out).toEqual([]);
    expect(err.map((l) => l._schema.id)).toEqual(["school.check.error.usage"]);
  });

  test("CHECK-5: --help describes the command, then prints every schema; --schema prints them alone", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    const h = lines(help).out;
    expect(h[0]).toMatchObject({ _schema: { id: "school.check.help" }, command: "check" });
    expect((h[0] as Line & { output: string[] }).output.sort()).toEqual([...schemas.ids].sort());
    expect(h.slice(1).map((l) => l.id).sort()).toEqual([...schemas.ids].sort());
    const s = await run(["--schema"]);
    expect(s.code).toBe(0);
    expect(lines(s).out.map((l) => l.id).sort()).toEqual([...schemas.ids].sort());
  });

  const manifest = { title: "Bells", summary: " Ring the changes. ", author: "A Ringer", license: "MIT OR Apache-2.0", format: 1 };

  test("CHECK-8: a course's summary, author, license and format are on the done line, trimmed", async () => {
    const r = await run([course({ course: JSON.stringify(manifest), lessons: { "0001.json": page("a", [quiz("q")]) } })]);
    expect(r.code).toBe(0);
    expect(lines(r).out.at(-1)).toMatchObject({ title: "Bells", summary: "Ring the changes.", author: "A Ringer", license: "MIT OR Apache-2.0", format: 1 });
  });

  test("CHECK-9: --human names the course's author, license and format", async () => {
    const r = await run(["--human", course({ course: JSON.stringify(manifest), lessons: { "0001.json": page("a", [quiz("q")]) } })]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Ring the changes.");
    expect(r.stdout).toContain("A Ringer");
    expect(r.stdout).toContain("MIT OR Apache-2.0");
    expect(r.stdout).toContain("format 1");
  });

  test("CHECK-6: --human prints prose, not JSON", async () => {
    const r = await run(["--human", course({ course: JSON.stringify({ title: "Bells" }), lessons: { "0001.json": page("a", [quiz("q")]) } })]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("{");
    expect(r.stdout).toContain("Bells");
    expect(r.stdout).toContain("1 lesson");
  });
});
