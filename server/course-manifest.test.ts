// A course's manifest (flyingrobots/school#209): `course.json` may declare a `summary`, an `author`,
// a `license` (an SPDX license expression) and the course `format` it is written in, beside its
// `title`. Each is optional; a course that declares none loads as before. The values are checked when
// the server starts, carried by GET /api/courses and GET /api/courses/:course (null when absent), and
// reported by `school check` (server/check-course.test.ts). docs/topics/course-format/test-plan.md
// lists these cases by ID.
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

// The manifest the golden cases declare, and what School gives back for it: the strings trimmed.
const FULL = {
  title: "Counting in Binary",
  summary: "  Count past ten on two fingers.  ",
  author: " The School maintainers ",
  license: "MIT OR Apache-2.0",
  format: 1,
};
const DECLARED = {
  title: "Counting in Binary",
  summary: "Count past ten on two fingers.",
  author: "The School maintainers",
  license: "MIT OR Apache-2.0",
  format: 1,
};
const UNDECLARED = { summary: null, author: null, license: null, format: null };

let n = 0;
const fresh = (root: string, body: unknown) => courseDir(root, `c${++n}`, JSON.stringify(body));

describe("readCourseFile: the manifest", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "school-course-manifest-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("MANIFEST-1: a course.json with a summary, author, license and format 1 gives each, trimmed", () => {
    expect(readCourseFile(fresh(root, FULL))).toEqual(DECLARED);
  });

  test("MANIFEST-2: a course.json with only a title declares nothing else", () => {
    expect(readCourseFile(fresh(root, { title: "T" }))).toEqual({ title: "T", ...UNDECLARED });
  });

  test("MANIFEST-3: a course with no course.json declares nothing", () => {
    expect(readCourseFile(courseDir(root, "none"))).toEqual({ title: null, ...UNDECLARED });
  });

  // Oracle: SPDX specification 2.3, Annex D (license expressions): AND, OR, WITH, parentheses, a
  // trailing `+`, LicenseRef- identifiers, and license identifiers matched without regard to case.
  test.each([
    "MIT",
    "MIT OR Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "(MIT AND BSD-2-Clause) OR GPL-2.0-or-later",
    "GPL-2.0+",
    "LicenseRef-Our-Own",
    "mit",
    "CC-BY-SA-4.0",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "GPL-2.0-only WITH classpath-exception-2.0",
    "DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style",
  ])("MANIFEST-4: the license %p is an SPDX expression, and is given as declared", (license) => {
    expect(readCourseFile(fresh(root, { title: "T", license })).license).toBe(license);
  });

  test.each([
    ["an empty summary", { summary: "" }, "summary"],
    ["a whitespace-only summary", { summary: "   " }, "summary"],
    ["a summary that is not a string", { summary: 3 }, "summary"],
    ["an empty author", { author: "" }, "author"],
    ["a whitespace-only author", { author: " \t " }, "author"],
    ["an author that is not a string", { author: ["A", "B"] }, "author"],
    ["an empty license", { license: "" }, "license"],
    ["a whitespace-only license", { license: "  " }, "license"],
    ["a license that is not a string", { license: { id: "MIT" } }, "license"],
    ["an unknown SPDX id", { license: "Frobnicate-1.0" }, "Frobnicate-1.0"],
    ["an unknown SPDX id in an expression", { license: "MIT OR Frobnicate-1.0" }, "Frobnicate-1.0"],
    ["a license named in words", { license: "MIT License" }, "license"],
    ["an expression with a dangling operator", { license: "MIT OR" }, "license"],
    ["an expression with an unclosed parenthesis", { license: "(MIT OR Apache-2.0" }, "license"],
    ["a lowercase operator", { license: "MIT or Apache-2.0" }, "license"],
    ["an unknown exception after WITH", { license: "MIT WITH Frobnicate-exception" }, "Frobnicate-exception"],
    ["a LicenseRef after WITH", { license: "MIT WITH LicenseRef-x" }, "LicenseRef-x"],
    ["a format that is not a number", { format: "1" }, "format"],
    ["a format that is not an integer", { format: 1.5 }, "format"],
    ["a format of zero", { format: 0 }, "format"],
  ])("MANIFEST-5: a course.json with %s is refused, naming the file and the key", (_, extra, named) => {
    const dir = fresh(root, { title: "T", ...extra });
    const message = errorOf(dir);
    expect(message).toContain(join(dir, "course.json"));
    expect(message).toContain(`"${Object.keys(extra)[0]}"`);
    expect(message).toContain(named);
  });

  test("MANIFEST-6: a course in a format this School does not play is refused, naming both versions", () => {
    const dir = fresh(root, { title: "T", format: 2 });
    const message = errorOf(dir);
    expect(message).toContain(join(dir, "course.json"));
    expect(message).toContain('"format"');
    expect(message).toMatch(/\b2\b.*\b1\b/);
  });

  test("MANIFEST-7: a key School does not know is still refused beside a full manifest", () => {
    const dir = fresh(root, { ...FULL, licence: "MIT" });
    expect(errorOf(dir)).toContain('"licence"');
  });
});

