// Increment 2's gate, config half: a course is configured rather than compiled in, and
// learner state cannot be placed inside a course.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError, DIRECTORY_CAP, course, courseNames, mountTable, parseConfig as parseConfigFrom, parseMounts, systemList, systemStat } from "./config.ts";

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

// Part of a trusted folder bind-mounted elsewhere (flyingrobots/school#298): at a bind mount's root
// ".." leaves the trusted tree, so the ancestor walk above cannot see that /mnt/library is the trusted
// course's reference/. School therefore walks every folder of each trusted course, mount and the web
// folder, never through a symlink, and refuses an untrusted course whose folder or an ancestor has
// one of their identities. Oracle: POSIX stat, as above; a bind mount shows the bound folder's
// st_dev and st_ino at its new path.
type Node = Id & { dirs?: string[] };
/** A filesystem that knows only `tree`: each folder's identity and the folders it holds. */
const fakeFs = (tree: Record<string, Node>) => ({
  stat: fakeStat(tree),
  list: (p: string): string[] => {
    const node = tree[p];
    if (node === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return node.dirs ?? [];
  },
});
// /mnt/library is the trusted course's reference/ (7:44), /mnt/figs a mount's figures/ (8:11) and
// /mnt/static the web folder's assets/ (9:11), each bind-mounted on its own. /mnt/other is unrelated.
const PART = fakeFs({
  "/": { dev: 1, ino: 2 },
  "/mnt/course": { dev: 7, ino: 42, dirs: ["lessons", "reference"] },
  "/mnt/course/lessons": { dev: 7, ino: 43 },
  "/mnt/course/reference": { dev: 7, ino: 44, dirs: ["guest"] },
  "/mnt/course/reference/guest": { dev: 7, ino: 45 },
  "/mnt/library": { dev: 7, ino: 44, dirs: ["guest"] },
  "/mnt/library/guest": { dev: 7, ino: 45 },
  "/mnt/papers": { dev: 8, ino: 10, dirs: ["figures"] },
  "/mnt/papers/figures": { dev: 8, ino: 11 },
  "/mnt/figs": { dev: 8, ino: 11 },
  "/mnt/web": { dev: 9, ino: 10, dirs: ["assets"] },
  "/mnt/web/assets": { dev: 9, ino: 11 },
  "/mnt/static": { dev: 9, ino: 11 },
  "/mnt/other": { dev: 7, ino: 50 },
});
const ROOTS = { SCHOOL_COURSE: "/mnt/course", SCHOOL_MOUNTS: "papers=/mnt/papers", SCHOOL_WEB: "/mnt/web" };
const part = (env: Record<string, string>, fs: ReturnType<typeof fakeFs> = PART) =>
  parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: "/var/school", ...env }, FRAMEWORK, fs.stat, fs.list);

test.each([
  ["a trusted course's subfolder under another name", "/mnt/library", 'trusted course "course" \\(/mnt/course\\) from SCHOOL_COURSE', "/mnt/course/reference"],
  ["inside a trusted course's subfolder under another name", "/mnt/library/guest", 'trusted course "course" \\(/mnt/course\\) from SCHOOL_COURSE', "/mnt/course/reference/guest"],
  ["not yet made, inside a trusted course's subfolder under another name", "/mnt/library/new", 'trusted course "course" \\(/mnt/course\\) from SCHOOL_COURSE', "/mnt/course/reference"],
  ["a mount's subfolder under another name", "/mnt/figs", 'SCHOOL_MOUNTS mount "papers" \\(/mnt/papers\\)', "/mnt/papers/figures"],
  ["the web folder's subfolder under another name", "/mnt/static", "SCHOOL_WEB \\(/mnt/web\\)", "/mnt/web/assets"],
])("an untrusted folder that is %s, by device and inode, is refused, naming both folders", (_, folder, other, inner) => {
  expect(() => part({ ...ROOTS, SCHOOL_UNTRUSTED_COURSES: `guest=${folder}` }))
    .toThrow(new RegExp(`untrusted course "guest" \\(${folder}\\) from SCHOOL_UNTRUSTED_COURSES is, or sits inside, ${inner} in ${other} under another name`));
});

