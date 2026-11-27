// The course list as a registry (RFC 7 §5.2 and §7, task 4; flyingrobots/school#234): configured
// courses and the record's current installs served together, refreshed from the record on every
// read, with an install whose folder is missing or altered listed but not served.
// The record is reached through its `installedCourses` port, whose answers the LearningRecord
// contract checks on PGlite and Bun.SQL (server/contract/learning-record.ts); here it is a list the
// test changes, so a refresh can be seen without a database.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
afterEach(() => {
  const unlock = (dir: string) => {
    try {
      chmodSync(dir, 0o755);
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name));
    } catch {}
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
});

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

// Oracle: the review of #320 (F-1, F-3, F-5): a filesystem failure while verifying one install makes
// that install unavailable and nothing else; a refusal for altered files is remembered; a reason
// names the install by id and never an absolute path of the store.
describe.skipIf(process.getuid?.() === 0)("an install that cannot be read", () => {
  const reasonOf = (r: Awaited<ReturnType<ReturnType<typeof registryOf>["current"]>>, name: string) => {
    const f = r.find(name);
    return f?.kind === "unavailable" ? f.course.reason : "";
  };

  test("an unreadable subfolder at start lists that install as unavailable and still serves the others", async () => {
    const own = courseAt(join(root, "own"), "Own");
    const good = installed("good", "Good");
    const bad = installed("bad", "Bad");
    chmodSync(join(installFolder(join(root, "store"), bad.id), "lessons"), 0o000);
    const r = await registryOf(configWith({ SCHOOL_COURSES: `own=${own}` }), [good, bad]).start();
    expect(summary(r)).toEqual([
      { name: "bad", title: "Bad", trusted: false, kind: "unavailable" },
      { name: "good", title: "Good", trusted: false, kind: "served" },
      { name: "own", title: "Own", trusted: true, kind: "served" },
    ]);
  });

  test("an unreadable subfolder appearing after start leaves the other courses served, and is not remembered", async () => {
    const own = courseAt(join(root, "own"), "Own");
    const rows = [installed("bells", "Bells")];
    const registry = registryOf(configWith({ SCHOOL_COURSES: `own=${own}` }), rows);
    await registry.start();
    rows.push(installed("late", "Late"));
    const lessons = join(installFolder(join(root, "store"), rows[1]!.id), "lessons");
    chmodSync(lessons, 0o000);
    const during = await registry.current();
    chmodSync(lessons, 0o755);
    const after = await registry.current();
    expect({ during: summary(during).map((s) => `${s.name}:${s.kind}`), after: summary(after).map((s) => `${s.name}:${s.kind}`) }).toEqual({
      during: ["bells:served", "late:unavailable", "own:served"],
      after: ["bells:served", "late:served", "own:served"],
    });
  });

  test("an unreadable subfolder's reason names the install and what failed, not the store's path", async () => {
    const bad = installed("bad", "Bad");
    chmodSync(join(installFolder(join(root, "store"), bad.id), "lessons"), 0o000);
    const reason = reasonOf(await registryOf(configWith({}), [bad]).start(), "bad");
    expect(reason).toContain(bad.id);
    expect(reason).not.toContain(root);
  });
});

describe("a reason for an install that is not served", () => {
  const reasonOf = (r: Awaited<ReturnType<ReturnType<typeof registryOf>["current"]>>, name: string) => {
    const f = r.find(name);
    return f?.kind === "unavailable" ? f.course.reason : "";
  };

  test("names the install by id and never an absolute path, for a missing folder and for changed files", async () => {
    const gone = installed("gone", "Gone");
    const changed = installed("changed", "Changed");
    rmSync(installFolder(join(root, "store"), gone.id), { recursive: true });
    writeFileSync(join(installFolder(join(root, "store"), changed.id), "lessons", "0001.json"), LESSON.replace("Which?", "Which one?"));
    const r = await registryOf(configWith({}), [gone, changed]).start();
    const [g, c] = [reasonOf(r, "gone"), reasonOf(r, "changed")];
    expect({ g: [g.includes(gone.id), g.includes(root)], c: [c.includes(changed.id), c.includes(root)] }).toEqual({ g: [true, false], c: [true, false] });
  });

  // F-3: an altered folder put back after a missing read stays unavailable (the digest is checked again).
  test("an install folder deleted and put back altered stays unavailable", async () => {
    const row = installed("bells", "Bells");
    const folder = installFolder(join(root, "store"), row.id);
    const registry = registryOf(configWith({}), [row]);
    expect((await registry.start()).served.length).toBe(1);
    rmSync(folder, { recursive: true });
    expect((await registry.current()).served).toEqual([]);
    courseAt(folder, "Bells");
    writeFileSync(join(folder, "lessons", "0001.json"), LESSON.replace("Which?", "Which one?"));
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: false, kind: "unavailable" }]);
  });
});

