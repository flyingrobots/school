// Where the framework finds a course, the learner's state, and any extra source material.
// Nothing here names a subject: a course is configured, never compiled in (ADR 6).
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { withPassword } from "./secrets.ts";

/** Route prefixes the framework owns. A configured mount may not take one of these. */
export const RESERVED = ["assets", "courses", "lessons", "reference", "api"] as const;

export const NAME = /^[a-z0-9][a-z0-9-]*$/;

export type Config = {
  /** The framework checkout. Supplies `assets/` and nothing else. */
  framework: string;
  /** Registered courses by name, served at `/courses/<name>`. Each holds `lessons/` and `reference/`. */
  courses: Record<string, string>;
  /**
   * The names in `courses` that came from SCHOOL_UNTRUSTED_COURSES (flyingrobots/school#210):
   * their files are served sandboxed, so they cannot run script on School's origin.
   */
  untrusted: string[];
  /** Directory for this learner's private state. Never inside a course. */
  state: string;
  /**
   * The course store, from SCHOOL_COURSE_STORE (RFC 7 §5.1, flyingrobots/school#233): the one folder
   * School may write, for installed courses. Null when unset or empty: installing is then off.
   */
  store: string | null;
  /**
   * The SQLite progress.db of the server before Postgres. Never written now: startup only reads it,
   * to refuse to start while it holds learner work (RFC 3 v0.4.0 §3.3; server/legacy.ts).
   */
  dbPath: string;
  /** The learner's record, from SCHOOL_DATABASE_URL (server/adapters/database.ts). */
  database: Target;
  /** The built web app (web/dist), served for every path that is not the API. */
  web: string;
  /** Extra read-only mounts, served at `/<name>/...`. Source material a course cites. */
  mounts: Record<string, string>;
  host: string;
  port: number;
  /**
   * A fixed instant the server reads as now, from SCHOOL_TEST_CLOCK; null, the default, for the
   * system clock. Only for tests over HTTP that need a time-dependent answer at a known time.
   */
  clock: string | null;
};

/** Which Postgres driver holds the record, and where. */
export type Target = { driver: "pglite"; dir: string } | { driver: "postgres"; url: string };

export class ConfigError extends Error {}

/**
 * SCHOOL_DATABASE_URL: `postgres://` (or `postgresql://`) selects Bun.SQL against a Postgres
 * server, logging in as school_app (the migrate job, server/migrate.ts, gives it LOGIN); `pglite:<dir>` selects PGlite on disk, a relative dir resolving against `from`. There is
 * no default: PGlite never fsyncs, so it is not crash-durable, and a learner's record goes only
 * where it was asked to.
 */
export function parseDatabase(value: string | undefined, from: string): Target {
  if (value === undefined || value === "") {
    throw new ConfigError("SCHOOL_DATABASE_URL is not set: set it to school_app's postgres:// URL (postgres://school_app:password@host:5432/db), " +
      "or to pglite:<directory> for development and tests (not crash-durable)");
  }
  if (/^postgres(ql)?:\/\//.test(value)) {
    try {
      new URL(value);
    } catch {
      throw new ConfigError("SCHOOL_DATABASE_URL is not a valid postgres:// URL");
    }
    return { driver: "postgres", url: value };
  }
  if (value.startsWith("pglite:")) {
    const dir = value.slice("pglite:".length);
    if (dir === "" || dir.startsWith("//")) throw new ConfigError(`SCHOOL_DATABASE_URL ${JSON.stringify(value)} must be pglite:<directory>, such as pglite:/state/db`);
    return { driver: "pglite", dir: abs(dir, from) };
  }
  // Not echoed: a mistyped URL may still carry a password.
  throw new ConfigError("SCHOOL_DATABASE_URL must start with postgres://, postgresql:// or pglite:");
}

function abs(value: string, from: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(from, value);
}

/**
 * An empty name-to-path map with no prototype, so a name such as "constructor" or "__proto__" is
 * only ever its own key (flyingrobots/school#299). Look names up with `Object.hasOwn`, never `in`.
 */
function names(): Record<string, string> {
  return Object.create(null);
}

/**
 * Parse `name=path` pairs separated by commas, as used by `SCHOOL_COURSES` and
 * `SCHOOL_MOUNTS`. Relative paths resolve against `from`. Names are lowercase, become URL
 * segments, and may not shadow a route the framework owns.
 */
