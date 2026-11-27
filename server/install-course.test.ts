// Installing a previewed course (flyingrobots/school#238, RFC 7 task 8): `installPreviewed` takes
// `{preview, name}`, checks the name, moves the preview's folder to `courses/<install id>`, checks it
// there against what the preview found, records the install and leaves it to the course list to
// serve, untrusted. Each preview here is made by the real `previewInstall` from a repository on the
// local https server of the fetch tests (server/testing/https-git.ts), on loopback, so the staged
// folder is exactly what the route would find; the record is a real PGlite record through the
// server's own adapter. docs/topics/architecture/test-plan.md lists these by ID.
// Oracle: the issue's sections 2b, 2d and 2e, and RFC 7 §4, §5.1, §5.2 and §6.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresRecord } from "./adapters/postgres.ts";
import { pgliteSql } from "./adapters/pglite.ts";
import { parseConfig } from "./config.ts";
import type { InstallResult } from "./core/model.ts";
import type { LearningRecord } from "./core/ports.ts";
import { configuredCourses, contentDigest, courseRegistry, installFolder } from "./course-registry.ts";
import { migrate } from "./db/migrate.ts";
import type { Network } from "./fetch-commit.ts";
import { courseInstaller, installPreviewed, sweepCourses, type InstallSources } from "./install-course.ts";
import { PREVIEW_TTL_MS, previewInstall } from "./install-preview.ts";
import { certificate, git, gitBackend, serveHttps } from "./testing/https-git.ts";

setDefaultTimeout(30_000); // PGlite starts a whole Postgres in process.

const HOST = "course.test";
const root = mkdtempSync(join(tmpdir(), "school-install-course-"));
const home = join(root, "home");
const repos = join(root, "repos");
mkdirSync(home);
mkdirSync(repos);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXAMPLE = join(import.meta.dir, "..", ".agents", "skills", "school", "example");

/** A bare repository `<repos>/<name>.git` holding one commit of the folder `src`; returns the commit. */
function publish(name: string, src: string): string {
  const bare = join(repos, `${name}.git`);
  git(home, ["init", "--quiet", "--bare", "--template=", "--initial-branch=main", bare]);
  git(home, ["--git-dir", bare, "--work-tree", src, "add", "-A"]);
  git(home, ["--git-dir", bare, "--work-tree", src, "commit", "--quiet", "-m", name]);
  return git(home, ["--git-dir", bare, "rev-parse", "HEAD"]);
}
const good = publish("counting-in-binary", EXAMPLE);

const tls = certificate(join(root, "tls"), HOST);
let server: ReturnType<typeof serveHttps>;
let url: string;
let db: PGlite;
let record: LearningRecord;
beforeAll(async () => {
  server = serveHttps(tls, gitBackend(repos, home));
  url = `https://${HOST}:${server.port}/counting-in-binary.git`;
  db = new PGlite();
  await migrate(db);
  await db.exec("SET ROLE school_app");
  record = postgresRecord(pgliteSql(db));
});
afterAll(async () => {
  server.stop(true);
  await db.close();
});
const network = (): Partial<Network> =>
  ({ resolve: async (host) => (host === HOST ? ["127.0.0.1"] : []), publicAddress: (a) => a === "127.0.0.1", ports: [server.port!], caFile: tls.cert });

