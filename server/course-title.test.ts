// A course's title (flyingrobots/school#143): declared in `course.json` beside `lessons/`, read and
// validated when the server starts, carried by GET /api/courses and GET /api/courses/:course, and
// the course's name (its slug) when the course declares none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourseFileError, readCourseFile } from "./course-file.ts";
import { NotStarted, startSchool, timeout, type Started } from "./testing/processes.ts";

const lesson = JSON.stringify({ type: "page", id: "l1", title: "One", subtitle: "", children: [] });

/** A fresh course folder holding one lesson and, unless `file` is undefined, `course.json` with `file` as its text. */
function courseDir(root: string, name: string, file?: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "lessons"), { recursive: true });
  writeFileSync(join(dir, "lessons", "0001.json"), lesson);
  if (file !== undefined) writeFileSync(join(dir, "course.json"), file);
  return dir;
}

const errorOf = (dir: string): string => {
  try {
    readCourseFile(dir);
  } catch (e) {
    if (e instanceof CourseFileError) return e.message;
    throw e;
  }
  throw new Error("expected a CourseFileError");
};

describe("readCourseFile", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "school-course-file-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a course.json with a title gives that title", () => {
    expect(readCourseFile(courseDir(root, "titled", JSON.stringify({ title: "AIΩN Foundations" })))).toEqual({ title: "AIΩN Foundations" });
  });

  test("a course with no course.json declares no title", () => {
    expect(readCourseFile(courseDir(root, "untitled"))).toEqual({ title: null });
  });

  test("a course.json that is not JSON is refused, naming the file", () => {
    const dir = courseDir(root, "not-json", "{ title: ");
    expect(errorOf(dir)).toContain(join(dir, "course.json"));
    expect(errorOf(dir)).toContain("not valid JSON");
  });

  test.each([
    ["a title that is not a string", { title: 5 }],
    ["an empty title", { title: "  " }],
    ["no title", {}],
    ["a key School does not know", { title: "T", tilte: "T" }],
    ["an array", ["T"]],
  ])("a course.json with %s is refused, naming the file and the field", (_, body) => {
    const dir = courseDir(root, `bad-${Math.random().toString(36).slice(2)}`, JSON.stringify(body));
    const message = errorOf(dir);
    expect(message).toContain(join(dir, "course.json"));
    expect(message).toMatch(/title|tilte|object/);
  });
});

describe("the course API", () => {
  let root = "";
  let server: Started | null = null;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "school-course-title-"));
    courseDir(root, "aion", JSON.stringify({ title: "AIΩN Foundations" }));
    courseDir(root, "plain");
    // Lessons that cannot be read do not hide the title.
    const broken = courseDir(root, "broken", JSON.stringify({ title: "Broken Course" }));
    writeFileSync(join(broken, "lessons", "0001.json"), "{");
    server = await startSchool({
      ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
      SCHOOL_COURSES: ["aion", "plain", "broken"].map((c) => `${c}=${join(root, c)}`).join(","),
    });
  }, timeout(1));
  afterAll(async () => {
    server?.proc.kill();
    await server?.proc.exited;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const r = await fetch(server!.url + path);
    expect(r.status).toBe(200);
    return r.json();
  };

  test("GET /api/courses gives each course's title, and the slug for a course that declares none", async () => {
    const courses = (await get("/api/courses")) as { name: string; title: string }[];
    expect(courses.map(({ name, title }) => ({ name, title }))).toEqual([
      { name: "aion", title: "AIΩN Foundations" },
      { name: "broken", title: "Broken Course" },
      { name: "plain", title: "plain" },
    ]);
  });

  test("GET /api/courses/:course gives the course's title, falling back to the slug", async () => {
    expect(await get("/api/courses/aion")).toMatchObject({ name: "aion", title: "AIΩN Foundations" });
    expect(await get("/api/courses/plain")).toMatchObject({ name: "plain", title: "plain" });
  });

  test("GET /api/courses/:course gives the title even when the lessons cannot be read", async () => {
    expect(await get("/api/courses/broken")).toMatchObject({ name: "broken", title: "Broken Course", lessons: null });
  });
});

test("a malformed course.json stops the server at start, naming the course and the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "school-course-title-bad-"));
  try {
    const dir = courseDir(root, "aion", JSON.stringify({ title: 42 }));
    let failure: NotStarted | null = null;
    try {
      const s = await startSchool({
        ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
        SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_COURSES: `aion=${dir}`,
      });
      s.proc.kill();
      await s.proc.exited;
    } catch (e) {
      if (!(e instanceof NotStarted)) throw e;
      failure = e;
    }
    expect(failure).not.toBeNull();
    expect(failure!.exitCode).toBe(2);
    expect(failure!.stderr).toContain(`course "aion"`);
    expect(failure!.stderr).toContain(join(dir, "course.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, timeout(1));
