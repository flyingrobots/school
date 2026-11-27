// Installed courses over HTTP against the real server (RFC 7 §5 and §7, task 4;
// flyingrobots/school#234): a course in the record and the course store is listed and served beside
// the configured ones, untrusted; one whose folder is missing or altered is listed with
// `lessons: null` and its reason, and not served; a name both configured and installed stops start.
// Oracle: the issue's sections 2b and 2d, and RFC 7 §7 for the shape of a course not served.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./adapters/database.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import type { CourseInstall } from "./core/model.ts";
import { contentDigest, installFolder } from "./course-registry.ts";
import { appUrl, scratchPostgres, TEST_POSTGRES_URL } from "./testing/postgres.ts";
import { migratedRecord, NotStarted, startSchool, timeout, type Started } from "./testing/processes.ts";

const roots: string[] = [];
const servers: Started[] = [];
afterAll(async () => {
  const unlock = (dir: string) => {
    try {
      chmodSync(dir, 0o755);
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name));
    } catch {}
  };
  for (const r of roots) unlock(r);
  for (const s of servers) {
    s.proc.kill();
    await s.proc.exited;
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const { fresh } = scratchPostgres();

const LESSON = JSON.stringify({
  type: "page", id: "l1", title: "One", subtitle: "",
  children: [{ type: "quiz", id: "q1", q: "Which?", why: "Because.", choices: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }] }],
});

function scratch(): string {
  const r = mkdtempSync(join(tmpdir(), "school-installed-"));
  roots.push(r);
  return r;
}

/** A course folder at `dir`: a course.json titled `title`, one lesson and one reference page. */
function courseAt(dir: string, title: string): string {
  mkdirSync(join(dir, "lessons"), { recursive: true });
  mkdirSync(join(dir, "reference"), { recursive: true });
  writeFileSync(join(dir, "course.json"), JSON.stringify({ title }));
  writeFileSync(join(dir, "lessons", "0001.json"), LESSON);
  writeFileSync(join(dir, "reference", "page.html"), "<p>page</p>");
  return dir;
}

/** Writes course `name`'s files into the store, as an install would, and answers the record's row for it. */
function installInStore(store: string, name: string, title: string): CourseInstall {
  const id = crypto.randomUUID();
  const d = contentDigest(courseAt(installFolder(store, id), title));
  if (!d.ok) throw new Error(d.message);
  return { id, course: name, source: "git", url: `https://example.com/${name}.git`, bundleSha256: null, commit: "b".repeat(40), contentSha256: d.digest, title, format: null };
}

/** A migrated PGlite record at `dir` holding `installs`, recorded through the server's own adapter. */
async function pgliteWith(dir: string, installs: CourseInstall[]): Promise<string> {
  cpSync(await migratedRecord(), dir, { recursive: true });
  const db = await openDatabase({ driver: "pglite", dir });
  try {
    for (const i of installs) await postgresRecord(db.sql).installCourse(i, "2026-11-26T00:00:00.000Z");
  } finally {
    await db.close();
  }
  return `pglite:${dir}`;
}

async function launch(root: string, env: Record<string, string>): Promise<Started> {
  const s = await startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_COURSE_STORE: join(root, "store"), ...env,
  });
  servers.push(s);
  return s;
}

type Listed = { name: string; title: string; trusted: boolean; lessons: number | null; lessonsError?: string };
const listed = async (s: Started): Promise<Listed[]> =>
  ((await (await fetch(`${s.url}/api/courses`)).json()) as Listed[]).map(({ name, title, trusted, lessons, lessonsError }) => ({ name, title, trusted, lessons, lessonsError }));

