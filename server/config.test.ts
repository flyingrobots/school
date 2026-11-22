// Increment 2's gate, config half: a course is configured rather than compiled in, and
// learner state cannot be placed inside a course.
import { expect, test } from "bun:test";
import { ConfigError, mountTable, parseConfig, parseMounts } from "./config.ts";

const FRAMEWORK = "/opt/school";

test("no course configured is a valid state, not a crash", () => {
  const c = parseConfig({}, FRAMEWORK);
  expect(c.course).toBe(null);
  expect(c.framework).toBe(FRAMEWORK);
  // Only the framework's own assets are served when there is no course.
  expect(Object.keys(mountTable(c))).toEqual(["assets"]);
});

test("a course outside the framework is served, and brings its own reference directory", () => {
  const c = parseConfig({ SCHOOL_COURSE: "/courses/aion", SCHOOL_STATE: "/var/school" }, FRAMEWORK);
  expect(c.course).toBe("/courses/aion");
  const table = mountTable(c);
  expect(table.assets).toBe("/opt/school/assets");
  expect(table.reference).toBe("/courses/aion/reference");
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
