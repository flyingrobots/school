// Increment 2's gate, config half: a course is configured rather than compiled in, and
// learner state cannot be placed inside a course.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError, FILE_CAP, FOLDER_CAP, course, courseNames, mountTable, parseConfig as parseConfigFrom, parseMounts, systemList, systemStat } from "./config.ts";

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
type Node = Id & { dirs?: string[]; files?: string[] };
/** A filesystem that knows only `tree`: each entry's identity, and the folders and files each folder holds. */
const fakeFs = (tree: Record<string, Node>) => ({
  stat: fakeStat(tree),
  // No entry here is a symlink, so lstat and stat agree.
  lstat: fakeStat(tree),
  list: (p: string) => {
    const node = tree[p];
    if (node === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return { dirs: node.dirs ?? [], files: node.files ?? [] };
  },
});
// /mnt/library is the trusted course's reference/ (7:44), /mnt/figs a mount's figures/ (8:11) and
// /mnt/static the web folder's assets/ (9:11), each bind-mounted on its own. /mnt/other is unrelated.
const PART_TREE: Record<string, Node> = {
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
};
const PART = fakeFs(PART_TREE);
const ROOTS = { SCHOOL_COURSE: "/mnt/course", SCHOOL_MOUNTS: "papers=/mnt/papers", SCHOOL_WEB: "/mnt/web" };
type FakeFs = { stat: (p: string) => Id; list: (p: string) => { dirs: string[]; files: string[] }; lstat?: (p: string) => Id };
const part = (env: Record<string, string>, fs: FakeFs = PART) =>
  parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: "/var/school", ...env }, FRAMEWORK, fs.stat, fs.list, fs.lstat ?? fs.stat);

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

test("a trusted course holding exactly FOLDER_CAP folders is walked and accepted", () => {
  expect(courseNames(part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, wide(FOLDER_CAP)))).toEqual(["course", "guest"]);
});

