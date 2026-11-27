// `checkCourse(folder)` (flyingrobots/school#231, RFC 7 task 1): the checks `school check` runs, as a function
// the server can call on a folder it has fetched. It returns what the `done` line reports, plus what
// course.json declares, or the first refusal. docs/topics/course-format/test-plan.md lists these cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCourse } from "./check-course.ts";
import { publishedIn } from "./testing/schemas.ts";

const EXAMPLE = join(import.meta.dir, "..", ".agents", "skills", "school", "example");
const root = mkdtempSync(join(tmpdir(), "school-check-course-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const quiz = (id: string) => ({ type: "quiz", id, q: "Which?", why: "Because.",
  choices: [{ id: "c0", text: "Choice 0", correct: true }, { id: "c1", text: "Choice 1", correct: false }] });
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

describe("checkCourse", () => {
  test("CHECK-11: the skill's worked example passes, with its lessons, counts and manifest", () => {
    // Oracle: the example's own files, .agents/skills/school/example/course.json and lessons/.
    expect(checkCourse(EXAMPLE)).toEqual({
      ok: true, folder: EXAMPLE, title: "Counting in Binary", quizzes: 3, explains: 2,
      lessons: [
        { file: "0001-places-worth-twice.json", id: "places-worth-twice", title: "Places worth twice", quizzes: 2, explains: 1 },
        { file: "0002-adding-with-carries.json", id: "adding-with-carries", title: "Adding with carries", quizzes: 2, explains: 1 },
      ],
      manifest: { summary: "How two symbols are enough to count anything, and how to read a binary number.",
        author: "The School maintainers", license: "Apache-2.0", format: 1 },
    });
  });

  test("CHECK-12: a malformed course.json is refused, naming course.json", () => {
    const dir = course({ course: "{ nope" });
    const r = checkCourse(dir);
    expect(r).toMatchObject({ ok: false, folder: dir, file: "course.json" });
    expect(r.ok === false && r.message).toContain("not valid JSON");
  });

  test("CHECK-13: a problem in a later lesson is refused, naming that lesson's file", () => {
    const r = checkCourse(course({ lessons: { "0001.json": page("a", [quiz("q")]), "0002.json": page("b", [quiz("q")]) } }));
    expect(r).toMatchObject({ ok: false, file: "0002.json" });
    expect(r.ok === false && r.message).toContain("duplicate block id");
  });

  test("CHECK-14: a refusal that spans files names no file", () => {
    const r = checkCourse(course({ lessons: { "0001.json": page("a", [{ ref: "nowhere" }]) } }));
    expect(r).toMatchObject({ ok: false, file: null });
    expect(r.ok === false && r.message).toContain('unknown ref "nowhere"');
  });

  test("CHECK-15: a folder that does not exist is refused, naming no file", () => {
    const missing = join(root, "no-such-course");
    expect(checkCourse(missing)).toEqual({ ok: false, folder: missing, file: null, message: `${missing} is not a folder` });
  });

  test("CHECK-16: school check prints checkCourse's result: done is it without the manifest, manifest is the manifest", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "check-course.ts"), EXAMPLE], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const out = publishedIn(join(import.meta.dir, "schemas", "check")).validated(stdout);
    const r = checkCourse(EXAMPLE);
    if (!r.ok) throw new Error(`the example was refused: ${r.message}`);
    const { manifest, ...done } = r;
    expect(out.at(-2)).toMatchObject({ event: "manifest", ...manifest });
    expect(out.at(-1)).toMatchObject({ event: "done", ...done });
  });
});