test("an untrusted folder that shares no identity with any trusted folder's tree is accepted", () => {
  expect(course(part({ ...ROOTS, SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }), "guest")?.trusted).toBe(false);
});

test.each([
  ["holds no folders", { "/mnt/course": { dev: 7, ino: 42 } }],
  ["does not exist yet", {}],
])("a trusted course that %s is accepted beside an untrusted one", (_, course_) => {
  const fs = fakeFs({ "/": { dev: 1, ino: 2 }, "/mnt/other": { dev: 7, ino: 50 }, ...course_ });
  expect(courseNames(part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, fs))).toEqual(["course", "guest"]);
});

/** A trusted course at /mnt/course holding `n` folders, all directly under it. */
const wide = (n: number) => {
  const dirs = Array.from({ length: n }, (_, i) => `d${i}`);
  const tree: Record<string, Node> = { "/": { dev: 1, ino: 2 }, "/mnt/other": { dev: 7, ino: 1 }, "/mnt/course": { dev: 8, ino: 1, dirs } };
  dirs.forEach((d, i) => (tree[`/mnt/course/${d}`] = { dev: 8, ino: i + 2 }));
  return fakeFs(tree);
};

test("a trusted course holding exactly DIRECTORY_CAP folders is walked and accepted", () => {
  expect(courseNames(part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, wide(DIRECTORY_CAP)))).toEqual(["course", "guest"]);
});

test("a trusted course holding more than DIRECTORY_CAP folders is refused when untrusted courses are set, naming it and the cap", () => {
  expect(() => part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, wide(DIRECTORY_CAP + 1)))
    .toThrow(`trusted course "course" (/mnt/course) from SCHOOL_COURSE holds more than ${DIRECTORY_CAP} folders`);
  expect(() => part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, wide(DIRECTORY_CAP + 1)))
    .toThrow(/unset SCHOOL_UNTRUSTED_COURSES, or point SCHOOL_COURSE at a folder holding fewer/);
});

// A folder School cannot read is never silently skipped: the walk would miss what lies below it, and
// an untrusted course bind-mounted there would start unsandboxed. One that is gone or is no folder
// holds nothing to walk.
const failing = (code: string) => (p: string): string[] => {
  if (p === "/mnt/course/reference") throw Object.assign(new Error(`${code}: ${p}`), { code });
  return PART.list(p);
};

test("a trusted subfolder School cannot read is refused, naming the folder, not skipped", () => {
  expect(() => part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, { stat: PART.stat, list: failing("EACCES") }))
    .toThrow("cannot list /mnt/course/reference in trusted course \"course\" (/mnt/course) from SCHOOL_COURSE: EACCES");
});

test.each(["ENOENT", "ENOTDIR"])("a trusted subfolder that fails to list with %s is skipped, not refused", (code) => {
  const c = part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, { stat: PART.stat, list: failing(code) });
  expect(courseNames(c)).toEqual(["course", "guest"]);
});

test("a trusted course holding more than DIRECTORY_CAP folders is accepted when no untrusted course is set, since nothing is walked", () => {
  expect(courseNames(part({ SCHOOL_COURSE: "/mnt/course" }, wide(DIRECTORY_CAP + 1)))).toEqual(["course"]);
});

test("DIRECTORY_CAP is 10,000 folders", () => {
  expect(DIRECTORY_CAP).toBe(10_000);
});

