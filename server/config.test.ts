// Increment 2's gate, config half: a course is configured rather than compiled in, and
// learner state cannot be placed inside a course.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError, course, courseNames, mountTable, parseConfig as parseConfigFrom, parseMounts } from "./config.ts";

const FRAMEWORK = "/opt/school";

/** The config, with a record named: there is no default, and most of these tests are about something else. */
const parseConfig = (env: Record<string, string | undefined>, framework: string) =>
  parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", ...env }, framework);

test("no course configured is a valid state, not a crash", () => {
  const c = parseConfig({}, FRAMEWORK);
  expect(courseNames(c)).toEqual([]);
  expect(c.framework).toBe(FRAMEWORK);
  // Nothing is mounted when nothing is registered; the app comes from web/dist.
  expect(Object.keys(mountTable(c))).toEqual([]);
});

test("SCHOOL_COURSES registers several, served under their own names", () => {
  const c = parseConfig({ SCHOOL_COURSES: "aion=/courses/aion, blocks=/courses/blocks" }, FRAMEWORK);
  expect(courseNames(c)).toEqual(["aion", "blocks"]);
  expect(course(c, "aion")?.lessons).toBe("/courses/aion/lessons");
  expect(course(c, "blocks")?.reference).toBe("/courses/blocks/reference");
  expect(course(c, "missing")).toBe(null);
});

test("a course name may not shadow a route the framework owns", () => {
  expect(() => parseConfig({ SCHOOL_COURSES: "courses=/x" }, FRAMEWORK)).toThrow(/reserved/);
  expect(() => parseConfig({ SCHOOL_COURSES: "assets=/x" }, FRAMEWORK)).toThrow(/reserved/);
});

test("a single SCHOOL_COURSE is registered under its directory name", () => {
  const c = parseConfig({ SCHOOL_COURSE: "/courses/aion", SCHOOL_STATE: "/var/school" }, FRAMEWORK);
  expect(courseNames(c)).toEqual(["aion"]);
  expect(course(c, "aion")?.root).toBe("/courses/aion");
  // reference is per course now, not a top-level mount.
  expect(Object.keys(mountTable(c))).toEqual([]);
});

test("a course directory whose name cannot be a URL segment is refused", () => {
  expect(() => parseConfig({ SCHOOL_COURSE: "/courses/!!!" }, FRAMEWORK)).toThrow(ConfigError);
});

test("learner state inside the course is refused", () => {
  expect(() => parseConfig({ SCHOOL_COURSE: "/courses/aion", SCHOOL_STATE: "/courses/aion/progress" }, FRAMEWORK))
    .toThrow(ConfigError);
  expect(() => parseConfig({ SCHOOL_COURSE: "/courses/aion", SCHOOL_STATE: "/courses/aion" }, FRAMEWORK))
    .toThrow(/must live outside the course/);
  // A sibling whose name merely starts the same is fine.
  expect(parseConfig({ SCHOOL_COURSE: "/courses/aion", SCHOOL_STATE: "/courses/aion-state" }, FRAMEWORK).state)
    .toBe("/courses/aion-state");
});

test("the database defaults inside the state directory", () => {
  expect(parseConfig({ SCHOOL_STATE: "/var/school" }, FRAMEWORK).dbPath).toBe("/var/school/progress.db");
  expect(parseConfig({ SCHOOL_STATE: "/var/school", DB_PATH: "/tmp/other.db" }, FRAMEWORK).dbPath).toBe("/tmp/other.db");
});

test("SCHOOL_DATABASE_URL picks the driver, and there is no default", () => {
  for (const env of [{ SCHOOL_STATE: "/var/school" }, { SCHOOL_STATE: "/var/school", SCHOOL_DATABASE_URL: "" }]) {
    expect(() => parseConfigFrom(env, FRAMEWORK)).toThrow(/SCHOOL_DATABASE_URL is not set.*postgres:\/\/.*pglite:/);
  }
  expect(parseConfig({ SCHOOL_DATABASE_URL: "pglite:/srv/record" }, FRAMEWORK).database).toEqual({ driver: "pglite", dir: "/srv/record" });
  expect(parseConfig({ SCHOOL_DATABASE_URL: "pglite:record" }, FRAMEWORK).database).toEqual({ driver: "pglite", dir: join(process.cwd(), "record") });
  for (const url of ["postgres://school:pw@db:5432/school", "postgresql://db/school"]) {
    expect(parseConfig({ SCHOOL_DATABASE_URL: url }, FRAMEWORK).database).toEqual({ driver: "postgres", url });
  }
});