export function parsePairs(spec: string | undefined, from: string, label: string, reserve = true): Record<string, string> {
  const out = names();
  for (const entry of (spec ?? "").split(",")) {
    const text = entry.trim();
    if (text === "") continue;
    const eq = text.indexOf("=");
    if (eq <= 0) throw new ConfigError(`${label} entry ${JSON.stringify(text)} is not name=path`);
    const name = text.slice(0, eq).trim();
    const path = text.slice(eq + 1).trim();
    if (!NAME.test(name)) throw new ConfigError(`${label} name ${JSON.stringify(name)} must match ${NAME.source}`);
    if (reserve && (RESERVED as readonly string[]).includes(name)) throw new ConfigError(`${label} name ${JSON.stringify(name)} is reserved`);
    if (Object.hasOwn(out, name)) throw new ConfigError(`${label} name ${JSON.stringify(name)} is set twice`);
    if (path === "") throw new ConfigError(`${label} ${JSON.stringify(name)} has an empty path`);
    out[name] = abs(path, from);
  }
  return out;
}

/** Back-compatible alias; `SCHOOL_MOUNTS` is the only caller that needs the old name. */
export const parseMounts = (spec: string | undefined, from: string) => parsePairs(spec, from, "SCHOOL_MOUNTS");

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * `p` with every symlink resolved. A component that genuinely does not exist yet (a state
 * directory School will create on first run) is kept as written beneath its resolved parent.
 * A symlink whose target is missing is refused rather than read as "not there yet": its
 * target is where a write would land, and that is exactly what the containment check must
 * see. Any other failure (permissions, a loop, a file where a directory should be) is an
 * error, never a guess.
 */
function resolved(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    if (code(e) !== "ENOENT") throw new ConfigError(`cannot resolve ${p}: ${code(e) ?? String(e)}`);
  }
  let link: boolean;
  try {
    link = lstatSync(p).isSymbolicLink();
  } catch (e) {
    if (code(e) !== "ENOENT") throw new ConfigError(`cannot inspect ${p}: ${code(e) ?? String(e)}`);
    const up = dirname(p);
    return up === p ? p : join(resolved(up), basename(p));
  }
  if (link) throw new ConfigError(`${p} is a symlink whose target does not exist; create the target or remove the link`);
  throw new ConfigError(`cannot resolve ${p}`);
}

/** Whether `inner` is `outer` or below it, after resolving symlinks. */
function within(inner: string, outer: string): boolean {
  const i = resolved(inner);
  const o = resolved(outer);
  return i === o || i.startsWith(o.endsWith(sep) ? o : o + sep);
}

/** A folder's filesystem identity: what stat(2) gives as st_dev and st_ino. */
export type Stat = (path: string) => { dev: number | bigint; ino: number | bigint };

/**
 * School's own stat. It asks for bigint fields: a Number rounds an inode above 2^53, so two
 * folders could share an identity, or one folder appear as two.
 */
export const systemStat: Stat = (path) => statSync(path, { bigint: true });

/**
 * The identity of `p` (null when it does not exist yet) and of every ancestor that exists, as
 * "dev:ino" strings. Two names for one folder, such as one directory bind-mounted twice into a
 * container, resolve to two paths but share an identity (flyingrobots/school#280).
 */
function lineage(p: string, stat: Stat): { self: string | null; all: Set<string> } {
  const all = new Set<string>();
  let self: string | null = null;
  let at = resolved(p);
  for (let first = true; ; first = false) {
    try {
      const s = stat(at);
      // Exact integers either way: a bigint prints every digit, and an injected Number is taken as given.
      const id = `${BigInt(s.dev)}:${BigInt(s.ino)}`;
      all.add(id);
      if (first) self = id;
    } catch (e) {
      if (code(e) !== "ENOENT") throw new ConfigError(`cannot stat ${at}: ${code(e) ?? String(e)}`);
    }
    const up = dirname(at);
    if (up === at) return { self, all };
    at = up;
  }
}

/** Whether `a` is `b`, holds it or sits inside it by identity, whatever their paths say. */
function sameTree(a: string, b: string, stat: Stat): boolean {
  const x = lineage(a, stat);
  const y = lineage(b, stat);
  return (x.self !== null && y.all.has(x.self)) || (y.self !== null && x.all.has(y.self));
}

