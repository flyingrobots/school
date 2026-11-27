// The course list as a registry (RFC 7 §5.2 and §7, task 4; flyingrobots/school#234): configured
// courses and the record's current installs served together, refreshed from the record on every
// read, with an install whose folder is missing or altered listed but not served.
// The record is reached through its `installedCourses` port, whose answers the LearningRecord
// contract checks on PGlite and Bun.SQL (server/contract/learning-record.ts); here it is a list the
// test changes, so a refresh can be seen without a database.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "./config.ts";
import { InstalledCourse } from "./core/model.ts";
import { configuredCourses, contentDigest, courseRegistry, installFolder, RegistryError } from "./course-registry.ts";

const LESSON = JSON.stringify({
  type: "page", id: "l1", title: "One", subtitle: "",
  children: [{ type: "quiz", id: "q1", q: "Which?", why: "Because.", choices: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }] }],
});

let root = "";
let logged: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "school-registry-"));
  logged = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A course folder with a course.json titled `title` and one lesson. */
function courseAt(dir: string, title: string): string {
  mkdirSync(join(dir, "lessons"), { recursive: true });
  writeFileSync(join(dir, "course.json"), JSON.stringify({ title }));
  writeFileSync(join(dir, "lessons", "0001.json"), LESSON);
  return dir;
}

function configWith(env: Record<string, string>): Config {
  return parseConfig({
    SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_WEB: join(root, "web"),
    SCHOOL_COURSE_STORE: join(root, "store"), ...env,
  }, join(root, "framework"));
}

/** An installed course `name`: its folder in the store, and the record's row for it, with the folder's digest. */
function installed(name: string, title: string, overrides: Partial<InstalledCourse> = {}): InstalledCourse {
  const id = crypto.randomUUID();
  const folder = courseAt(installFolder(join(root, "store"), id), title);
  const d = contentDigest(folder);
  if (!d.ok) throw new Error(d.message);
  return InstalledCourse.parse({
    id, course: name, source: "git", url: `https://example.com/${name}.git`, bundleSha256: null, commit: "a".repeat(40),
    contentSha256: d.digest, title, format: null, at: "2026-11-26T00:00:00.000Z", trusted: false, ...overrides,
  });
}

function registryOf(config: Config, rows: InstalledCourse[]) {
  return courseRegistry({ config, configured: configuredCourses(config), installed: async () => [...rows], log: (l) => logged.push(l) });
}

/** What each listed course is, by name: "served" or its reason for not being served. */
const summary = (r: Awaited<ReturnType<ReturnType<typeof registryOf>["current"]>>) =>
  r.listed.map((l) => ({ name: l.course.name, title: l.course.title, trusted: l.course.trusted, kind: l.kind }));