describe("the course API: the manifest", () => {
  let root = "";
  let server: Started | null = null;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "school-course-manifest-api-"));
    courseDir(root, "binary", JSON.stringify(FULL));
    courseDir(root, "titled", JSON.stringify({ title: "Titled" }));
    courseDir(root, "plain");
    writeFileSync(join(courseDir(root, "unreadable", JSON.stringify(FULL)), "lessons", "0001.json"), "{");
    server = await startSchool({
      ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
      SCHOOL_COURSES: ["binary", "titled", "plain", "unreadable"].map((c) => `${c}=${join(root, c)}`).join(","),
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
  const manifest = ({ summary, author, license, format }: Record<string, unknown>) => ({ summary, author, license, format });

  test("MANIFEST-8: GET /api/courses/:course gives the declared summary, author, license and format", async () => {
    expect(manifest(await get("/api/courses/binary"))).toEqual(manifest(DECLARED));
  });

  test("MANIFEST-8b: GET /api/courses/:course gives the manifest when the lessons cannot be read", async () => {
    const body = await get("/api/courses/unreadable");
    expect(body.lessons).toBeNull();
    expect(manifest(body)).toEqual(manifest(DECLARED));
  });

  test("MANIFEST-9: GET /api/courses/:course gives null for each key a course does not declare", async () => {
    expect(manifest(await get("/api/courses/titled"))).toEqual(UNDECLARED);
    expect(manifest(await get("/api/courses/plain"))).toEqual(UNDECLARED);
  });

  test("MANIFEST-10: GET /api/courses gives each course's manifest, null where undeclared", async () => {
    const courses = (await get("/api/courses")) as Record<string, unknown>[];
    expect(courses.map((c) => ({ name: c.name, ...manifest(c) }))).toEqual([
      { name: "binary", ...manifest(DECLARED) },
      { name: "plain", ...UNDECLARED },
      { name: "titled", ...UNDECLARED },
      { name: "unreadable", ...manifest(DECLARED) },
    ]);
  });
});

/** Starts School on one course whose course.json is `body`; gives how it failed to start. */
async function refusedStart(body: unknown): Promise<{ failure: NotStarted; file: string }> {
  const root = mkdtempSync(join(tmpdir(), "school-course-manifest-bad-"));
  try {
    const dir = courseDir(root, "binary", JSON.stringify(body));
    try {
      const s = await startSchool({
        ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
        SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_COURSES: `binary=${dir}`,
      });
      s.proc.kill();
      await s.proc.exited;
    } catch (e) {
      if (e instanceof NotStarted) return { failure: e, file: join(dir, "course.json") };
      throw e;
    }
    throw new Error("expected School to refuse to start");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("MANIFEST-11: an invalid manifest value stops the server at start, naming the course, the file and the key", async () => {
  const { failure, file } = await refusedStart({ ...FULL, author: "  " });
  expect(failure.exitCode).toBe(2);
  expect(failure.stderr).toContain(`course "binary"`);
  expect(failure.stderr).toContain(file);
  expect(failure.stderr).toContain('"author"');
}, timeout(1));

test("MANIFEST-12: a course in another format stops the server at start, naming the file and the key", async () => {
  const { failure, file } = await refusedStart({ ...FULL, format: 2 });
  expect(failure.exitCode).toBe(2);
  expect(failure.stderr).toContain(file);
  expect(failure.stderr).toContain('"format"');
}, timeout(1));