// The real filesystem: School's own list finds real subfolders, and never follows a symlink. The
// server never serves through a symlink that leaves a course (serveFrom compares real paths), so a
// symlink inside a trusted course to an untrusted one serves nothing unsandboxed.
test("School's own list finds a real trusted subfolder that an untrusted folder aliases", () => {
  const { root, done } = scratch();
  try {
    const { mkdirSync, realpathSync } = require("node:fs") as typeof import("node:fs");
    const base = realpathSync(root);
    mkdirSync(join(base, "course", "reference", "deep"), { recursive: true });
    mkdirSync(join(base, "guest"));
    // A bind mount needs root, so only stat is faked: guest reports deep/'s identity.
    const stat = (p: string) => systemStat(p === join(base, "guest") ? join(base, "course", "reference", "deep") : p);
    expect(() => parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: join(base, "state"), SCHOOL_COURSE: join(base, "course"), SCHOOL_UNTRUSTED_COURSES: `guest=${join(base, "guest")}` }, FRAMEWORK, stat, systemList))
      .toThrow(`is, or sits inside, ${join(base, "course", "reference", "deep")} in trusted course "course"`);
  } finally {
    done();
  }
});

test("the walk of a trusted course does not follow a symlink, even to an untrusted course or round a loop", () => {
  const { root, done } = scratch();
  try {
    const { mkdirSync, realpathSync, symlinkSync } = require("node:fs") as typeof import("node:fs");
    const base = realpathSync(root);
    mkdirSync(join(base, "course", "reference"), { recursive: true });
    mkdirSync(join(base, "guest"));
    symlinkSync(join(base, "guest"), join(base, "course", "reference", "guest"));
    symlinkSync(join(base, "course"), join(base, "course", "loop"));
    const c = parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: join(base, "state"), SCHOOL_COURSE: join(base, "course"), SCHOOL_UNTRUSTED_COURSES: `guest=${join(base, "guest")}` }, FRAMEWORK, systemStat, systemList);
    expect(course(c, "guest")?.trusted).toBe(false);
  } finally {
    done();
  }
});

test("School's own list names subfolders only, not files or symlinks", () => {
  const { root, done } = scratch();
  try {
    const { mkdirSync, symlinkSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "file.json"), "{}");
    symlinkSync(join(root, "a"), join(root, "link"));
    expect(systemList(root).sort()).toEqual(["a", "b"]);
  } finally {
    done();
  }
});

// Random trees with one aliased subfolder. Each seed builds a trusted course of 2 to 80 folders,
// picks one below the root, and binds it at /mnt/u; an untrusted course there or below it is
// refused, naming that folder, and one with a fresh identity is accepted. Replay: the seed is in
// the test's name, so `bun test server/config.test.ts -t "seed 17"` reruns one.
function tree(seed: number): { fs: ReturnType<typeof fakeFs>; inner: string; guest: string } {
  let s = seed >>> 0 || 1;
  const next = (n: number) => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s % n;
  };
  const nodes: Record<string, Node> = { "/": { dev: 1, ino: 2 }, "/mnt/fresh": { dev: 2, ino: 1 } };
  const paths = ["/mnt/course"];
  nodes["/mnt/course"] = { dev: 7, ino: 100 };
  const count = 2 + next(79);
  for (let i = 1; i < count; i++) {
    const parent = paths[next(paths.length)]!;
    const child = `${parent}/d${i}`;
    (nodes[parent]!.dirs ??= []).push(`d${i}`);
    nodes[child] = { dev: 7, ino: 100 + i };
    paths.push(child);
  }
  const inner = paths[1 + next(paths.length - 1)]!;
  // Bind inner at /mnt/u: every folder below it appears again under /mnt/u with the same identity.
  for (const p of paths.filter((q) => q === inner || q.startsWith(`${inner}/`))) nodes[`/mnt/u${p.slice(inner.length)}`] = nodes[p]!;
  const below = paths.filter((q) => q === inner || q.startsWith(`${inner}/`));
  const at = below[next(below.length)]!;
  return { fs: fakeFs(nodes), inner: at, guest: `/mnt/u${at.slice(inner.length)}` };
}
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