describe("installed courses (PGlite)", () => {
  test("a configured and an installed course are listed together, the installed one untrusted", async () => {
    const root = scratch();
    const bells = installInStore(join(root, "store"), "bells", "Bells");
    const s = await launch(root, { SCHOOL_COURSES: `own=${courseAt(join(root, "own"), "Own")}`, SCHOOL_DATABASE_URL: await pgliteWith(join(root, "record"), [bells]) });
    expect(await listed(s)).toEqual([
      { name: "bells", title: "Bells", trusted: false, lessons: 1, lessonsError: undefined },
      { name: "own", title: "Own", trusted: true, lessons: 1, lessonsError: undefined },
    ]);
  }, timeout(1));

  // The untrusted policy flyingrobots/school#271 set: sandbox, with fetch directives that keep the
  // document from loading anything from another site.
  const POLICY = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

  test("an installed course's lesson and reference files are served sandboxed", async () => {
    const root = scratch();
    const bells = installInStore(join(root, "store"), "bells", "Bells");
    const s = await launch(root, { SCHOOL_DATABASE_URL: await pgliteWith(join(root, "record"), [bells]) });
    const lesson = await fetch(`${s.url}/api/courses/bells/lessons/l1?view=slides`);
    const page = await fetch(`${s.url}/courses/bells/reference/page.html`);
    expect({ lesson: lesson.status, lessonCsp: lesson.headers.get("content-security-policy"), page: await page.text(), pageCsp: page.headers.get("content-security-policy") })
      .toEqual({ lesson: 200, lessonCsp: POLICY, page: "<p>page</p>", pageCsp: POLICY });
  }, timeout(1));

  test("an install whose folder is gone or whose files changed is listed with lessons null and its reason", async () => {
    const root = scratch();
    const gone = installInStore(join(root, "store"), "gone", "Gone");
    const changed = installInStore(join(root, "store"), "changed", "Changed");
    rmSync(installFolder(join(root, "store"), gone.id), { recursive: true });
    writeFileSync(join(installFolder(join(root, "store"), changed.id), "lessons", "0001.json"), LESSON.replace("Which?", "Which one?"));
    const s = await launch(root, { SCHOOL_DATABASE_URL: await pgliteWith(join(root, "record"), [gone, changed]) });
    expect(await listed(s)).toEqual([
      { name: "changed", title: "Changed", trusted: false, lessons: null, lessonsError: expect.stringContaining("changed since it was installed") },
      { name: "gone", title: "Gone", trusted: false, lessons: null, lessonsError: expect.stringContaining("missing") },
    ]);
  }, timeout(1));

  test("an install whose files changed is not served: its course answers lessons null, its lesson and reference files 404", async () => {
    const root = scratch();
    const changed = installInStore(join(root, "store"), "changed", "Changed");
    writeFileSync(join(installFolder(join(root, "store"), changed.id), "reference", "page.html"), "<script>alert(1)</script>");
    const s = await launch(root, { SCHOOL_DATABASE_URL: await pgliteWith(join(root, "record"), [changed]) });
    const course = (await (await fetch(`${s.url}/api/courses/changed`)).json()) as { lessons: unknown; lessonsError: unknown; reference: unknown };
    const lesson = await fetch(`${s.url}/api/courses/changed/lessons/l1`);
    const page = await fetch(`${s.url}/courses/changed/reference/page.html`);
    expect({ lessons: course.lessons, reason: course.lessonsError, reference: course.reference, lesson: lesson.status, page: page.status })
      .toEqual({ lessons: null, reason: expect.stringContaining("changed since it was installed"), reference: [], lesson: 404, page: 404 });
  }, timeout(1));

  // Oracle: the review of #320 (F-1): one install's unreadable folder makes that course unavailable only.
  test.skipIf(process.getuid?.() === 0)("an install with an unreadable subfolder at start is unavailable, and School starts and serves the configured course", async () => {
    const root = scratch();
    const own = courseAt(join(root, "own"), "Own");
    const bad = installInStore(join(root, "store"), "bad", "Bad");
    chmodSync(join(installFolder(join(root, "store"), bad.id), "lessons"), 0o000);
    const s = await launch(root, { SCHOOL_COURSES: `own=${own}`, SCHOOL_DATABASE_URL: await pgliteWith(join(root, "record"), [bad]) });
    const list = await listed(s);
    const own200 = (await fetch(`${s.url}/api/courses/own`)).status;
    expect({ list, own200 }).toEqual({
      list: [
        { name: "bad", title: "Bad", trusted: false, lessons: null, lessonsError: expect.not.stringContaining(root) },
        { name: "own", title: "Own", trusted: true, lessons: 1, lessonsError: undefined },
      ],
      own200: 200,
    });
  }, timeout(1));

  test("a name both configured and installed stops start with exit 2, naming both", async () => {
    const root = scratch();
    const own = courseAt(join(root, "own"), "Own");
    const twin = installInStore(join(root, "store"), "own", "Own, installed");
    const started = launch(root, { SCHOOL_COURSES: `own=${own}`, SCHOOL_DATABASE_URL: await pgliteWith(join(root, "record"), [twin]) });
    const e = await started.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(NotStarted);
    const n = e as NotStarted;
    expect({ code: n.exitCode, names: n.stderr.includes(`"own"`), configured: n.stderr.includes(own), installed: n.stderr.includes(twin.id) })
      .toEqual({ code: 2, names: true, configured: true, installed: true });
  }, timeout(1));
});

describe.skipIf(TEST_POSTGRES_URL === undefined)("installed courses on a real Postgres (Bun.SQL, SCHOOL_TEST_POSTGRES_URL)", () => {
  // The issue's acceptance test, and its known failure mode (a stale registry): the row is written
  // while School runs, through school_app's own connection, as an install route would.
  test("a course whose folder and row are added while School runs is in /api/courses with no restart (Bun.SQL)", async () => {
    const root = scratch();
    const record = await fresh();
    const s = await launch(root, { SCHOOL_DATABASE_URL: record.appUrl });
    const before = await listed(s);
    const bells = installInStore(join(root, "store"), "bells", "Bells");
    await postgresRecord(record.sql).installCourse(bells, "2026-11-26T00:00:00.000Z");
    expect({ before, after: await listed(s) }).toEqual({ before: [], after: [{ name: "bells", title: "Bells", trusted: false, lessons: 1, lessonsError: undefined }] });
  }, timeout(1) + 30_000);

  test.skipIf(process.getuid?.() === 0)("an unreadable subfolder appearing while School runs leaves every other course route at 200 (Bun.SQL)", async () => {
    const root = scratch();
    const own = courseAt(join(root, "own"), "Own");
    const record = await fresh();
    const s = await launch(root, { SCHOOL_COURSES: `own=${own}`, SCHOOL_DATABASE_URL: record.appUrl });
    const bad = installInStore(join(root, "store"), "bad", "Bad");
    chmodSync(join(installFolder(join(root, "store"), bad.id), "lessons"), 0o000);
    await postgresRecord(record.sql).installCourse(bad, "2026-11-26T00:00:00.000Z");
    const statuses = await Promise.all(["/api/courses", "/api/courses/own", "/api/courses/bad", "/api/courses/own/lessons/l1"].map(async (p) => (await fetch(`${s.url}${p}`)).status));
    expect(statuses).toEqual([200, 200, 200, 200]);
  }, timeout(1) + 30_000);
});