const T0 = Date.parse("2026-11-26T10:00:00Z");
let stores = 0;
let ids = 0;
/** A new, empty course store. */
function newStore(): string {
  const store = join(root, `store-${++stores}`);
  mkdirSync(store);
  return store;
}
/** A preview of the example course staged in `store` by the real previewInstall; answers its id. */
async function stage(store: string): Promise<string> {
  const id = `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
  const got = await previewInstall({ url, commit: good }, {
    store, configured: [], installedNames: async () => [], progress: async () => ({ encounters: 0, answers: 0, explanations: 0, views: 0 }),
    now: () => T0, newId: () => id,
  }, { network: network() });
  if (got.status !== "ok") throw new Error(`the preview was refused: ${JSON.stringify(got)}`);
  return got.preview;
}
/** Install sources over `store` and the shared record, at T0, with counted install ids; `o` overrides any. */
function sources(store: string, o: Partial<InstallSources> = {}): InstallSources {
  return {
    store, configured: [], installedNames: async () => (await record.installedCourses()).map((c) => c.course),
    record: (i) => record.installCourse(i, new Date(T0).toISOString()),
    now: () => T0, newId: () => `11111111-1111-4111-8111-${String(++ids).padStart(12, "0")}`, ...o,
  };
}
/** The course list a School over `store` would serve, with the shared record's installs. */
function registryOver(store: string) {
  const config = parseConfig({ SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_WEB: join(root, "web"), SCHOOL_COURSE_STORE: store }, join(root, "framework"));
  return courseRegistry({ config, configured: configuredCourses(config), installed: () => record.installedCourses(), log: () => {} });
}
/** The entries of `dir`, sorted; empty for a folder that does not exist. */
const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
const rowFor = async (name: string) => (await record.installedCourses()).find((c) => c.course === name) ?? null;
/** Every regular file under `dir`, relative. */
function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
}

describe("installPreviewed: the golden path", () => {
  test("INSTALL-1: installing a preview answers the install, and the record's row names the URL and commit", async () => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary" }, sources(store));
    const id = got.status === "installed" ? got.install : "";
    const row = await rowFor("binary");
    const digest = contentDigest(installFolder(store, id));
    expect({ got, row, digest }).toEqual({
      got: { status: "installed", install: id, course: "binary", url, commit: good, trusted: false },
      row: {
        id, course: "binary", source: "git", url, bundleSha256: null, commit: good, contentSha256: digest.ok ? digest.digest : "",
        title: "Counting in Binary", format: 1, at: new Date(T0).toISOString(), trusted: false,
      },
      digest: { ok: true, digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });

  test("INSTALL-2: the preview's folder becomes courses/<install id>, and nothing of the preview is left in staging/", async () => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary-2" }, sources(store));
    const id = got.status === "installed" ? got.install : "none";
    expect({ courses: entries(join(store, "courses")), staging: entries(join(store, "staging")), files: files(installFolder(store, id)).sort() }).toEqual({
      courses: [id], staging: [],
      files: ["course.json", "lessons/0001-places-worth-twice.json", "lessons/0002-adding-with-carries.json", "reference/glossary.html"],
    });
  });

  test("INSTALL-3: the course list serves the install untrusted, from its folder in the store", async () => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary-3" }, sources(store));
    const found = (await registryOver(store).current()).find("binary-3");
    expect(found?.kind === "served" ? { trusted: found.course.trusted, root: found.course.root, source: found.course.source } : found)
      .toEqual({ trusted: false, root: installFolder(store, got.status === "installed" ? got.install : ""), source: "installed" });
  });

  // RFC 7 §5.1: School marks each installed file read-only.
  test("INSTALL-4: every installed file is read-only", async () => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary-4" }, sources(store));
    const folder = installFolder(store, got.status === "installed" ? got.install : "");
    const modes = files(folder).map((f) => statSync(join(folder, f)).mode & 0o777);
    expect({ files: modes.length, modes: [...new Set(modes)] }).toEqual({ files: 4, modes: [0o444] });
  });
});

describe("installPreviewed: the course is not served before it is recorded", () => {
  // The known failure mode: serving before recording. The record is asked with the folder already
  // in courses/; at that moment the course list must not serve it.
  test("INSTALL-5: while the install is being recorded, its folder is in courses/ and the course list does not serve it", async () => {
    const store = newStore();
    const preview = await stage(store);
    const registry = registryOver(store);
    const seen: { folder: boolean; served: string | null }[] = [];
    const got = await installPreviewed({ preview, name: "binary-5" }, sources(store, {
      record: async (i) => {
        const found = (await registry.current()).find("binary-5");
        seen.push({ folder: lstatSync(installFolder(store, i.id)).isDirectory(), served: found?.kind ?? null });
        return record.installCourse(i, new Date(T0).toISOString());
      },
    }));
    expect({ status: got.status, seen }).toEqual({ status: "installed", seen: [{ folder: true, served: null }] });
  });

  test("INSTALL-6: a record that fails leaves no folder in courses/ and nothing served, and the failure is the caller's", async () => {
    const store = newStore();
    const preview = await stage(store);
    const failing = installPreviewed({ preview, name: "binary-6" }, sources(store, { record: async () => { throw new Error("connection refused"); } }));
    await expect(failing).rejects.toThrow("connection refused");
    expect({ courses: entries(join(store, "courses")), row: await rowFor("binary-6"), listed: (await registryOver(store).current()).find("binary-6") })
      .toEqual({ courses: [], row: null, listed: null });
  });

  test.each(["conflict", "stale", "rejected"] as const)("INSTALL-7: a record that answers %s is refused as not recorded, and leaves no folder in courses/", async (status) => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary-7" }, sources(store, { record: async (): Promise<InstallResult> => ({ status }) }));
    expect({ got, courses: entries(join(store, "courses")) }).toEqual({ got: { status: "refused", reason: "not-recorded", message: expect.any(String) }, courses: [] });
  });
});

describe("installPreviewed: the name", () => {
  test("INSTALL-8: a name a configured course has is refused as taken, and the preview is kept for another name", async () => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "own" }, sources(store, { configured: ["own"] }));
    expect({ got, courses: entries(join(store, "courses")), staged: entries(join(store, "staging", preview)), row: await rowFor("own") })
      .toEqual({ got: { status: "refused", reason: "name-taken", message: expect.stringContaining("own") }, courses: [], staged: ["course", "preview.json"], row: null });
  });

  test("INSTALL-9: a name a current install has is refused as taken, and that install stays current", async () => {
    const store = newStore();
    const first = await installPreviewed({ preview: await stage(store), name: "binary-9" }, sources(store));
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary-9" }, sources(store));
    expect({ got, current: (await rowFor("binary-9"))?.id, courses: entries(join(store, "courses")) })
      .toEqual({ got: { status: "refused", reason: "name-taken", message: expect.any(String) }, current: first.status === "installed" ? first.install : "", courses: [first.status === "installed" ? first.install : ""] });
  });

  test.each(["Binary", "api", "-binary", "", "bin ary"])("INSTALL-10: the name %j is refused as a bad name, and nothing is moved", async (name) => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name }, sources(store));
    expect({ got: got.status === "refused" ? got.reason : got.status, courses: entries(join(store, "courses")), staged: entries(join(store, "staging", preview)) })
      .toEqual({ got: "bad-name", courses: [], staged: ["course", "preview.json"] });
  });
});

describe("installPreviewed: the preview", () => {
  test("INSTALL-11: an expired preview is refused as expired and deleted, and nothing is installed", async () => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary-11" }, sources(store, { now: () => T0 + PREVIEW_TTL_MS }));
    expect({ got, staging: entries(join(store, "staging")), courses: entries(join(store, "courses")), row: await rowFor("binary-11") })
      .toEqual({ got: { status: "refused", reason: "expired", message: expect.any(String) }, staging: [], courses: [], row: null });
  });

  test("INSTALL-12: a preview id School never staged is refused as unknown", async () => {
    const store = newStore();
    const got = await installPreviewed({ preview: "22222222-2222-4222-8222-222222222222", name: "binary-12" }, sources(store));
    expect({ got, courses: entries(join(store, "courses")) }).toEqual({ got: { status: "refused", reason: "unknown-preview", message: expect.any(String) }, courses: [] });
  });

  test.each([
    ["a preview id that is a path", { preview: "../../etc", name: "binary" }],
    ["a preview id that is not a UUID", { preview: "left-behind", name: "binary" }],
    ["no name", { preview: "22222222-2222-4222-8222-222222222222" }],
    ["a name longer than 255 characters", { preview: "22222222-2222-4222-8222-222222222222", name: "a".repeat(256) }],
    ["a field besides preview and name", { preview: "22222222-2222-4222-8222-222222222222", name: "binary", url: "https://example.com/x.git" }],
    ["not an object", ["22222222-2222-4222-8222-222222222222", "binary"]],
  ])("INSTALL-13: a body with %s is invalid", async (_, body) => {
    const got = await installPreviewed(body, sources(newStore()));
    expect(got).toEqual({ status: "invalid", error: expect.any(String) });
  });

  test("INSTALL-14: a preview whose staged folder is a symlink to another preview is not followed", async () => {
    const elsewhere = newStore();
    const real = await stage(elsewhere);
    const store = newStore();
    mkdirSync(join(store, "staging"));
    symlinkSync(join(elsewhere, "staging", real), join(store, "staging", real));
    const got = await installPreviewed({ preview: real, name: "binary-14" }, sources(store));
    expect({ got: got.status === "refused" ? got.reason : got.status, other: entries(join(elsewhere, "staging", real)), courses: entries(join(store, "courses")) })
      .toEqual({ got: "unknown-preview", other: ["course", "preview.json"], courses: [] });
  });

  test("INSTALL-15: a staging/ that is a symlink to a folder of previews is not followed", async () => {
    const elsewhere = newStore();
    const real = await stage(elsewhere);
    const store = newStore();
    symlinkSync(join(elsewhere, "staging"), join(store, "staging"));
    const got = await installPreviewed({ preview: real, name: "binary-15" }, sources(store));
    expect({ got: got.status === "refused" ? got.reason : got.status, other: entries(join(elsewhere, "staging", real)) })
      .toEqual({ got: "unknown-preview", other: ["course", "preview.json"] });
  });
});

describe("installPreviewed: a preview changed after it was checked", () => {
  test("INSTALL-16: a lesson changed in staging is refused as changed, and nothing is installed or recorded", async () => {
    const store = newStore();
    const preview = await stage(store);
    const lesson = join(store, "staging", preview, "course", "lessons", "0001-places-worth-twice.json");
    writeFileSync(lesson, readFileSync(lesson, "utf8").replace("Places worth twice", "Places worth thrice"));
    const got = await installPreviewed({ preview, name: "binary-16" }, sources(store));
    expect({ got, courses: entries(join(store, "courses")), row: await rowFor("binary-16") })
      .toEqual({ got: { status: "refused", reason: "changed", message: expect.any(String) }, courses: [], row: null });
  });

  test("INSTALL-17: a file added in staging is refused as changed", async () => {
    const store = newStore();
    const preview = await stage(store);
    writeFileSync(join(store, "staging", preview, "course", "reference", "extra.html"), "<script>alert(1)</script>");
    const got = await installPreviewed({ preview, name: "binary-17" }, sources(store));
    expect({ got: got.status === "refused" ? got.reason : got.status, courses: entries(join(store, "courses")) }).toEqual({ got: "changed", courses: [] });
  });

  test("INSTALL-18: a symlink put in staging is refused, and what it points at is left alone", async () => {
    const store = newStore();
    const preview = await stage(store);
    const outside = join(root, `outside-${preview}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "secret");
    const mode = statSync(join(outside, "secret")).mode;
    symlinkSync(outside, join(store, "staging", preview, "course", "reference", "out"));
    const got = await installPreviewed({ preview, name: "binary-18" }, sources(store));
    expect({ got: got.status === "refused" ? got.reason : got.status, outside: entries(outside), mode: statSync(join(outside, "secret")).mode, courses: entries(join(store, "courses")) })
      .toEqual({ got: "changed", outside: ["secret"], mode, courses: [] });
  });

  test("INSTALL-19: a file outside what School installs, put in staging, is refused", async () => {
    const store = newStore();
    const preview = await stage(store);
    writeFileSync(join(store, "staging", preview, "course", "build.sh"), "#!/bin/sh\n");
    const got = await installPreviewed({ preview, name: "binary-19" }, sources(store));
    expect({ got: got.status === "refused" ? got.reason : got.status, courses: entries(join(store, "courses")) }).toEqual({ got: "changed", courses: [] });
  });

  test("INSTALL-20: a preview over RFC 7 Table 6.2's limits is refused as over the limit", async () => {
    const store = newStore();
    const preview = await stage(store);
    const got = await installPreviewed({ preview, name: "binary-20" }, sources(store, { limits: { files: 3 } }));
    expect({ got: got.status === "refused" ? got.reason : got.status, courses: entries(join(store, "courses")) }).toEqual({ got: "over-limit", courses: [] });
  });

  // A process that can write the store could write a preview.json; School does not read one.
  test("INSTALL-21: a preview.json put in staging naming another https URL and commit is not read: the row names what the preview fetched", async () => {
    const store = newStore();
    const preview = await stage(store);
    const file = join(store, "staging", preview, "preview.json");
    const was = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...was, url: "https://evil.example/other.git", commit: "f".repeat(40) }));
    const got = await installPreviewed({ preview, name: "binary-21" }, sources(store));
    const row = await rowFor("binary-21");
    expect({ got: got.status, url: row?.url, commit: row?.commit }).toEqual({ got: "installed", url, commit: good });
  });

  // The swap lands after every check of staging and before the move: the install id is asked for between them.
  test("INSTALL-29: a course/ swapped for a symlink just before the move is refused, and what it points at is left alone", async () => {
    const store = newStore();
    const preview = await stage(store);
    const course = join(store, "staging", preview, "course");
    const outside = join(root, `outside-swap-${preview}`);
    cpSync(course, outside, { recursive: true });
    const modes = () => files(outside).sort().map((f) => [f, statSync(join(outside, f)).mode & 0o777]);
    const before = modes();
    const id = "11111111-1111-4111-8111-aaaaaaaaaaaa";
    const got = await installPreviewed({ preview, name: "binary-29" }, sources(store, {
      newId: () => { rmSync(course, { recursive: true }); symlinkSync(outside, course); return id; },
    }));
    expect({ got: got.status === "refused" ? got.reason : got.status, modes: modes(), courses: entries(join(store, "courses")), row: await rowFor("binary-29") })
      .toEqual({ got: "changed", modes: before, courses: [], row: null });
  });

  test("INSTALL-30: a lesson replaced in staging by a hard link to an outside file with the same bytes is refused, and that file's mode is left alone", async () => {
    const store = newStore();
    const preview = await stage(store);
    const lesson = join(store, "staging", preview, "course", "lessons", "0001-places-worth-twice.json");
    const outside = join(root, `outside-link-${preview}.json`);
    writeFileSync(outside, readFileSync(lesson));
    rmSync(lesson);
    linkSync(outside, lesson);
    const mode = statSync(outside).mode & 0o777;
    const got = await installPreviewed({ preview, name: "binary-30" }, sources(store));
    expect({ got: got.status === "refused" ? got.reason : got.status, mode: statSync(outside).mode & 0o777, courses: entries(join(store, "courses")), row: await rowFor("binary-30") })
      .toEqual({ got: "changed", mode, courses: [], row: null });
  });
});