test.each(SEEDS)("seed %d: an untrusted course on an aliased subfolder of a random trusted tree is refused", (seed) => {
  const { fs, inner, guest } = tree(seed);
  expect(() => part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: `guest=${guest}` }, fs)).toThrow(`is, or sits inside, ${inner} in trusted course`);
});

test.each(SEEDS)("seed %d: an untrusted course with a fresh identity beside a random trusted tree is accepted", (seed) => {
  const { fs } = tree(seed);
  expect(courseNames(part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/fresh" }, fs))).toEqual(["course", "guest"]);
});

// The course store (RFC 7 §5.1, flyingrobots/school#233): the one folder School may write, which
// will hold installed courses and nothing else. It is content, not learner state, and School
// writes there, so it must not be, hold or sit inside a course, learner state, a mount or the web
// app's folder, compared on real paths and by device and inode, and a refusal names both paths.
// Oracle: RFC 7 §5.1, "Start refuses (exit 2, naming both paths ...) a store inside a configured
// course, inside SCHOOL_STATE, holding SCHOOL_STATE or a PGlite record, or the same as a
// configured course".
test("SCHOOL_COURSE_STORE names the course store", () => {
  expect(parseConfig({ SCHOOL_COURSE_STORE: "/srv/store", SCHOOL_COURSES: "own=/srv/own", SCHOOL_STATE: "/srv/state" }, FRAMEWORK).store).toBe("/srv/store");
});

test.each([
  ["unset", undefined],
  ["empty", ""],
])("SCHOOL_COURSE_STORE %s means no store, so installing is off", (_, value) => {
  expect(parseConfig({ SCHOOL_COURSE_STORE: value, SCHOOL_STATE: "/srv/state" }, FRAMEWORK).store).toBe(null);
});

test("a relative SCHOOL_COURSE_STORE resolves against the working directory, as every other path does, not the framework's", () => {
  expect(parseConfig({ SCHOOL_COURSE_STORE: "store", SCHOOL_STATE: "/srv/state" }, FRAMEWORK).store).toBe(join(process.cwd(), "store"));
});

test("a relative SCHOOL_COURSE_STORE inside a relative course is refused, both resolved from the working directory", () => {
  const cwd = process.cwd();
  expect(() => parseConfig({ SCHOOL_COURSE_STORE: "own/store", SCHOOL_COURSES: "own=own", SCHOOL_STATE: "/srv/state" }, FRAMEWORK))
    .toThrow(`SCHOOL_COURSE_STORE (${join(cwd, "own", "store")}) overlaps trusted course "own" (${join(cwd, "own")}) from SCHOOL_COURSES`);
});

// Two cheap refusals (review of #296): a store that is, holds or sits inside the framework (the
// server's source is inside it), and a store path that exists but is not a folder.
test.each([
  ["is the framework folder", "/opt/school"],
  ["sits inside the framework folder", "/opt/school/store"],
  ["sits inside the server's source folder", "/opt/school/server/store"],
  ["holds the framework folder", "/opt"],
])("a store that %s is refused, naming both paths", (_, store) => {
  expect(() => parseConfig({ SCHOOL_COURSE_STORE: store, SCHOOL_STATE: "/srv/state" }, FRAMEWORK))
    .toThrow(`SCHOOL_COURSE_STORE (${store}) overlaps the framework (/opt/school)`);
});

test("a store path that exists but is a file, not a folder, is refused, naming it", () => {
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { root, done } = scratch();
  try {
    const file = join(root, "store");
    writeFileSync(file, "not a folder");
    expect(() => parseConfig({ SCHOOL_COURSE_STORE: file, SCHOOL_STATE: join(root, "state") }, FRAMEWORK))
      .toThrow(`SCHOOL_COURSE_STORE (${file}) exists but is not a folder`);
  } finally {
    done();
  }
});

/** Every folder the store must stay apart from, each on its own path under /srv. */
const PLACED = {
  SCHOOL_COURSES: "own=/srv/own",
  SCHOOL_UNTRUSTED_COURSES: "guest=/srv/guest",
  SCHOOL_MOUNTS: "papers=/srv/papers",
  SCHOOL_WEB: "/srv/web",
  SCHOOL_STATE: "/srv/state",
  DB_PATH: "/srv/legacy/progress.db",
  SCHOOL_DATABASE_URL: "pglite:/srv/record",
};

test("a store beside every other folder, over none of them, is accepted", () => {
  expect(parseConfig({ ...PLACED, SCHOOL_COURSE_STORE: "/srv/store" }, FRAMEWORK).store).toBe("/srv/store");
});

test.each([
  ["is a trusted course", "/srv/own", 'trusted course "own" (/srv/own) from SCHOOL_COURSES'],
  ["sits inside a trusted course", "/srv/own/store", 'trusted course "own" (/srv/own) from SCHOOL_COURSES'],
  ["is an untrusted course", "/srv/guest", 'untrusted course "guest" (/srv/guest) from SCHOOL_UNTRUSTED_COURSES'],
  ["sits inside an untrusted course", "/srv/guest/reference/store", 'untrusted course "guest" (/srv/guest) from SCHOOL_UNTRUSTED_COURSES'],
  ["is SCHOOL_STATE", "/srv/state", "SCHOOL_STATE (/srv/state)"],
  ["sits inside SCHOOL_STATE", "/srv/state/store", "SCHOOL_STATE (/srv/state)"],
  ["holds DB_PATH", "/srv/legacy", "DB_PATH (/srv/legacy/progress.db)"],
  ["holds the PGlite record", "/srv/record", "the record in SCHOOL_DATABASE_URL (/srv/record)"],
  ["sits inside the PGlite record", "/srv/record/store", "the record in SCHOOL_DATABASE_URL (/srv/record)"],
  ["is a mount", "/srv/papers", 'SCHOOL_MOUNTS mount "papers" (/srv/papers)'],
  ["sits inside a mount", "/srv/papers/store", 'SCHOOL_MOUNTS mount "papers" (/srv/papers)'],
  ["is the web folder", "/srv/web", "SCHOOL_WEB (/srv/web)"],
  ["sits inside the web folder", "/srv/web/store", "SCHOOL_WEB (/srv/web)"],
])("a store that %s is refused, naming both paths", (_, store, other) => {
  expect(() => parseConfig({ ...PLACED, SCHOOL_COURSE_STORE: store }, FRAMEWORK)).toThrow(`SCHOOL_COURSE_STORE (${store}) overlaps ${other}`);
});

test.each([
  ["a trusted course", { SCHOOL_COURSES: "own=/srv/all/own" }, 'trusted course "own" (/srv/all/own) from SCHOOL_COURSES'],
  ["an untrusted course", { SCHOOL_UNTRUSTED_COURSES: "guest=/srv/all/guest" }, 'untrusted course "guest" (/srv/all/guest) from SCHOOL_UNTRUSTED_COURSES'],
  ["SCHOOL_STATE", { SCHOOL_STATE: "/srv/all/state" }, "SCHOOL_STATE (/srv/all/state)"],
  ["a mount", { SCHOOL_MOUNTS: "papers=/srv/all/papers" }, 'SCHOOL_MOUNTS mount "papers" (/srv/all/papers)'],
  ["the web folder", { SCHOOL_WEB: "/srv/all/web" }, "SCHOOL_WEB (/srv/all/web)"],
])("a store that holds %s is refused, naming both paths", (_, env, other) => {
  expect(() => parseConfig({ ...PLACED, ...env, SCHOOL_COURSE_STORE: "/srv/all" }, FRAMEWORK)).toThrow(`SCHOOL_COURSE_STORE (/srv/all) overlaps ${other}`);
});

test("a store that is a symlink into a course is refused, since paths are compared resolved", () => {
  const { mkdirSync, symlinkSync } = require("node:fs") as typeof import("node:fs");
  const { root, done } = scratch();
  try {
    mkdirSync(join(root, "course", "inner"), { recursive: true });
    symlinkSync(join(root, "course", "inner"), join(root, "store"));
    expect(() => parseConfig({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_COURSE_STORE: join(root, "store") }, FRAMEWORK))
      .toThrow(`SCHOOL_COURSE_STORE (${join(root, "store")}) overlaps trusted course "c" (${join(root, "course")}) from SCHOOL_COURSES`);
  } finally {
    done();
  }
});

test("a store that is a symlink into SCHOOL_STATE is refused, since paths are compared resolved", () => {
  const { mkdirSync, symlinkSync } = require("node:fs") as typeof import("node:fs");
  const { root, done } = scratch();
  try {
    mkdirSync(join(root, "state", "inner"), { recursive: true });
    symlinkSync(join(root, "state", "inner"), join(root, "store"));
    expect(() => parseConfig({ SCHOOL_STATE: join(root, "state"), SCHOOL_COURSE_STORE: join(root, "store") }, FRAMEWORK))
      .toThrow(`SCHOOL_COURSE_STORE (${join(root, "store")}) overlaps SCHOOL_STATE (${join(root, "state")})`);
  } finally {
    done();
  }
});

// The same rules by identity: under compose a folder can be bind-mounted under two names, which
// realpath cannot see. /mnt/course and /mnt/library are one folder (inode 42); /mnt/state and
// /mnt/vol are one folder (inode 60).
const STORE_ALIASED = fakeStat({
  "/": { dev: 1, ino: 2 },
  "/mnt/course": { dev: 7, ino: 42 },
  "/mnt/library": { dev: 7, ino: 42 },
  "/mnt/course/store": { dev: 7, ino: 44 },
  "/mnt/library/store": { dev: 7, ino: 44 },
  "/mnt/state": { dev: 7, ino: 60 },
  "/mnt/vol": { dev: 7, ino: 60 },
  "/mnt/store": { dev: 7, ino: 70 },
});
const storeAliased = (env: Record<string, string>) =>
  parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_COURSE: "/mnt/course", SCHOOL_STATE: "/mnt/state", ...env }, FRAMEWORK, STORE_ALIASED);

