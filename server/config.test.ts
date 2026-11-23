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