/** `stat` is the filesystem's identity; tests give a fake one, since aliases need a bind mount. */
export function parseConfig(env: Record<string, string | undefined>, frameworkDefault: string, stat: Stat = systemStat): Config {
  const cwd = process.cwd();
  const framework = abs(env.SCHOOL_ROOT ?? frameworkDefault, cwd);
  // SCHOOL_COURSES registers many; SCHOOL_COURSE stays accepted as a single unnamed course,
  // named after its directory, so a one-course setup needs no extra ceremony.
  const courses = parsePairs(env.SCHOOL_COURSES, cwd, "SCHOOL_COURSES");
  let single: string | undefined;
  if (env.SCHOOL_COURSE !== undefined && env.SCHOOL_COURSE !== "") {
    const path = abs(env.SCHOOL_COURSE, cwd);
    const name = basename(path).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!NAME.test(name)) throw new ConfigError(`SCHOOL_COURSE directory ${JSON.stringify(basename(path))} does not make a usable course name`);
    if ((RESERVED as readonly string[]).includes(name)) throw new ConfigError(`SCHOOL_COURSE name ${JSON.stringify(name)} is reserved; use SCHOOL_COURSES to name it`);
    if (Object.hasOwn(courses, name)) throw new ConfigError(`SCHOOL_COURSE name ${JSON.stringify(name)} collides with SCHOOL_COURSES`);
    courses[name] = path;
    single = name;
  }
  // SCHOOL_UNTRUSTED_COURSES (flyingrobots/school#210): the same name=path pairs, for courses
  // whose files must not run as School. A course is one or the other: a name in both lists, or a
  // folder that is, contains or sits inside a trusted course's, is refused, because the trusted
  // course would serve the same bytes unsandboxed.
  const untrusted = parsePairs(env.SCHOOL_UNTRUSTED_COURSES, cwd, "SCHOOL_UNTRUSTED_COURSES");
  for (const [name, path] of Object.entries(untrusted)) {
    if (Object.hasOwn(courses, name)) {
      throw new ConfigError(`course ${JSON.stringify(name)} is in both ${name === single ? "SCHOOL_COURSE" : "SCHOOL_COURSES"} and SCHOOL_UNTRUSTED_COURSES; a course is trusted or untrusted, not both`);
    }
    for (const [other, root] of Object.entries(courses)) {
      if (within(path, root) || within(root, path)) {
        throw new ConfigError(`untrusted course ${JSON.stringify(name)} (${path}) overlaps trusted course ${JSON.stringify(other)} (${root}); a folder is trusted or untrusted, not both`);
      }
    }
  }
  // A mount or the web app's folder is served with no sandbox, so neither may be, contain or sit
  // inside an untrusted course's folder: it would serve that course's files as School.
  const mounts = parseMounts(env.SCHOOL_MOUNTS, cwd);
  const web = abs(env.SCHOOL_WEB ?? join(framework, "web", "dist"), cwd);
  const served: [string, string][] = [...Object.entries(mounts).map(([m, path]): [string, string] => [`SCHOOL_MOUNTS mount ${JSON.stringify(m)}`, path]), ["SCHOOL_WEB", web]];
  for (const [name, path] of Object.entries(untrusted)) {
    for (const [what, folder] of served) {
      if (within(folder, path) || within(path, folder)) {
        throw new ConfigError(`${what} (${folder}) overlaps untrusted course ${JSON.stringify(name)} (${path}) from SCHOOL_UNTRUSTED_COURSES; it would serve the course's files unsandboxed`);
      }
    }
  }
  // The same rules by identity (flyingrobots/school#280): compose bind-mounts the course folder at
  // /course and, by default, again at /library, and realpath cannot see that those are one folder.
  const roots: [string, string][] = [
    ...Object.entries(courses).map(([other, root]): [string, string] => [`trusted course ${JSON.stringify(other)} (${root}) from ${other === single ? "SCHOOL_COURSE" : "SCHOOL_COURSES"}`, root]),
    ...served.map(([what, folder]): [string, string] => [`${what} (${folder})`, folder]),
  ];
  for (const [name, path] of Object.entries(untrusted)) {
    for (const [what, root] of roots) {
      if (sameTree(path, root, stat)) {
        throw new ConfigError(`untrusted course ${JSON.stringify(name)} (${path}) from SCHOOL_UNTRUSTED_COURSES and ${what} are the same folder under two names, or one holds the other (same device and inode, as when Docker bind-mounts one folder twice); a folder is trusted or untrusted, not both`);
      }
    }
  }
  Object.assign(courses, untrusted);
  const state = abs(env.SCHOOL_STATE ?? join(framework, "state"), cwd);

  const dbPath = env.DB_PATH === undefined || env.DB_PATH === "" ? join(state, "progress.db") : abs(env.DB_PATH, cwd);
  // Under compose the URL names school_app and the host, and the password is a file
  // (SCHOOL_DATABASE_PASSWORD_FILE, read by withSecretFiles in server/secrets.ts).
  const database = parseDatabase(withPassword(env.SCHOOL_DATABASE_URL, env.SCHOOL_DATABASE_PASSWORD, "SCHOOL_DATABASE_URL", "SCHOOL_DATABASE_PASSWORD"), cwd);

  // Learner state must not land inside any course. A course is shared; performance is not.
  // Compared on resolved paths, so a symlink cannot smuggle state into a course.
  for (const [name, path] of Object.entries(courses)) {
    if (within(state, path)) {
      throw new ConfigError(`SCHOOL_STATE (${state}) is inside course ${JSON.stringify(name)} (${path}); learner state must live outside the course`);
    }
    if (within(dbPath, path)) {
      throw new ConfigError(`DB_PATH (${dbPath}) is inside course ${JSON.stringify(name)} (${path}); learner state must live outside the course`);
    }
    if (database.driver === "pglite" && within(database.dir, path)) {
      throw new ConfigError(`SCHOOL_DATABASE_URL puts the record (${database.dir}) inside course ${JSON.stringify(name)} (${path}); learner state must live outside the course`);
    }
  }

  // The course store (RFC 7 §5.1, flyingrobots/school#233): the one folder School may write, which
  // holds installed courses and nothing else. Courses, learner state, mounts and the web app each
  // keep their own folder, so the store may not be, hold or sit inside any of them, compared on
  // real paths and then by identity, as the untrusted checks above are.
  const store = env.SCHOOL_COURSE_STORE === undefined || env.SCHOOL_COURSE_STORE === "" ? null : abs(env.SCHOOL_COURSE_STORE, cwd);
  if (store !== null) {
    if (existsSync(store) && !statSync(store).isDirectory()) throw new ConfigError(`SCHOOL_COURSE_STORE (${store}) exists but is not a folder; the course store is a folder`);
    const apart: [string, string][] = [
      [`the framework (${framework}), which holds the server source`, framework],
      ...Object.entries(courses).map(([name, root]): [string, string] => [Object.hasOwn(untrusted, name)
        ? `untrusted course ${JSON.stringify(name)} (${root}) from SCHOOL_UNTRUSTED_COURSES`
        : `trusted course ${JSON.stringify(name)} (${root}) from ${name === single ? "SCHOOL_COURSE" : "SCHOOL_COURSES"}`, root]),
      [`SCHOOL_STATE (${state})`, state],
      [`DB_PATH (${dbPath})`, dbPath],
      ...(database.driver === "pglite" ? [[`the record in SCHOOL_DATABASE_URL (${database.dir})`, database.dir] as [string, string]] : []),
      ...served.map(([what, folder]): [string, string] => [`${what} (${folder})`, folder]),
    ];
    const why = "the course store holds installed courses only, apart from every course, learner state, mount and the web app";
    for (const [what, folder] of apart) {
      if (within(store, folder) || within(folder, store)) throw new ConfigError(`SCHOOL_COURSE_STORE (${store}) overlaps ${what}; ${why}`);
    }
    for (const [what, folder] of apart) {
      if (sameTree(store, folder, stat)) {
        throw new ConfigError(`SCHOOL_COURSE_STORE (${store}) and ${what} are the same folder under two names, or one holds the other (same device and inode, as when Docker bind-mounts one folder twice); ${why}`);
      }
    }
  }

  const port = Number(env.PORT ?? 4747);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT ${JSON.stringify(env.PORT)} is not a port`);

  return {
    framework,
    courses,
    untrusted: Object.keys(untrusted).sort(),
    state,
    store,
    dbPath,
    database,
    web,
    mounts,
    host: env.HOST ?? "127.0.0.1",
    port,
    clock: null,
  };
}

/** Top-level static mounts: the framework's assets plus any configured source material. */
export function mountTable(config: Config): Record<string, string> {
  return Object.assign(names(), config.mounts);
}

/** `trusted` is false for a course from SCHOOL_UNTRUSTED_COURSES (flyingrobots/school#210). */
export type Course = { name: string; root: string; lessons: string; reference: string; trusted: boolean };

export function course(config: Config, name: string): Course | null {
  const root = Object.hasOwn(config.courses, name) ? config.courses[name] : undefined;
  if (root === undefined) return null;
  return { name, root, lessons: join(root, "lessons"), reference: join(root, "reference"), trusted: !config.untrusted.includes(name) };
}

export function courseNames(config: Config): string[] {
  return Object.keys(config.courses).sort();
}