test("a trusted course holding more than FOLDER_CAP folders is refused when untrusted courses are set, naming it and the cap", () => {
  expect(() => part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, wide(FOLDER_CAP + 1)))
    .toThrow(`trusted course "course" (/mnt/course) from SCHOOL_COURSE holds more than ${FOLDER_CAP} folders, the folder cap`);
  expect(() => part({ SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" }, wide(FOLDER_CAP + 1)))
    .toThrow(/unset SCHOOL_UNTRUSTED_COURSES, or point SCHOOL_COURSE at a folder holding fewer/);
});

// A folder School cannot read is never silently skipped: the walk would miss what lies below it, and
// an untrusted course bind-mounted there would start unsandboxed. One that is gone or is no folder
// holds nothing to walk.
const failing = (code: string) => (p: string) => {
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

test("a trusted course holding more than FOLDER_CAP folders is accepted when no untrusted course is set, since nothing is walked", () => {
  expect(courseNames(part({ SCHOOL_COURSE: "/mnt/course" }, wide(FOLDER_CAP + 1)))).toEqual(["course"]);
});

test("FOLDER_CAP is 10,000 folders, as before files were walked", () => {
  expect(FOLDER_CAP).toBe(10_000);
});

test("FILE_CAP is 100,000 files", () => {
  expect(FILE_CAP).toBe(100_000);
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

test("School's own list names subfolders and regular files apart, and never a symlink", () => {
  const { root, done } = scratch();
  try {
    const { mkdirSync, symlinkSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "file.json"), "{}");
    symlinkSync(join(root, "a"), join(root, "link"));
    symlinkSync(join(root, "file.json"), join(root, "file-link"));
    const { dirs, files } = systemList(root);
    expect({ dirs: dirs.sort(), files }).toEqual({ dirs: ["a", "b"], files: ["file.json"] });
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

// Part of an untrusted course bind-mounted into a trusted folder (flyingrobots/school#315): the walk
// of a trusted folder above sees only the trusted side's names, so School also walks each untrusted
// course, folders and regular files, never through a symlink, and walks the files of each trusted
// course, mount and web folder too. An untrusted course is refused when any of its entries shares
// an identity with an entry of a trusted one, either way round. Oracle: POSIX stat, as above; a bind
// mount shows the bound file's or folder's st_dev and st_ino at its new path, and a hard link is one
// inode under two names.
// The untrusted course at /mnt/guest (device 6) holds notes.json and figures/page.json.
const GUEST_TREE: Record<string, Node> = {
  "/mnt/guest": { dev: 6, ino: 10, dirs: ["figures"], files: ["notes.json"] },
  "/mnt/guest/notes.json": { dev: 6, ino: 11 },
  "/mnt/guest/figures": { dev: 6, ino: 12, files: ["page.json"] },
  "/mnt/guest/figures/page.json": { dev: 6, ino: 13 },
};
// PART's trusted course with files of its own: course.json, and lessons/one.json.
const OWN_FILES: Record<string, Node> = {
  "/mnt/course": { dev: 7, ino: 42, dirs: ["lessons", "reference"], files: ["course.json"] },
  "/mnt/course/course.json": { dev: 7, ino: 60 },
  "/mnt/course/lessons": { dev: 7, ino: 43, files: ["one.json"] },
  "/mnt/course/lessons/one.json": { dev: 7, ino: 61 },
};
/**
 * PART's tree with the untrusted course and the trusted files, and `source` (a file or a folder,
 * with everything below it) bind-mounted at `target`, named in its parent's `kind`.
 */
function bound(source: string, target: string, kind: "dirs" | "files", extra: Record<string, Node> = {}) {
  const tree: Record<string, Node> = { ...PART_TREE, ...OWN_FILES, ...GUEST_TREE, ...extra };
  for (const [p, node] of Object.entries(tree)) if (p === source || p.startsWith(`${source}/`)) tree[target + p.slice(source.length)] = node;
  const at = target.lastIndexOf("/");
  const parent = tree[target.slice(0, at)]!;
  tree[target.slice(0, at)] = { ...parent, [kind]: [...(parent[kind] ?? []), target.slice(at + 1)] };
  return fakeFs(tree);
}
const GUEST = { ...ROOTS, SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/guest" };

test.each([
  ["an untrusted file bind-mounted into a trusted course's subfolder", "/mnt/guest/notes.json", "/mnt/course/reference/notes.json", "files", 'trusted course "course" (/mnt/course) from SCHOOL_COURSE'],
  ["an untrusted subfolder bind-mounted into a trusted course", "/mnt/guest/figures", "/mnt/course/lessons/figures", "dirs", 'trusted course "course" (/mnt/course) from SCHOOL_COURSE'],
  ["an untrusted file bind-mounted into a mount", "/mnt/guest/figures/page.json", "/mnt/papers/figures/page.json", "files", 'SCHOOL_MOUNTS mount "papers" (/mnt/papers)'],
  ["an untrusted subfolder bind-mounted into the web folder", "/mnt/guest/figures", "/mnt/web/assets/figures", "dirs", "SCHOOL_WEB (/mnt/web)"],
  ["a trusted subfolder bind-mounted into the untrusted course", "/mnt/course/lessons", "/mnt/guest/lessons", "dirs", 'trusted course "course" (/mnt/course) from SCHOOL_COURSE'],
  ["a trusted file bind-mounted into the untrusted course", "/mnt/course/course.json", "/mnt/guest/course.json", "files", 'trusted course "course" (/mnt/course) from SCHOOL_COURSE'],
] as const)("%s is refused at start, naming both entries and both folders", (_, source, target, kind, what) => {
  const untrustedSide = target.startsWith("/mnt/guest/") ? target : source;
  const trustedSide = target.startsWith("/mnt/guest/") ? source : target;
  expect(() => part(GUEST, bound(source, target, kind)))
    .toThrow(`untrusted course "guest" (/mnt/guest) from SCHOOL_UNTRUSTED_COURSES holds ${untrustedSide}, which is ${trustedSide} in ${what} under another name`);
});

test("the refusal is a ConfigError, so School exits 2 at start", () => {
  // Oracle: server/server.ts exits 2 on a ConfigError from parseConfig (docs/topics/architecture).
  expect(() => part(GUEST, bound("/mnt/guest/notes.json", "/mnt/course/reference/notes.json", "files"))).toThrow(ConfigError);
});

test("an untrusted course with files and subfolders of its own, beside trusted ones with theirs, is accepted", () => {
  const fs = fakeFs({ ...PART_TREE, ...OWN_FILES, ...GUEST_TREE });
  expect(course(part(GUEST, fs), "guest")?.trusted).toBe(false);
});

// Hard links: one inode under two names. Inside one course, or across two untrusted courses, the
// two names serve the same bytes under the same trust, so they are accepted. Between an untrusted
// course and a trusted one they are refused like a bind mount: the trusted route would serve the
// untrusted course's bytes unsandboxed, and a change made through the untrusted name changes them.
test.each([
  ["inside the untrusted course", { "/mnt/guest/figures": { dev: 6, ino: 12, files: ["page.json", "copy.json"] }, "/mnt/guest/figures/copy.json": { dev: 6, ino: 11 } }],
  ["inside a trusted course", { "/mnt/course/lessons": { dev: 7, ino: 43, files: ["one.json", "two.json"] }, "/mnt/course/lessons/two.json": { dev: 7, ino: 60 } }],
])("a file hard-linked under two names %s is accepted", (_, links) => {
  const fs = fakeFs({ ...PART_TREE, ...OWN_FILES, ...GUEST_TREE, ...links });
  expect(courseNames(part(GUEST, fs))).toEqual(["course", "guest"]);
});

test("a file hard-linked into two untrusted courses is accepted", () => {
  const fs = fakeFs({
    ...PART_TREE, ...OWN_FILES, ...GUEST_TREE,
    "/mnt/other": { dev: 6, ino: 50, files: ["notes.json"] },
    "/mnt/other/notes.json": { dev: 6, ino: 11 },
  });
  expect(courseNames(part({ ...ROOTS, SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/guest, other=/mnt/other" }, fs))).toEqual(["course", "guest", "other"]);
});

test("a file hard-linked between an untrusted course and a trusted one is refused, naming both", () => {
  const fs = fakeFs({
    ...PART_TREE, ...OWN_FILES, ...GUEST_TREE,
    "/mnt/course/lessons": { dev: 7, ino: 43, files: ["one.json", "notes.json"] },
    "/mnt/course/lessons/notes.json": { dev: 6, ino: 11 },
  });
  expect(() => part(GUEST, fs)).toThrow('holds /mnt/guest/notes.json, which is /mnt/course/lessons/notes.json in trusted course "course" (/mnt/course) from SCHOOL_COURSE under another name');
});

test("an untrusted course that does not exist yet is accepted, with nothing below it to walk", () => {
  expect(courseNames(part({ ...ROOTS, SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/new" }, fakeFs({ ...PART_TREE, ...OWN_FILES })))).toEqual(["course", "guest"]);
});

/** An untrusted course at /mnt/guest holding `folders` folders and `files` files, all directly under it. */
const wideGuest = (folders: number, files: number) => {
  const dirs = Array.from({ length: folders }, (_, i) => `d${i}`);
  const names = Array.from({ length: files }, (_, i) => `f${i}.json`);
  const tree: Record<string, Node> = { "/": { dev: 1, ino: 2 }, "/mnt/course": { dev: 7, ino: 1 }, "/mnt/guest": { dev: 6, ino: 1, dirs, files: names } };
  dirs.forEach((d, i) => (tree[`/mnt/guest/${d}`] = { dev: 6, ino: i + 2 }));
  names.forEach((f, i) => (tree[`/mnt/guest/${f}`] = { dev: 6, ino: folders + i + 2 }));
  return fakeFs(tree);
};
const GUEST_ONLY = { SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/guest" };

// The two caps count apart (flyingrobots/school#315): folders as before files were walked, so no
// setup that started then is refused for its folders now, and files against a cap of their own.
test("an untrusted course holding exactly FOLDER_CAP folders and FILE_CAP files is walked and accepted", () => {
  expect(courseNames(part(GUEST_ONLY, wideGuest(FOLDER_CAP, FILE_CAP)))).toEqual(["course", "guest"]);
});

test.each([
  ["folders", FOLDER_CAP + 1, 0, `holds more than ${FOLDER_CAP} folders, the folder cap`],
  ["files", 0, FILE_CAP + 1, `holds more than ${FILE_CAP} files, the file cap`],
])("an untrusted course holding one more than the cap of %s is refused, naming it, the cap and how to start", (_, folders, files, cap) => {
  expect(() => part(GUEST_ONLY, wideGuest(folders, files))).toThrow(`untrusted course "guest" (/mnt/guest) from SCHOOL_UNTRUSTED_COURSES ${cap}`);
  expect(() => part(GUEST_ONLY, wideGuest(folders, files))).toThrow(/To start, remove it from SCHOOL_UNTRUSTED_COURSES, or point it at a folder holding fewer/);
});

/** A trusted course at /mnt/course holding `folders` folders and `files` files, all directly under it. */
const wideCourse = (folders: number, files: number) => {
  const dirs = Array.from({ length: folders }, (_, i) => `d${i}`);
  const names = Array.from({ length: files }, (_, i) => `f${i}.json`);
  const tree: Record<string, Node> = { "/": { dev: 1, ino: 2 }, "/mnt/other": { dev: 6, ino: 1 }, "/mnt/course": { dev: 8, ino: 1, dirs, files: names } };
  [...dirs, ...names].forEach((n, i) => (tree[`/mnt/course/${n}`] = { dev: 8, ino: i + 2 }));
  return fakeFs(tree);
};
const BESIDE_OTHER = { SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/other" };

test("a trusted course holding exactly FOLDER_CAP folders and FILE_CAP files is walked and accepted", () => {
  expect(courseNames(part(BESIDE_OTHER, wideCourse(FOLDER_CAP, FILE_CAP)))).toEqual(["course", "guest"]);
});

test("a trusted course holding one more than FILE_CAP files is refused, naming it, the file cap and how to start", () => {
  expect(() => part(BESIDE_OTHER, wideCourse(0, FILE_CAP + 1)))
    .toThrow(`trusted course "course" (/mnt/course) from SCHOOL_COURSE holds more than ${FILE_CAP} files, the file cap`);
  expect(() => part(BESIDE_OTHER, wideCourse(0, FILE_CAP + 1))).toThrow(/To start, unset SCHOOL_UNTRUSTED_COURSES, or point SCHOOL_COURSE at a folder holding fewer/);
});

// An entry School cannot read is never skipped: an untrusted subfolder it cannot list could hold
// what is bind-mounted into a trusted folder, and a file it cannot stat could be one.
test("an untrusted subfolder School cannot list is refused, naming it, not skipped", () => {
  const fs = fakeFs({ ...PART_TREE, ...GUEST_TREE });
  const list = (p: string) => {
    if (p === "/mnt/guest/figures") throw Object.assign(new Error(`EACCES: ${p}`), { code: "EACCES" });
    return fs.list(p);
  };
  expect(() => part(GUEST, { stat: fs.stat, list }))
    .toThrow('cannot list /mnt/guest/figures in untrusted course "guest" (/mnt/guest) from SCHOOL_UNTRUSTED_COURSES: EACCES');
});

test.each([["an untrusted", "/mnt/guest/notes.json"], ["a trusted", "/mnt/course/course.json"]])("%s file School cannot stat is refused, naming it, not skipped", (_, file) => {
  const fs = fakeFs({ ...PART_TREE, ...OWN_FILES, ...GUEST_TREE });
  const stat = (p: string) => {
    if (p === file) throw Object.assign(new Error(`EACCES: ${p}`), { code: "EACCES" });
    return fs.stat(p);
  };
  expect(() => part(GUEST, { stat, lstat: stat, list: fs.list })).toThrow(`cannot stat ${file}: EACCES`);
});

// A file swapped for a symlink after the walk listed it (flyingrobots/school#315): School reads a
// listed file's identity with lstat, so it sees the link itself and never what it points at. The
// fake stat follows the link to its target; the fake lstat gives the link's own identity. Oracle:
// POSIX lstat, "if path names a symbolic link, lstat() shall return information about the link".
const swapped = (link: string, target: string) => {
  const fs = fakeFs({ ...PART_TREE, ...OWN_FILES, ...GUEST_TREE });
  const stat = (p: string) => fs.stat(p === link ? target : p);
  const lstat = (p: string) => (p === link ? { dev: 5, ino: 999 } : fs.stat(p));
  return { stat, lstat, list: fs.list };
};

test.each([
  ["an untrusted file, swapped for a symlink to a trusted file", "/mnt/guest/notes.json", "/mnt/course/course.json"],
  ["a trusted file, swapped for a symlink to an untrusted file", "/mnt/course/lessons/one.json", "/mnt/guest/notes.json"],
])("%s after it was listed, is read as the link, not followed", (_, link, target) => {
  expect(courseNames(part(GUEST, swapped(link, target)))).toEqual(["course", "guest"]);
});

// The real filesystem. A hard link needs no root, so it stands in for a bind mount of a file.
test("School's own list and stat find a real file hard-linked between an untrusted course and a trusted one", () => {
  const { root, done } = scratch();
  try {
    const { linkSync, mkdirSync, realpathSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const base = realpathSync(root);
    mkdirSync(join(base, "course", "reference"), { recursive: true });
    mkdirSync(join(base, "guest"));
    writeFileSync(join(base, "guest", "notes.json"), "{}");
    linkSync(join(base, "guest", "notes.json"), join(base, "course", "reference", "notes.json"));
    expect(() => parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: join(base, "state"), SCHOOL_COURSE: join(base, "course"), SCHOOL_UNTRUSTED_COURSES: `guest=${join(base, "guest")}` }, FRAMEWORK, systemStat, systemList))
      .toThrow(`holds ${join(base, "guest", "notes.json")}, which is ${join(base, "course", "reference", "notes.json")} in trusted course "course"`);
  } finally {
    done();
  }
});

test("the walk of an untrusted course does not follow a symlink into a trusted course, to a folder or a file", () => {
  const { root, done } = scratch();
  try {
    const { mkdirSync, realpathSync, symlinkSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const base = realpathSync(root);
    mkdirSync(join(base, "course", "reference"), { recursive: true });
    writeFileSync(join(base, "course", "course.json"), "{}");
    mkdirSync(join(base, "guest"));
    symlinkSync(join(base, "course", "reference"), join(base, "guest", "reference"));
    symlinkSync(join(base, "course", "course.json"), join(base, "guest", "course.json"));
    const c = parseConfigFrom({ SCHOOL_DATABASE_URL: "postgres://db/school", SCHOOL_STATE: join(base, "state"), SCHOOL_COURSE: join(base, "course"), SCHOOL_UNTRUSTED_COURSES: `guest=${join(base, "guest")}` }, FRAMEWORK, systemStat, systemList);
    expect(course(c, "guest")?.trusted).toBe(false);
  } finally {
    done();
  }
});

// Random trees, both ways round. Each seed builds a trusted course and an untrusted one, each of 2 to
// 60 folders with 0 to 3 files in each, then binds one random entry of the untrusted course (a file
// or a whole subfolder) at a fresh name in a random trusted folder: refused, naming the bound entry.
// The same trees unbound are accepted. Replay: `bun test server/config.test.ts -t "seed 17:"`.
function pair(seed: number): { bound: ReturnType<typeof fakeFs>; apart: ReturnType<typeof fakeFs>; source: string; target: string } {
  let s = seed >>> 0 || 1;
  const next = (n: number) => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s % n;
  };
  const nodes: Record<string, Node> = { "/": { dev: 1, ino: 2 } };
  const grow = (rootPath: string, dev: number) => {
    nodes[rootPath] = { dev, ino: 1 };
    const folders = [rootPath];
    const entries: [string, "dirs" | "files"][] = [];
    let ino = 2;
    const count = 2 + next(59);
    for (let i = 1; i < count; i++) {
      const parent = folders[next(folders.length)]!;
      (nodes[parent]!.dirs ??= []).push(`d${i}`);
      nodes[`${parent}/d${i}`] = { dev, ino: ino++ };
      folders.push(`${parent}/d${i}`);
      entries.push([`${parent}/d${i}`, "dirs"]);
    }
    for (const folder of folders) {
      for (let f = next(4); f > 0; f--) {
        (nodes[folder]!.files ??= []).push(`f${f}.json`);
        nodes[`${folder}/f${f}.json`] = { dev, ino: ino++ };
        entries.push([`${folder}/f${f}.json`, "files"]);
      }
    }
    return { folders, entries };
  };
  const trusted = grow("/mnt/course", 7);
  const untrusted = grow("/mnt/guest", 6);
  const apart = fakeFs({ ...nodes });
  const [source, kind] = untrusted.entries[next(untrusted.entries.length)]!;
  const target = `${trusted.folders[next(trusted.folders.length)]!}/bound`;
  for (const [p, node] of Object.entries({ ...nodes })) if (p === source || p.startsWith(`${source}/`)) nodes[target + p.slice(source.length)] = node;
  const parent = target.slice(0, target.lastIndexOf("/"));
  nodes[parent] = { ...nodes[parent]!, [kind]: [...(nodes[parent]![kind] ?? []), "bound"] };
  return { bound: fakeFs(nodes), apart, source, target };
}
const PAIR_ENV = { SCHOOL_COURSE: "/mnt/course", SCHOOL_UNTRUSTED_COURSES: "guest=/mnt/guest" };

test.each(SEEDS)("seed %d: an untrusted course's file or subfolder bound into a random trusted tree is refused", (seed) => {
  const { bound, source, target } = pair(seed);
  expect(() => part(PAIR_ENV, bound)).toThrow(`holds ${source}, which is ${target} in trusted course`);
});

test.each(SEEDS)("seed %d: a random untrusted course beside a random trusted one, nothing bound, is accepted", (seed) => {
  expect(courseNames(part(PAIR_ENV, pair(seed).apart))).toEqual(["course", "guest"]);
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

// The school skill an authoring agent is given (RFC 9 §5.3, flyingrobots/school#257). In a checkout
// it is the framework's own; compose mounts it at /framework/skills/school and the references at
// /framework/docs, and sets both. Whether the folders are there is reported, never refused at start.
test("SCHOOL_SKILL and SCHOOL_SKILL_DOCS default to the framework checkout's skill and its docs/topics", () => {
  const c = parseConfig({ SCHOOL_STATE: "/srv/state" }, FRAMEWORK);
  expect(c.skill).toBe("/opt/school/.agents/skills/school");
  expect(c.skillDocs).toBe("/opt/school/docs/topics");
});

test("SCHOOL_SKILL and SCHOOL_SKILL_DOCS name the skill and its references, relative paths resolving against the working directory", () => {
  const c = parseConfig({ SCHOOL_STATE: "/srv/state", SCHOOL_SKILL: "skill", SCHOOL_SKILL_DOCS: "/framework/docs" }, FRAMEWORK);
  expect(c.skill).toBe(join(process.cwd(), "skill"));
  expect(c.skillDocs).toBe("/framework/docs");
});

test("an empty SCHOOL_SKILL means no skill, so authoring is off", () => {
  expect(parseConfig({ SCHOOL_STATE: "/srv/state", SCHOOL_SKILL: "" }, FRAMEWORK).skill).toBe(null);
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