test("a SCHOOL_DATABASE_URL School cannot use is refused, without echoing what may be a password", () => {
  for (const url of ["mysql://u:hunter2@db/school", "sqlite:/var/school/progress.db", "pglite:", "pglite://x", "postgres://u:hunter2@[bad"]) {
    let message = "";
    try { parseConfig({ SCHOOL_DATABASE_URL: url }, FRAMEWORK); } catch (e) { expect(e).toBeInstanceOf(ConfigError); message = (e as Error).message; }
    expect(message).toContain("SCHOOL_DATABASE_URL");
    expect(message).not.toContain("hunter2");
  }
});

test("a PGlite record inside a course is refused", () => {
  expect(() => parseConfig({ SCHOOL_COURSES: "aion=/courses/aion", SCHOOL_STATE: "/var/school", SCHOOL_DATABASE_URL: "pglite:/courses/aion/db" }, FRAMEWORK))
    .toThrow(/SCHOOL_DATABASE_URL.*must live outside the course/);
});

test("named mounts are parsed, and several courses can cite different sources", () => {
  const m = parseMounts("aion=/repos/aion, papers=/repos/papers", "/cwd");
  expect(m).toEqual({ aion: "/repos/aion", papers: "/repos/papers" });
  expect(parseMounts("", "/cwd")).toEqual({});
  expect(parseMounts(undefined, "/cwd")).toEqual({});
  expect(parseMounts("rel=sources", "/cwd").rel).toBe("/cwd/sources");
});

test("a mount may not shadow a route the framework owns", () => {
  for (const name of ["assets", "lessons", "reference", "api"]) {
    expect(() => parseMounts(`${name}=/x`, "/cwd")).toThrow(/reserved/);
  }
});

test("malformed mount specs are rejected rather than half-applied", () => {
  expect(() => parseMounts("noequals", "/cwd")).toThrow(/not name=path/);
  expect(() => parseMounts("=/x", "/cwd")).toThrow(/not name=path/);
  expect(() => parseMounts("Caps=/x", "/cwd")).toThrow(/must match/);
  expect(() => parseMounts("has space=/x", "/cwd")).toThrow(/must match/);
  expect(() => parseMounts("a=/x,a=/y", "/cwd")).toThrow(/set twice/);
  expect(() => parseMounts("a=", "/cwd")).toThrow(/empty path/);
});

test("a bad port is refused", () => {
  expect(() => parseConfig({ PORT: "0" }, FRAMEWORK)).toThrow(ConfigError);
  expect(() => parseConfig({ PORT: "99999" }, FRAMEWORK)).toThrow(ConfigError);
  expect(() => parseConfig({ PORT: "abc" }, FRAMEWORK)).toThrow(ConfigError);
  expect(parseConfig({ PORT: "4791" }, FRAMEWORK).port).toBe(4791);
});

test("nothing in the config names a subject", () => {
  const source = Bun.file(new URL("./config.ts", import.meta.url)).text();
  return source.then((text) => {
    expect(text.toLowerCase()).not.toContain("aion");
    expect(text.toLowerCase()).not.toContain("warp");
  });
});

// Review finding #8: config invariants that leaked.
test("a database path inside a course is refused, like a state directory inside one", () => {
  expect(() => parseConfig({ SCHOOL_COURSES: "aion=/courses/aion", SCHOOL_STATE: "/var/school", DB_PATH: "/courses/aion/progress.db" }, FRAMEWORK))
    .toThrow(/DB_PATH/);
});

test("a single SCHOOL_COURSE may not be named after a reserved route", () => {
  expect(() => parseConfig({ SCHOOL_COURSE: "/somewhere/api", SCHOOL_STATE: "/var/school" }, FRAMEWORK)).toThrow(/reserved/);
});