describe("installPreviewed: the course store", () => {
  test("INSTALL-22: a courses/ that is a symlink is not written through, and the install fails", async () => {
    const store = newStore();
    const preview = await stage(store);
    const outside = join(root, `outside-courses-${preview}`);
    mkdirSync(outside);
    symlinkSync(outside, join(store, "courses"));
    await expect(installPreviewed({ preview, name: "binary-22" }, sources(store))).rejects.toThrow("courses");
    expect({ outside: entries(outside), row: await rowFor("binary-22") }).toEqual({ outside: [], row: null });
  });
});

describe("courseInstaller: one install at a time", () => {
  test("INSTALL-23: the same preview installed twice at once installs once; the other finds it gone", async () => {
    const store = newStore();
    const preview = await stage(store);
    const install = courseInstaller(sources(store));
    const got = await Promise.all([install({ preview, name: "binary-23" }), install({ preview, name: "binary-23b" })]);
    expect({ got: got.map((g) => (g.status === "refused" ? g.reason : g.status)), courses: entries(join(store, "courses")).length })
      .toEqual({ got: ["installed", "unknown-preview"], courses: 1 });
  });

  test("INSTALL-24: two previews installed under one name at once: the first is installed and the second is refused as taken", async () => {
    const store = newStore();
    const a = await stage(store);
    const b = await stage(store);
    const install = courseInstaller(sources(store));
    const got = await Promise.all([install({ preview: a, name: "binary-24" }), install({ preview: b, name: "binary-24" })]);
    expect({ got: got.map((g) => (g.status === "refused" ? g.reason : g.status)), staged: entries(join(store, "staging")) })
      .toEqual({ got: ["installed", "name-taken"], staged: [b] });
  });
});