// Oracle: the review of #320 (F-2) and flyingrobots/school#322, 2d: a file changed in an install's
// folder after its digest was checked is not served until the folder is checked again; the reason
// names the install by id and never an absolute path.
describe("an install whose files change while School runs", () => {
  const reasonOf = (r: Awaited<ReturnType<ReturnType<typeof registryOf>["current"]>>, name: string) => {
    const f = r.find(name);
    return f?.kind === "unavailable" ? f.course.reason : "";
  };

  test("a trusted install whose lesson changes after start is no longer served", async () => {
    const row = installed("bells", "Bells", { trusted: true });
    const registry = registryOf(configWith({}), [row]);
    await registry.start();
    writeFileSync(join(installFolder(join(root, "store"), row.id), "lessons", "0001.json"), LESSON.replace("Which?", "Which one?"));
    const r = await registry.current();
    expect({ summary: summary(r), id: reasonOf(r, "bells").includes(row.id), path: reasonOf(r, "bells").includes(root) })
      .toEqual({ summary: [{ name: "bells", title: "Bells", trusted: true, kind: "unavailable" }], id: true, path: false });
  });

  test("a trusted install with a file added after start is no longer served", async () => {
    const row = installed("bells", "Bells", { trusted: true });
    const registry = registryOf(configWith({}), [row]);
    await registry.start();
    writeFileSync(join(installFolder(join(root, "store"), row.id), "lessons", "0002.json"), LESSON.replace('"l1"', '"l2"'));
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: true, kind: "unavailable" }]);
  });

  test("an untrusted install whose lesson changes after start is no longer served", async () => {
    const row = installed("bells", "Bells");
    const registry = registryOf(configWith({}), [row]);
    await registry.start();
    writeFileSync(join(installFolder(join(root, "store"), row.id), "lessons", "0001.json"), LESSON.replace("Which?", "Which one?"));
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: false, kind: "unavailable" }]);
  });

  // Re-verification, not a remembered refusal: bytes put back as recorded hash to the recorded digest.
  test("a changed file put back as it was installed is served again", async () => {
    const row = installed("bells", "Bells", { trusted: true });
    const file = join(installFolder(join(root, "store"), row.id), "lessons", "0001.json");
    const registry = registryOf(configWith({}), [row]);
    await registry.start();
    writeFileSync(file, LESSON.replace("Which?", "Which one?"));
    const during = summary(await registry.current())[0]?.kind;
    writeFileSync(file, LESSON);
    expect({ during, after: summary(await registry.current())[0]?.kind }).toEqual({ during: "unavailable", after: "served" });
  });

  // The cheap check compares size and times; a same-size rewrite with the mtime put back is caught
  // only because the change time cannot be reset (flyingrobots/school#346, F1).
  test("a same-size rewrite with the modification time put back is no longer served", async () => {
    const row = installed("bells", "Bells", { trusted: true });
    const file = join(installFolder(join(root, "store"), row.id), "lessons", "0001.json");
    const registry = registryOf(configWith({}), [row]);
    await registry.start();
    const before = statSync(file);
    const rewritten = LESSON.replace("Which?", "Whom??");
    expect(rewritten.length).toBe(LESSON.length);
    writeFileSync(file, rewritten);
    utimesSync(file, before.atime, before.mtime);
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: true, kind: "unavailable" }]);
  });

  test("a file rewritten with the same bytes after start is still served", async () => {
    const row = installed("bells", "Bells", { trusted: true });
    const registry = registryOf(configWith({}), [row]);
    await registry.start();
    writeFileSync(join(installFolder(join(root, "store"), row.id), "lessons", "0001.json"), LESSON);
    expect(summary(await registry.current())).toEqual([{ name: "bells", title: "Bells", trusted: true, kind: "served" }]);
  });
});

// Oracle: the review of #320 (F-4) and flyingrobots/school#322, 2b: configured courses do not
// depend on the record; with the record unreachable, installs are listed, not served, with a reason
// that names no path.
describe("the course list with the record unreachable", () => {
  /** A registry whose record answers `rows` until `down()` is called, then refuses every read; `reads` counts them. */
  function flaky(config: Config, rows: InstalledCourse[]) {
    let up = true;
    const reads = { n: 0 };
    const registry = courseRegistry({
      config, configured: configuredCourses(config), log: (l) => logged.push(l),
      installed: async () => {
        reads.n++;
        if (!up) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        return [...rows];
      },
    });
    return { registry, reads, down: () => { up = false; } };
  }

  test("serves the configured courses and lists the installs it last saw as unavailable", async () => {
    const { registry, down } = flaky(configWith({ SCHOOL_COURSES: `own=${courseAt(join(root, "own"), "Own")}` }), [installed("bells", "Bells", { trusted: true })]);
    await registry.start();
    down();
    expect(summary(await registry.current())).toEqual([
      { name: "bells", title: "Bells", trusted: true, kind: "unavailable" },
      { name: "own", title: "Own", trusted: true, kind: "served" },
    ]);
  });

  test("an install's reason, with the record unreachable, names no path and says it is served again once the record answers", async () => {
    const row = installed("bells", "Bells");
    const { registry, down } = flaky(configWith({}), [row]);
    await registry.start();
    down();
    const f = (await registry.current()).find("bells");
    const reason = f?.kind === "unavailable" ? f.course.reason : "";
    expect({ record: /record/.test(reason), again: /again/.test(reason), path: reason.includes(root), refused: reason.includes("ECONNREFUSED") })
      .toEqual({ record: true, again: true, path: false, refused: false });
  });

  // The interaction is the promise: a configured course's routes must not depend on the record.
  test("finds a configured course by name without reading the record", async () => {
    const { registry, reads, down } = flaky(configWith({ SCHOOL_COURSES: `own=${courseAt(join(root, "own"), "Own")}` }), []);
    await registry.start();
    down();
    const before = reads.n;
    const found = await registry.find("own");
    expect({ found: found === null ? null : { kind: found.kind, name: found.course.name }, reads: reads.n - before })
      .toEqual({ found: { kind: "served", name: "own" }, reads: 0 });
  });

  test("finds an installed course by name through the record", async () => {
    const { registry } = flaky(configWith({}), [installed("bells", "Bells")]);
    await registry.start();
    const found = await registry.find("bells");
    expect(found === null ? null : { kind: found.kind, name: found.course.name }).toEqual({ kind: "served", name: "bells" });
  });
});