test("state reached through a symlink into a course is still inside the course", () => {
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(require("node:os").tmpdir(), "school-config-"));
  try {
    mkdirSync(join(root, "course", "inner"), { recursive: true });
    symlinkSync(join(root, "course", "inner"), join(root, "state-link"));
    expect(() => parseConfig({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state-link") }, FRAMEWORK))
      .toThrow(/inside course/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Review of #8, P2: a dangling symlink used to be resolved as if it were a plain missing file,
// so DB_PATH could pass the containment check and then create the database inside a course.
function scratch(): { root: string; done: () => void } {
  const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const root = mkdtempSync(join(require("node:os").tmpdir(), "school-config-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a DB_PATH that is a dangling symlink into a course is refused", () => {
  const { mkdirSync, symlinkSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { root, done } = scratch();
  try {
    mkdirSync(join(root, "course"));
    mkdirSync(join(root, "state"));
    symlinkSync(join(root, "course", "new-progress.db"), join(root, "state", "progress.db"));
    expect(() => parseConfig({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state") }, FRAMEWORK))
      .toThrow(/symlink/);
    expect(existsSync(join(root, "course", "new-progress.db"))).toBe(false);
  } finally {
    done();
  }
});

test("a DB_PATH symlink whose target exists inside a course is still refused", () => {
  const { mkdirSync, symlinkSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { root, done } = scratch();
  try {
    mkdirSync(join(root, "course"));
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "course", "new-progress.db"), "");
    symlinkSync(join(root, "course", "new-progress.db"), join(root, "state", "progress.db"));
    expect(() => parseConfig({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state") }, FRAMEWORK))
      .toThrow(/inside course/);
  } finally {
    done();
  }
});

test("a first run with no state directory yet is accepted", () => {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  const { root, done } = scratch();
  try {
    mkdirSync(join(root, "course"));
    const c = parseConfig({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "not", "yet", "state") }, FRAMEWORK);
    expect(c.dbPath).toBe(join(root, "not", "yet", "state", "progress.db"));
  } finally {
    done();
  }
});

// Untrusted courses (flyingrobots/school#210). SCHOOL_UNTRUSTED_COURSES takes the same name=path
// pairs as SCHOOL_COURSES; a course is trusted or untrusted, never both.
test("SCHOOL_UNTRUSTED_COURSES registers courses that are not trusted, beside trusted ones", () => {
  const c = parseConfig({ SCHOOL_COURSES: "own=/courses/own", SCHOOL_UNTRUSTED_COURSES: "guest=/courses/guest", SCHOOL_STATE: "/var/school" }, FRAMEWORK);
  expect(courseNames(c)).toEqual(["guest", "own"]);
  expect(course(c, "guest")).toEqual({ name: "guest", root: "/courses/guest", lessons: "/courses/guest/lessons", reference: "/courses/guest/reference", trusted: false });
  expect(course(c, "own")?.trusted).toBe(true);
});

test("a course from SCHOOL_COURSE or SCHOOL_COURSES stays trusted when nothing marks it", () => {
  expect(course(parseConfig({ SCHOOL_COURSE: "/courses/own", SCHOOL_STATE: "/var/school" }, FRAMEWORK), "own")?.trusted).toBe(true);
  expect(course(parseConfig({ SCHOOL_COURSES: "own=/courses/own", SCHOOL_STATE: "/var/school" }, FRAMEWORK), "own")?.trusted).toBe(true);
});

test("a name both trusted and untrusted is refused, naming both variables", () => {
  expect(() => parseConfig({ SCHOOL_COURSES: "dual=/courses/a", SCHOOL_UNTRUSTED_COURSES: "dual=/courses/b", SCHOOL_STATE: "/var/school" }, FRAMEWORK))
    .toThrow(/"dual" is in both SCHOOL_COURSES and SCHOOL_UNTRUSTED_COURSES/);
  expect(() => parseConfig({ SCHOOL_COURSE: "/courses/dual", SCHOOL_UNTRUSTED_COURSES: "dual=/courses/b", SCHOOL_STATE: "/var/school" }, FRAMEWORK))
    .toThrow(/"dual" is in both SCHOOL_COURSE and SCHOOL_UNTRUSTED_COURSES/);
});

test("one folder both trusted and untrusted, under two names, is refused", () => {
  expect(() => parseConfig({ SCHOOL_COURSES: "own=/courses/same", SCHOOL_UNTRUSTED_COURSES: "guest=/courses/same/", SCHOOL_STATE: "/var/school" }, FRAMEWORK))
    .toThrow(/untrusted course "guest" \(\/courses\/same\) overlaps trusted course "own" \(\/courses\/same\)/);
});

test.each([
  ["inside a trusted one", "own=/courses/own", "guest=/courses/own/reference/guest"],
  ["around a trusted one", "own=/courses/guest/own", "guest=/courses/guest"],
])("an untrusted folder %s is refused, since the trusted course would serve its files unsandboxed", (_, trusted, untrusted) => {
  expect(() => parseConfig({ SCHOOL_COURSES: trusted, SCHOOL_UNTRUSTED_COURSES: untrusted, SCHOOL_STATE: "/var/school" }, FRAMEWORK))
    .toThrow(/overlaps trusted course "own"/);
});

test("SCHOOL_UNTRUSTED_COURSES follows SCHOOL_COURSES' rules for names and learner state", () => {
  expect(() => parseConfig({ SCHOOL_UNTRUSTED_COURSES: "api=/x", SCHOOL_STATE: "/var/school" }, FRAMEWORK)).toThrow(/SCHOOL_UNTRUSTED_COURSES name "api" is reserved/);
  expect(() => parseConfig({ SCHOOL_UNTRUSTED_COURSES: "guest=/courses/guest", SCHOOL_STATE: "/courses/guest/state" }, FRAMEWORK))
    .toThrow(/must live outside the course/);
});

// A mount or the web app's folder is served with no sandbox, so neither may reach an untrusted
// course's files (flyingrobots/school#210). Each is compared with every untrusted course on real
// paths, both ways round, and the refusal names both variables and both folders.
test.each([
  ["is the untrusted folder", "lib=/lib/guest"],
  ["contains the untrusted folder", "lib=/lib"],
  ["sits inside the untrusted folder", "lib=/lib/guest/reference"],
])("a SCHOOL_MOUNTS folder that %s is refused", (_, mounts) => {
  expect(() => parseConfig({ SCHOOL_UNTRUSTED_COURSES: "guest=/lib/guest", SCHOOL_MOUNTS: mounts, SCHOOL_STATE: "/var/school" }, FRAMEWORK))
    .toThrow(/SCHOOL_MOUNTS mount "lib" \(\/lib[^)]*\) overlaps untrusted course "guest" \(\/lib\/guest\) from SCHOOL_UNTRUSTED_COURSES/);
});

test.each([
  ["is the untrusted folder", "/lib/guest"],
  ["contains the untrusted folder", "/lib"],
  ["sits inside the untrusted folder", "/lib/guest/reference"],
])("a SCHOOL_WEB folder that %s is refused", (_, web) => {
  expect(() => parseConfig({ SCHOOL_UNTRUSTED_COURSES: "guest=/lib/guest", SCHOOL_WEB: web, SCHOOL_STATE: "/var/school" }, FRAMEWORK))
    .toThrow(/SCHOOL_WEB \(\/lib[^)]*\) overlaps untrusted course "guest" \(\/lib\/guest\) from SCHOOL_UNTRUSTED_COURSES/);
});

test("a mount reaching an untrusted course through a symlink is refused, since paths are compared resolved", () => {
  const { mkdirSync, symlinkSync } = require("node:fs") as typeof import("node:fs");
  const { root, done } = scratch();
  try {
    mkdirSync(join(root, "guest", "reference"), { recursive: true });
    symlinkSync(join(root, "guest"), join(root, "alias"));
    expect(() => parseConfig({ SCHOOL_UNTRUSTED_COURSES: `guest=${join(root, "guest")}`, SCHOOL_MOUNTS: `lib=${join(root, "alias")}`, SCHOOL_STATE: join(root, "state") }, FRAMEWORK))
      .toThrow(/SCHOOL_MOUNTS mount "lib" .* overlaps untrusted course "guest"/);
  } finally {
    done();
  }
});

test("a mount and a web folder beside an untrusted course, not over it, are accepted", () => {
  const c = parseConfig({ SCHOOL_UNTRUSTED_COURSES: "guest=/lib/guest", SCHOOL_MOUNTS: "docs=/lib/docs", SCHOOL_WEB: "/lib/web", SCHOOL_STATE: "/var/school" }, FRAMEWORK);
  expect([mountTable(c), c.web]).toEqual([{ docs: "/lib/docs" }, "/lib/web"]);
});

// Docker bind mounts (flyingrobots/school#280): compose mounts SCHOOL_COURSE_DIR at /course and,
// by default, again at /library. realpath cannot see that the two are one folder, so the overlap
// checks also compare filesystem identity, (st_dev, st_ino), of each folder and its ancestors.
// A test runner cannot bind-mount without root, so a fake stat reports aliases as one directory.
// Oracle: POSIX stat, "st_ino and st_dev taken together uniquely identify the file within the system".
type Id = { dev: number; ino: number };
/** A stat that knows only `ids`; every other path does not exist. */
const fakeStat = (ids: Record<string, Id>) => (p: string): Id => {
  const id = ids[p];
  if (id === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return id;
};
// /mnt/course and /mnt/library are one bind-mounted folder (inode 42); /mnt/other is another.
// Under /mnt, which macOS lacks, since its case-insensitive /library would resolve to /Library.
const ALIASED = fakeStat({
  "/": { dev: 1, ino: 2 },
  "/mnt/course": { dev: 7, ino: 42 },
  "/mnt/library": { dev: 7, ino: 42 },
  "/mnt/course/guest": { dev: 7, ino: 43 },
  "/mnt/library/guest": { dev: 7, ino: 43 },
  "/mnt/other": { dev: 7, ino: 50 },
});
const aliased = (env: Record<string, string>) =>
  parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: "/var/school", ...env }, FRAMEWORK, ALIASED);

test.each([
  ["the trusted folder under another name", { SCHOOL_COURSE: "/mnt/course" }, "guest=/mnt/library", 'trusted course "course" \\(/mnt/course\\) from SCHOOL_COURSE'],
  ["inside the trusted folder under another name", { SCHOOL_COURSE: "/mnt/course" }, "guest=/mnt/library/guest", 'trusted course "course" \\(/mnt/course\\) from SCHOOL_COURSE'],
  ["around the trusted folder under another name", { SCHOOL_COURSES: "own=/mnt/course/guest" }, "guest=/mnt/library", 'trusted course "own" \\(/mnt/course/guest\\) from SCHOOL_COURSES'],
  ["a mount's folder under another name", { SCHOOL_MOUNTS: "lib=/mnt/course" }, "guest=/mnt/library", 'SCHOOL_MOUNTS mount "lib" \\(/mnt/course\\)'],
  ["the web folder under another name", { SCHOOL_WEB: "/mnt/course" }, "guest=/mnt/library/guest", "SCHOOL_WEB \\(/mnt/course\\)"],
])("an untrusted folder that is %s, by device and inode, is refused", (_, env, untrusted, other) => {
  expect(() => aliased({ ...env, SCHOOL_UNTRUSTED_COURSES: untrusted }))
    .toThrow(new RegExp(`untrusted course "guest" \\(${untrusted.slice("guest=".length)}\\) from SCHOOL_UNTRUSTED_COURSES and ${other} are the same folder under two names`));
});

test("folders with different device and inode stay accepted under the same fake stat", () => {
  const c = aliased({ SCHOOL_COURSE: "/mnt/course", SCHOOL_MOUNTS: "lib=/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" });
  expect([course(c, "course")?.trusted, course(c, "guest")?.trusted]).toEqual([true, false]);
});

// Inodes above 2^53 (CodeRabbit on #213): a Number cannot hold them exactly, so two folders could
// round to one identity. Identities are compared as exact integers, and School's own stat asks the
// filesystem for bigint inodes. Oracle: Node's fs.statSync, "bigint: true" gives BigInt fields.
test("two folders whose inodes differ only above 2^53 are told apart", () => {
  const big = 2n ** 60n;
  const stat = fakeStat({
    "/": { dev: 1, ino: 2 },
    "/mnt/course": { dev: 7, ino: big } as unknown as Id,
    "/mnt/library": { dev: 7, ino: big + 1n } as unknown as Id,
  });
  const c = parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: "/var/school", SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/library" }, FRAMEWORK, stat);
  expect(course(c, "guest")?.trusted).toBe(false);
});

test("School's own stat reads inodes as bigint, so none is rounded", async () => {
  const config = (await import("./config.ts")) as Record<string, unknown>;
  const systemStat = config.systemStat as ((p: string) => { ino: unknown }) | undefined;
  expect(typeof systemStat?.("/").ino).toBe("bigint");
});