describe("sweepCourses: what start deletes from courses/", () => {
  /** A folder `courses/<id>` holding one read-only file, as an install leaves it. */
  function installed(store: string, id: string): string {
    const folder = installFolder(store, id);
    mkdirSync(join(folder, "lessons"), { recursive: true });
    writeFileSync(join(folder, "lessons", "0001.json"), "{}");
    chmodSync(join(folder, "lessons", "0001.json"), 0o444);
    return folder;
  }
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  // The acceptance criterion: a crash between the move and the record leaves a folder no row names.
  test("INSTALL-25: a folder no current install names is deleted, and a current install's is kept", () => {
    const store = newStore();
    installed(store, A);
    installed(store, B);
    writeFileSync(join(store, "courses", "stray"), "x");
    sweepCourses(store, new Set([A]));
    expect(entries(join(store, "courses"))).toEqual([A]);
  });

  test("INSTALL-26: a symlink in courses/ is removed, and what it points at is left alone", () => {
    const store = newStore();
    const outside = join(root, `outside-sweep-${stores}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "keep");
    mkdirSync(join(store, "courses"));
    symlinkSync(outside, join(store, "courses", A));
    sweepCourses(store, new Set([A]));
    expect({ courses: entries(join(store, "courses")), outside: entries(outside) }).toEqual({ courses: [], outside: ["keep"] });
  });

  test("INSTALL-31: a stray folder holding a symlink to an outside folder is deleted, and what it points at is left alone", () => {
    const store = newStore();
    const stray = join(installFolder(store, B), "reference");
    mkdirSync(stray, { recursive: true });
    const outside = join(root, `outside-sweep-${stores}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "keep");
    symlinkSync(outside, join(stray, "out"));
    sweepCourses(store, new Set());
    expect({ courses: entries(join(store, "courses")), outside: entries(outside) }).toEqual({ courses: [], outside: ["keep"] });
  });

  test("INSTALL-27: a courses/ that is a symlink is not swept", () => {
    const store = newStore();
    const outside = join(root, `outside-sweep-${stores}`);
    mkdirSync(join(outside, B), { recursive: true });
    symlinkSync(outside, join(store, "courses"));
    sweepCourses(store, new Set());
    expect(entries(outside)).toEqual([B]);
  });

  test("INSTALL-28: a store with no courses/ is left as it is", () => {
    const store = newStore();
    sweepCourses(store, new Set([A]));
    expect(entries(store)).toEqual([]);
  });
});
