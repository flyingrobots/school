// Where the framework finds a course, the learner's state, and any extra source material.
// Nothing here names a subject: a course is configured, never compiled in (ADR 6).
import { isAbsolute, join, resolve } from "node:path";

/** Route prefixes the framework owns. A configured mount may not take one of these. */
export const RESERVED = ["assets", "lessons", "reference", "api"] as const;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export type Config = {
  /** The framework checkout. Supplies `assets/` and nothing else. */
  framework: string;
  /** The course root, holding `lessons/` and `reference/`. Null when none is configured. */
  course: string | null;
  /** Directory for this learner's private state. Never inside `course`. */
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
 * Parse `SCHOOL_MOUNTS`: `name=path` pairs separated by commas. Relative paths resolve
 * against `from`. Names are lowercase and may not shadow a reserved route.
 */
export function parseMounts(spec: string | undefined, from: string): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const entry of (spec ?? "").split(",")) {
    const text = entry.trim();
    if (text === "") continue;
    const eq = text.indexOf("=");
    if (eq <= 0) throw new ConfigError(`SCHOOL_MOUNTS entry ${JSON.stringify(text)} is not name=path`);
    const name = text.slice(0, eq).trim();
    const path = text.slice(eq + 1).trim();
    if (!NAME.test(name)) throw new ConfigError(`mount name ${JSON.stringify(name)} must match ${NAME.source}`);
    if ((RESERVED as readonly string[]).includes(name)) throw new ConfigError(`mount name ${JSON.stringify(name)} is reserved`);
    if (name in mounts) throw new ConfigError(`mount name ${JSON.stringify(name)} is set twice`);
    if (path === "") throw new ConfigError(`mount ${JSON.stringify(name)} has an empty path`);
    mounts[name] = abs(path, from);
  }
  return mounts;
}

export function parseConfig(env: Record<string, string | undefined>, frameworkDefault: string): Config {
  const cwd = process.cwd();
  const framework = abs(env.SCHOOL_ROOT ?? frameworkDefault, cwd);
  const course = env.SCHOOL_COURSE === undefined || env.SCHOOL_COURSE === "" ? null : abs(env.SCHOOL_COURSE, cwd);
  const state = abs(env.SCHOOL_STATE ?? join(framework, "state"), cwd);

  // Learner state must not land inside the course. A course is shared; performance is not.
  if (course !== null && (state === course || state.startsWith(course + "/"))) {
    throw new ConfigError(`SCHOOL_STATE (${state}) is inside SCHOOL_COURSE (${course}); learner state must live outside the course`);
  }

  const port = Number(env.PORT ?? 4747);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT ${JSON.stringify(env.PORT)} is not a port`);

  return {
    framework,
    course,
    state,
    dbPath: env.DB_PATH === undefined || env.DB_PATH === "" ? join(state, "progress.db") : abs(env.DB_PATH, cwd),
    mounts: parseMounts(env.SCHOOL_MOUNTS, cwd),
    host: env.HOST ?? "127.0.0.1",
    port,
  };
}

/** The full mount table actually served, framework and course mounts included. */
export function mountTable(config: Config): Record<string, string> {
  const table: Record<string, string> = { assets: join(config.framework, "assets"), ...config.mounts };
  if (config.course !== null) table.reference = join(config.course, "reference");
  return table;
}
