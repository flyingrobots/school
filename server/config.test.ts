// Increment 2's gate, config half: a course is configured rather than compiled in, and
// learner state cannot be placed inside a course.
import { expect, test } from "bun:test";
import { ConfigError, course, courseNames, mountTable, parseConfig, parseMounts } from "./config.ts";

const FRAMEWORK = "/opt/school";

test("no course configured is a valid state, not a crash", () => {
  const c = parseConfig({}, FRAMEWORK);
  expect(courseNames(c)).toEqual([]);
  expect(c.framework).toBe(FRAMEWORK);
  // Only the framework's own assets are served when nothing is registered.
  expect(Object.keys(mountTable(c))).toEqual(["assets"]);
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
  expect(Object.keys(mountTable(c))).toEqual(["assets"]);
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