test.each([
  ["the trusted course under another name", "/mnt/library", 'trusted course "course" \\(/mnt/course\\) from SCHOOL_COURSE'],
  ["inside the trusted course under another name", "/mnt/library/store", 'trusted course "course" \\(/mnt/course\\) from SCHOOL_COURSE'],
  ["SCHOOL_STATE under another name", "/mnt/vol", "SCHOOL_STATE \\(/mnt/state\\)"],
])("a store that is %s, by device and inode, is refused, naming both paths", (_, store, other) => {
  expect(() => storeAliased({ SCHOOL_COURSE_STORE: store }))
    .toThrow(new RegExp(`SCHOOL_COURSE_STORE \\(${store}\\) and ${other} are the same folder under two names, or one holds the other`));
});

test("a store with its own device and inode is accepted under the same fake stat", () => {
  expect(storeAliased({ SCHOOL_COURSE_STORE: "/mnt/store" }).store).toBe("/mnt/store");
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

// A name is looked up as the maps' own key, never an inherited one (flyingrobots/school#299): `in`
// sees Object.prototype, so "constructor" was refused as set twice, and a lookup of an unregistered
// "constructor" found Object's constructor. Oracle: the course-name rule NAME, /^[a-z0-9][a-z0-9-]*$/,
// decides which names are allowed; Object.prototype's own property names are the names that collide.
test.each([
  ["SCHOOL_COURSES", { SCHOOL_COURSES: "constructor=/courses/x" }],
  ["SCHOOL_UNTRUSTED_COURSES", { SCHOOL_UNTRUSTED_COURSES: "constructor=/courses/x" }],
  ["SCHOOL_COURSE", { SCHOOL_COURSE: "/courses/constructor" }],
])("a course named constructor in %s is accepted under that name", (_, env) => {
  const c = parseConfig({ SCHOOL_STATE: "/var/school", ...env }, FRAMEWORK);
  expect(courseNames(c)).toEqual(["constructor"]);
});

test("a mount named constructor is accepted under that name", () => {
  expect(parseMounts("constructor=/src/x", "/cwd")).toEqual({ constructor: "/src/x" });
});

test.each(["toString", "__proto__"])("a course named %s is refused by the course-name rule, not as set twice", (name) => {
  expect(() => parseConfig({ SCHOOL_COURSES: `${name}=/courses/x` }, FRAMEWORK)).toThrow(`SCHOOL_COURSES name ${JSON.stringify(name)} must match`);
});

test.each([
  ["SCHOOL_COURSES", { SCHOOL_COURSES: "aion=/courses/a, aion=/courses/b" }, 'SCHOOL_COURSES name "aion" is set twice'],
  ["SCHOOL_UNTRUSTED_COURSES", { SCHOOL_UNTRUSTED_COURSES: "aion=/courses/a, aion=/courses/b" }, 'SCHOOL_UNTRUSTED_COURSES name "aion" is set twice'],
  ["SCHOOL_COURSE and SCHOOL_COURSES", { SCHOOL_COURSE: "/courses/aion", SCHOOL_COURSES: "aion=/courses/b" }, 'SCHOOL_COURSE name "aion" collides with SCHOOL_COURSES'],
  ["both trusted and untrusted lists", { SCHOOL_COURSES: "aion=/courses/a", SCHOOL_UNTRUSTED_COURSES: "aion=/courses/b" }, 'course "aion" is in both SCHOOL_COURSES and SCHOOL_UNTRUSTED_COURSES'],
])("a real duplicate in %s is still refused", (_, env, message) => {
  expect(() => parseConfig({ SCHOOL_STATE: "/var/school", ...env }, FRAMEWORK)).toThrow(message);
});

test("an unregistered name that Object.prototype holds finds no course and no mount", () => {
  const c = parseConfig({ SCHOOL_COURSES: "aion=/courses/aion", SCHOOL_MOUNTS: "lib=/src/lib" }, FRAMEWORK);
  expect([course(c, "constructor"), course(c, "__proto__"), mountTable(c)["constructor"], mountTable(c)["__proto__"]]).toEqual([null, null, undefined, undefined]);
});

// Every name Object.prototype holds: the rule accepts it as a course of its own, or refuses it for its shape.
const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);
const RULE = /^[a-z0-9][a-z0-9-]*$/;

test("Object.prototype holds names on both sides of the course-name rule", () => {
  expect([PROTOTYPE_NAMES.filter((n) => RULE.test(n)), PROTOTYPE_NAMES.filter((n) => !RULE.test(n)).length > 5]).toEqual([["constructor"], true]);
});

test.each(PROTOTYPE_NAMES.filter((n) => RULE.test(n)))("a course named %s, which the name rule allows, is registered under that name", (name) => {
  expect(course(parseConfig({ SCHOOL_COURSES: `${name}=/courses/x` }, FRAMEWORK), name)?.root).toBe("/courses/x");
});

test.each(PROTOTYPE_NAMES.filter((n) => !RULE.test(n)))("a course named %s, which the name rule forbids, is refused for its shape", (name) => {
  expect(() => parseConfig({ SCHOOL_COURSES: `${name}=/courses/x` }, FRAMEWORK)).toThrow(`SCHOOL_COURSES name ${JSON.stringify(name)} must match ^[a-z0-9][a-z0-9-]*$`);
});
