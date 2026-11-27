// `school check` (flyingrobots/school#197), run as a process on course folders the tests write:
// every line it prints validates against its published schema (server/schemas/check/).
// docs/topics/course-format/test-plan.md lists these cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
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
    expect(out.map((l) => l._schema.id)).toEqual(["school.check.start", "school.check.manifest", "school.check.done"]);
    expect(out[0]).toMatchObject({ folder: dir });
    expect(out[2]).toMatchObject({ ok: true, folder: dir, title: "Bells", quizzes: 2, explains: 1, lessons: [
      { file: "0001-a.json", id: "a", title: "Lesson a", quizzes: 1, explains: 1 },
      { file: "0002-b.json", id: "b", title: "Lesson b", quizzes: 2, explains: 0 },
    ] });
  });

  test("CHECK-2: a folder with no lessons and no course.json is a valid, empty course", async () => {
    const r = await run([course({})]);
    expect(r.code).toBe(0);
    const { out } = lines(r);
    expect(out.at(-2)).toMatchObject({ event: "manifest", summary: null, author: null, license: null, format: null });
    expect(out.at(-1)).toMatchObject({ title: null, lessons: [], quizzes: 0, explains: 0 });
  });

  const invalid: [string, Parameters<typeof course>[0], string | null, string][] = [
    ["a malformed course.json", { course: "{ nope" }, "course.json", "not valid JSON"],
    ["a course.json with an unknown key", { course: JSON.stringify({ title: "T", colour: "red" }) }, "course.json", "not a course file"],
    ["a course.json with a whitespace-only summary", { course: JSON.stringify({ title: "T", summary: "  " }) }, "course.json", '"summary"'],
    ["a course.json whose author is not a string", { course: JSON.stringify({ title: "T", author: 7 }) }, "course.json", '"author"'],
    ["a course.json with an unknown SPDX id", { course: JSON.stringify({ title: "T", license: "Frobnicate-1.0" }) }, "course.json", "Frobnicate-1.0"],
    ["a course.json with an unknown exception after WITH", { course: JSON.stringify({ title: "T", license: "MIT WITH Frobnicate-exception" }) }, "course.json", "Frobnicate-exception"],
    ["a course.json with a LicenseRef after WITH", { course: JSON.stringify({ title: "T", license: "MIT WITH LicenseRef-x" }) }, "course.json", "LicenseRef-x"],
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

  test("CHECK-8: a course's summary, author, license and format are on the manifest line, trimmed", async () => {
    const r = await run([course({ course: JSON.stringify(manifest), lessons: { "0001.json": page("a", [quiz("q")]) } })]);
    expect(r.code).toBe(0);
    const { out } = lines(r);
    expect(out.map((l) => l._schema.id)).toEqual(["school.check.start", "school.check.manifest", "school.check.done"]);
    expect(out[1]).toMatchObject({ _schema: { id: "school.check.manifest", version: "1.0.0" }, kind: "school.check", event: "manifest",
      summary: "Ring the changes.", author: "A Ringer", license: "MIT OR Apache-2.0", format: 1 });
  });

  test("CHECK-10: the done line is still school.check.done 1.0.0, valid against the schema main published, and carries no manifest key", async () => {
    const r = await run([course({ course: JSON.stringify(manifest), lessons: { "0001.json": page("a", [quiz("q")]) } })]);
    const done = lines(r).out.at(-1)!;
    expect(done._schema).toEqual({ id: "school.check.done", version: "1.0.0" });
    const main = JSON.parse(readFileSync(join(import.meta.dir, "testing", "fixtures", "school.check.done.1.0.0.schema.json"), "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(main);
    expect(validate(done), JSON.stringify(validate.errors)).toBe(true);
    for (const k of ["summary", "author", "license", "format"]) expect(done).not.toHaveProperty(k);
    expect(JSON.stringify(schemas.published.find((p) => p.id === "school.check.done")!.schema)).toBe(JSON.stringify(main));
  });

  test("CHECK-9: --human names the course's author, license and format", async () => {
    const r = await run(["--human", course({ course: JSON.stringify(manifest), lessons: { "0001.json": page("a", [quiz("q")]) } })]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Ring the changes.");
    expect(r.stdout).toContain("A Ringer");
    expect(r.stdout).toContain("MIT OR Apache-2.0");
    expect(r.stdout).toContain("format 1");
  });

  // The manifest is printed after the lessons, one line for the summary and one for the rest, each only when declared.
  // A course with no lessons, so the manifest lines are all that follows the `ok:` line.
  test.each([
    ["only a license", { license: "MIT" }, ["license MIT"]],
    ["only a summary", { summary: "Ring the changes." }, ["summary: Ring the changes."]],
    ["only an author", { author: "A Ringer" }, ["by A Ringer"]],
    ["only a format", { format: 1 }, ["format 1"]],
    ["a summary and a license", { summary: "Ring the changes.", license: "MIT" }, ["summary: Ring the changes.", "license MIT"]],
    ["an author and a format", { author: "A Ringer", format: 1 }, ["by A Ringer; format 1"]],
  ])("CHECK-17: --human prints exactly the manifest lines a course with %s declares, and no null", async (_, declared, expected) => {
    const dir = course({ course: JSON.stringify({ title: "Bells", ...declared }) });
    const r = await run(["--human", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([`checking ${dir}`, "ok: Bells, 0 lessons, 0 quizzes, 0 explain blocks", ...expected]);
    expect(r.stdout).not.toContain("null");
  });

  test("CHECK-6: --human prints prose, not JSON", async () => {
    const r = await run(["--human", course({ course: JSON.stringify({ title: "Bells" }), lessons: { "0001.json": page("a", [quiz("q")]) } })]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("{");
    expect(r.stdout).toContain("Bells");
    expect(r.stdout).toContain("1 lesson");
  });
});