describe("the course registry", () => {
  // Oracle: RFC 7 §7, "an installed course's [trust] from installed_courses()"; §5.2, one namespace.
  test("lists a configured and an installed course together, by name, the installed one untrusted", async () => {
    const config = configWith({ SCHOOL_COURSES: `own=${courseAt(join(root, "own"), "Own")}` });
    const r = await registryOf(config, [installed("bells", "Bells")]).start();
    expect(summary(r)).toEqual([
      { name: "bells", title: "Bells", trusted: false, kind: "served" },
      { name: "own", title: "Own", trusted: true, kind: "served" },
    ]);
  });

  test("serves an installed course from its install's folder in the course store", async () => {
    const config = configWith({});
    const row = installed("bells", "Bells");
    const r = await registryOf(config, [row]).start();
    const found = r.find("bells");
    expect(found?.kind === "served" ? found.course.root : null).toBe(join(root, "store", "courses", row.id));
  });

  test("an installed course the learner chose to trust is served trusted", async () => {
    const r = await registryOf(configWith({}), [installed("bells", "Bells", { trusted: true })]).start();
    expect(summary(r)).toEqual([{ name: "bells", title: "Bells", trusted: true, kind: "served" }]);
  });

  test("refuses to start when a name is both configured and installed, naming both", async () => {
    const own = courseAt(join(root, "own"), "Own");
    const row = installed("own", "Own, installed");
    const start = registryOf(configWith({ SCHOOL_COURSES: `own=${own}` }), [row]).start();
    await expect(start).rejects.toThrow(RegistryError);
    await expect(start).rejects.toThrow(new RegExp(`"own".*${own}.*${row.id}`));
  });

  test("an install whose folder is gone is listed with its reason and not served", async () => {
    const row = installed("bells", "Bells");
    rmSync(installFolder(join(root, "store"), row.id), { recursive: true });
    const r = await registryOf(configWith({}), [row]).start();
    expect(summary(r)).toEqual([{ name: "bells", title: "Bells", trusted: false, kind: "unavailable" }]);
    expect(r.served).toEqual([]);
    const found = r.find("bells");
    expect(found?.kind === "unavailable" ? found.course.reason : "").toMatch(/missing/);
  });

  test("an install whose files changed is listed with its reason and not served", async () => {
    const row = installed("bells", "Bells");
    writeFileSync(join(installFolder(join(root, "store"), row.id), "lessons", "0001.json"), LESSON.replace("Which?", "Which one?"));
    const r = await registryOf(configWith({}), [row]).start();
    expect(r.served).toEqual([]);
    const found = r.find("bells");
    expect(found?.kind === "unavailable" ? found.course.reason : "").toMatch(/changed since it was installed/);
  });

  test("an install with a file added to its folder is listed and not served", async () => {
    const row = installed("bells", "Bells");
    writeFileSync(join(installFolder(join(root, "store"), row.id), "lessons", "0002.json"), LESSON.replace('"l1"', '"l2"'));
    const r = await registryOf(configWith({}), [row]).start();
    expect(summary(r)).toEqual([{ name: "bells", title: "Bells", trusted: false, kind: "unavailable" }]);
  });

  test("installs with no course store configured are listed and not served", async () => {
    const row = installed("bells", "Bells");
    const config = configWith({ SCHOOL_COURSE_STORE: "" });
    const r = await registryOf(config, [row]).start();
    const found = r.find("bells");
    expect(found?.kind === "unavailable" ? found.course.reason : "").toMatch(/SCHOOL_COURSE_STORE/);
  });

  // The issue's known failure mode: serving a stale registry.
  test("a course installed after start is served on the next read, with no restart", async () => {
    const rows: InstalledCourse[] = [];
    const registry = registryOf(configWith({}), rows);
    expect((await registry.start()).listed).toEqual([]);
    rows.push(installed("bells", "Bells"));
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: false, kind: "served" }]);
  });

  test("a trust choice made after start is served on the next read", async () => {
    const row = installed("bells", "Bells");
    const rows = [row];
    const registry = registryOf(configWith({}), rows);
    await registry.start();
    rows[0] = { ...row, trusted: true };
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: true, kind: "served" }]);
  });

  test("a course removed after start is gone on the next read", async () => {
    const rows = [installed("bells", "Bells")];
    const registry = registryOf(configWith({}), rows);
    await registry.start();
    rows.pop();
    expect((await registry.current()).listed).toEqual([]);
  });

  test("an install whose folder goes missing after start is no longer served on the next read", async () => {
    const row = installed("bells", "Bells");
    const registry = registryOf(configWith({}), [row]);
    await registry.start();
    rmSync(installFolder(join(root, "store"), row.id), { recursive: true });
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: false, kind: "unavailable" }]);
  });

  test("an install under a configured name after start is not served in its place, and says so", async () => {
    const config = configWith({ SCHOOL_COURSES: `own=${courseAt(join(root, "own"), "Own")}` });
    const rows: InstalledCourse[] = [];
    const registry = registryOf(config, rows);
    await registry.start();
    rows.push(installed("own", "Own, installed"));
    const r = await registry.current();
    expect(summary(r)).toEqual([{ name: "own", title: "Own", trusted: true, kind: "served" }]);
    expect(logged.join("\n")).toMatch(/"own".*configured/);
  });
});

describe("an installed folder's content digest", () => {
  // Oracle: RFC 7 §7, "one line per file, `<sha256 of the file> <path>`, sorted by path", over the
  // FIPS 180-2 test vectors: SHA-256("abc") and SHA-256 of the empty string.
  test("is the SHA-256 of one line per file, its hash and its path, sorted by path", () => {
    const dir = join(root, "c");
    mkdirSync(join(dir, "reference", "deep"), { recursive: true });
    writeFileSync(join(dir, "reference", "deep", "z.html"), "abc");
    writeFileSync(join(dir, "course.json"), "");
    const manifest =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 course.json\n" +
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad reference/deep/z.html\n";
    expect(contentDigest(dir)).toEqual({ ok: true, digest: new Bun.CryptoHasher("sha256").update(manifest).digest("hex") });
  });

  test("refuses a folder holding anything but regular files and folders", () => {
    const dir = join(root, "c");
    mkdirSync(join(dir, "lessons"), { recursive: true });
    symlinkSync("/etc/hosts", join(dir, "lessons", "0001.json"));
    expect(contentDigest(dir)).toEqual({ ok: false, path: "lessons/0001.json", message: expect.stringContaining("not a regular file") });
  });
});
