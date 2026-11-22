// Where the framework finds a course, the learner's state, and any extra source material.
// Nothing here names a subject: a course is configured, never compiled in (ADR 6).
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Route prefixes the framework owns. A configured mount may not take one of these. */
export const RESERVED = ["assets", "courses", "lessons", "reference", "api"] as const;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export type Config = {
  /** The framework checkout. Supplies `assets/` and nothing else. */
  framework: string;
  /** Registered courses by name, served at `/courses/<name>`. Each holds `lessons/` and `reference/`. */
  courses: Record<string, string>;
  /** Directory for this learner's private state. Never inside a course. */
  state: string;
  dbPath: string;
  /** Extra read-only mounts, served at `/<name>/...`. Source material a course cites. */
  mounts: Record<string, string>;
  host: string;
  port: number;
};

export class ConfigError extends Error {}

function abs(value: string, from: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(from, value);
}

/**
 * Parse `name=path` pairs separated by commas, as used by `SCHOOL_COURSES` and
 * `SCHOOL_MOUNTS`. Relative paths resolve against `from`. Names are lowercase, become URL
 * segments, and may not shadow a route the framework owns.
 */
export function parsePairs(spec: string | undefined, from: string, label: string, reserve = true): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (spec ?? "").split(",")) {
    const text = entry.trim();
    if (text === "") continue;
    const eq = text.indexOf("=");
    if (eq <= 0) throw new ConfigError(`${label} entry ${JSON.stringify(text)} is not name=path`);
    const name = text.slice(0, eq).trim();
    const path = text.slice(eq + 1).trim();
    if (!NAME.test(name)) throw new ConfigError(`${label} name ${JSON.stringify(name)} must match ${NAME.source}`);
    if (reserve && (RESERVED as readonly string[]).includes(name)) throw new ConfigError(`${label} name ${JSON.stringify(name)} is reserved`);
    if (name in out) throw new ConfigError(`${label} name ${JSON.stringify(name)} is set twice`);
    if (path === "") throw new ConfigError(`${label} ${JSON.stringify(name)} has an empty path`);
    out[name] = abs(path, from);
  }
  return out;
}

/** Back-compatible alias; `SCHOOL_MOUNTS` is the only caller that needs the old name. */
export const parseMounts = (spec: string | undefined, from: string) => parsePairs(spec, from, "SCHOOL_MOUNTS");

/**
 * `p` with symlinks resolved as far as it exists. A path that does not exist yet (a state
 * directory School will create) resolves its nearest existing ancestor and keeps the rest.
 */
function resolved(p: string): string {
  const tail: string[] = [];
  let at = p;
  for (;;) {
    try {
      return join(realpathSync(at), ...tail.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return p;
      tail.push(basename(at));
      at = up;
    }
  }
}

/** Whether `inner` is `outer` or below it, after resolving symlinks. */
function within(inner: string, outer: string): boolean {
  const i = resolved(inner);
  const o = resolved(outer);
  return i === o || i.startsWith(o.endsWith(sep) ? o : o + sep);
}

export function parseConfig(env: Record<string, string | undefined>, frameworkDefault: string): Config {
  const cwd = process.cwd();
  const framework = abs(env.SCHOOL_ROOT ?? frameworkDefault, cwd);
  // SCHOOL_COURSES registers many; SCHOOL_COURSE stays accepted as a single unnamed course,
  // named after its directory, so a one-course setup needs no extra ceremony.
  const courses = parsePairs(env.SCHOOL_COURSES, cwd, "SCHOOL_COURSES");
  if (env.SCHOOL_COURSE !== undefined && env.SCHOOL_COURSE !== "") {
    const path = abs(env.SCHOOL_COURSE, cwd);
    const name = basename(path).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!NAME.test(name)) throw new ConfigError(`SCHOOL_COURSE directory ${JSON.stringify(basename(path))} does not make a usable course name`);
    if ((RESERVED as readonly string[]).includes(name)) throw new ConfigError(`SCHOOL_COURSE name ${JSON.stringify(name)} is reserved; use SCHOOL_COURSES to name it`);
    if (name in courses) throw new ConfigError(`SCHOOL_COURSE name ${JSON.stringify(name)} collides with SCHOOL_COURSES`);
    courses[name] = path;
  }
  const state = abs(env.SCHOOL_STATE ?? join(framework, "state"), cwd);

  const dbPath = env.DB_PATH === undefined || env.DB_PATH === "" ? join(state, "progress.db") : abs(env.DB_PATH, cwd);

  // Learner state must not land inside any course. A course is shared; performance is not.
  // Compared on resolved paths, so a symlink cannot smuggle state into a course.
  for (const [name, path] of Object.entries(courses)) {
    if (within(state, path)) {
      throw new ConfigError(`SCHOOL_STATE (${state}) is inside course ${JSON.stringify(name)} (${path}); learner state must live outside the course`);
    }
    if (within(dbPath, path)) {
      throw new ConfigError(`DB_PATH (${dbPath}) is inside course ${JSON.stringify(name)} (${path}); learner state must live outside the course`);
    }
  }

  const port = Number(env.PORT ?? 4747);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT ${JSON.stringify(env.PORT)} is not a port`);

  return {
    framework,
    courses,
    state,
    dbPath,
    mounts: parseMounts(env.SCHOOL_MOUNTS, cwd),
    host: env.HOST ?? "127.0.0.1",
    port,
  };
}

/** Top-level static mounts: the framework's assets plus any configured source material. */
export function mountTable(config: Config): Record<string, string> {
  return { assets: join(config.framework, "assets"), ...config.mounts };
}

export type Course = { name: string; root: string; lessons: string; reference: string };

export function course(config: Config, name: string): Course | null {
  const root = config.courses[name];
  if (root === undefined) return null;
  return { name, root, lessons: join(root, "lessons"), reference: join(root, "reference") };
}

export function courseNames(config: Config): string[] {
  return Object.keys(config.courses).sort();
}
