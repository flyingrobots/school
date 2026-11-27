// Where the framework finds a course, the learner's state, and any extra source material.
// Nothing here names a subject: a course is configured, never compiled in (ADR 6).
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
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
   * The school skill's folder, from SCHOOL_SKILL (RFC 9 §5.3, flyingrobots/school#257): what an
   * authoring agent is given as its instructions. Null when SCHOOL_SKILL is empty: authoring is then off.
   */
  skill: string | null;
  /** The folder holding the references the skill links, `course-format/` and `voice/`, from SCHOOL_SKILL_DOCS. */
  skillDocs: string;
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
 * School's own lstat, for the files a walk lists (flyingrobots/school#315): it never follows a
 * symlink, so a file swapped for a link after it was listed gives the link's own identity.
 */
export const systemLstat: Stat = (path) => lstatSync(path, { bigint: true });

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
    const id = identity(at, stat);
    if (id !== null) all.add(id);
    if (first) self = id;
    const up = dirname(at);
    if (up === at) return { self, all };
    at = up;
  }
}

/** The "dev:ino" identity of `at`, or null when it does not exist. */
function identity(at: string, stat: Stat): string | null {
  try {
    const s = stat(at);
    // Exact integers either way: a bigint prints every digit, and an injected Number is taken as given.
    return `${BigInt(s.dev)}:${BigInt(s.ino)}`;
  } catch (e) {
    if (code(e) !== "ENOENT") throw new ConfigError(`cannot stat ${at}: ${code(e) ?? String(e)}`);
    return null;
  }
}

/**
 * The most folders School walks below one course, mount or web folder (flyingrobots/school#298).
 * A course holds lessons/ and reference/ and a few folders under them: the example course holds 2,
 * and a course of 2,000 reference files in 100 topics about 100. 10,000 is far past any course. Each
 * folder costs one readdir and one stat, so the cap bounds a walk to about a quarter of a second on
 * a local SSD, and a folder that is not a course, such as a home directory or a whole disk, is
 * refused at once instead of walked for minutes.
 */
export const FOLDER_CAP = 10_000;

/**
 * The most regular files School walks below one course, mount or web folder (flyingrobots/school#315).
 * Counted apart from folders, so a source mount of many files in few folders, accepted while only
 * folders were walked, is still accepted. Each file costs one lstat, about 1.4 µs on a local SSD.
 */
export const FILE_CAP = 100_000;

/**
 * The entries directly inside `dir` that School walks: its folders and its regular files, by name.
 * Never a symlink, whatever it points at, and nothing else (a socket, a pipe, a device).
 */
export type List = (dir: string) => { dirs: string[]; files: string[] };

/**
 * School's own list. A symlink is never a folder or a file here: the server never serves through a
 * symlink that leaves the folder it serves (serveFrom compares real paths), so following one would
 * only refuse setups that are safe, or loop. A filesystem that does not say an entry's type is
 * asked with lstat, which does not follow links either.
 */
export const systemList: List = (dir) => {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) dirs.push(d.name);
    else if (d.isFile()) files.push(d.name);
    else if (!d.isSymbolicLink() && !d.isFIFO() && !d.isSocket() && !d.isBlockDevice() && !d.isCharacterDevice()) {
      // The type is unknown (DT_UNKNOWN): lstat says what the entry is, without following it.
      const l = lstatSync(join(dir, d.name));
      if (l.isDirectory()) dirs.push(d.name);
      else if (l.isFile()) files.push(d.name);
    }
  }
  return { dirs, files };
};

/**
 * Every folder and regular file at or below `root`, by identity, with the path it was first found
 * at. Walked breadth-first through `list`, so never through a symlink; a folder seen twice (a bind
 * mount of an ancestor inside its own tree) is walked once, and a file with two names (a hard link)
 * is kept under the first. A listed file's identity comes from `lstat`, so a file swapped for a
 * symlink after it was listed is read as the link, never followed. An entry School cannot list or
 * stat is refused, not skipped, since what it hides could be an alias; one that is gone, or is no
 * folder, holds nothing. Refused, naming `what`, the cap and saying to `remedy`, past FOLDER_CAP
 * folders or FILE_CAP files below the root.
 */
function tree(root: string, what: string, remedy: string, stat: Stat, lstat: Stat, list: List): Map<string, string> {
  const found = new Map<string, string>();
  const queue = [resolved(root)];
  let files = 0;
  const capped = (count: string, cap: string) =>
    new ConfigError(`${what} holds more than ${count}, the ${cap} cap. With SCHOOL_UNTRUSTED_COURSES set, School walks every folder and file of each course, mount and the web folder at start, to find one that is both trusted and untrusted under two names, and walks at most ${FOLDER_CAP} folders and ${FILE_CAP} files in each. To start, ${remedy}`);
  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i]!;
    const id = identity(dir, stat);
    if (id === null || found.has(id)) continue;
    found.set(id, dir);
    let names: { dirs: string[]; files: string[] };
    try {
      names = list(dir);
    } catch (e) {
      if (code(e) === "ENOENT" || code(e) === "ENOTDIR") continue;
      throw new ConfigError(`cannot list ${dir} in ${what}: ${code(e) ?? String(e)}`);
    }
    if (queue.length - 1 + names.dirs.length > FOLDER_CAP) throw capped(`${FOLDER_CAP} folders`, "folder");
    files += names.files.length;
    if (files > FILE_CAP) throw capped(`${FILE_CAP} files`, "file");
    for (const name of names.dirs) queue.push(join(dir, name));
    for (const name of names.files) {
      const file = join(dir, name);
      const fileId = identity(file, lstat);
      if (fileId !== null && !found.has(fileId)) found.set(fileId, file);
    }
  }
  return found;
}

/** Whether `a` is `b`, holds it or sits inside it by identity, whatever their paths say. */
function sameTree(a: string, b: string, stat: Stat): boolean {
  const x = lineage(a, stat);
  const y = lineage(b, stat);
  return (x.self !== null && y.all.has(x.self)) || (y.self !== null && x.all.has(y.self));
}

/**
 * `stat` is the filesystem's identity, `list` names a folder's subfolders and regular files
 * (flyingrobots/school#298), and `lstat` is the identity of a listed file without following a
 * symlink (flyingrobots/school#315); tests give fake ones, since aliases need a bind mount.
 */
export function parseConfig(env: Record<string, string | undefined>, frameworkDefault: string, stat: Stat = systemStat, list: List = systemList, lstat: Stat = systemLstat): Config {
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
  // Part of one bind-mounted elsewhere (flyingrobots/school#298): at a bind mount's root ".." leaves
  // the trusted tree, so the ancestors above cannot show that /library is a trusted course's
  // reference/. Every folder and file of each trusted root is collected by identity instead, and an
  // untrusted course whose folder or an ancestor has one of them is refused. Each untrusted course
  // is walked the same way (flyingrobots/school#315), and refused when any folder or file below it
  // has the identity of one in a trusted root: one of its files or subfolders bind-mounted into a
  // trusted folder, or one of theirs into it, or a file hard-linked into both. Two names for one
  // file inside one course, or across two untrusted courses, keep one trust and are accepted.
  // Walked only when there is an untrusted course to protect, so a setup without one starts as before.
  if (Object.keys(untrusted).length > 0) {
    const guests = Object.entries(untrusted).map(([name, path]) => {
      const what = `untrusted course ${JSON.stringify(name)} (${path}) from SCHOOL_UNTRUSTED_COURSES`;
      return { name, path, what, ids: lineage(path, stat).all, inside: tree(path, what, `remove it from SCHOOL_UNTRUSTED_COURSES, or point it at a folder holding fewer`, stat, lstat, list) };
    });
    for (const [what, root] of roots) {
      const variable = /SCHOOL_[A-Z_]+/.exec(what)?.[0] ?? "the variable named above";
      const inside = tree(root, what, `unset SCHOOL_UNTRUSTED_COURSES, or point ${variable} at a folder holding fewer`, stat, lstat, list);
      for (const guest of guests) {
        for (const id of guest.ids) {
          const at = inside.get(id);
          if (at !== undefined) {
            throw new ConfigError(`${guest.what} is, or sits inside, ${at} in ${what} under another name (same device and inode, as when Docker bind-mounts part of a folder); a folder is trusted or untrusted, not both`);
          }
        }
        for (const [id, own] of guest.inside) {
          const at = inside.get(id);
          if (at !== undefined) {
            throw new ConfigError(`${guest.what} holds ${own}, which is ${at} in ${what} under another name (same device and inode, as when Docker bind-mounts a file or folder of one inside the other, or a file is hard-linked into both); a file or folder is trusted or untrusted, not both`);
          }
        }
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

  // A fixed clock for tests over HTTP (flyingrobots/school#220). Refused on a postgres:// record, so
  // a learner's record is never written at a time that is not now.
  const clockValue = env.SCHOOL_TEST_CLOCK === undefined || env.SCHOOL_TEST_CLOCK === "" ? null : env.SCHOOL_TEST_CLOCK;
  let clock: string | null = null;
  if (clockValue !== null) {
    if (database.driver !== "pglite") throw new ConfigError("SCHOOL_TEST_CLOCK is for tests: it fixes the server's clock, so it is refused unless SCHOOL_DATABASE_URL is pglite:<directory>");
    const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(clockValue) ? Date.parse(clockValue) : NaN;
    if (Number.isNaN(instant)) {
      throw new ConfigError(`SCHOOL_TEST_CLOCK ${JSON.stringify(clockValue)} is not an instant: give a date, a time and a zone, as 2026-01-03T10:00:00Z`);
    }
    clock = new Date(instant).toISOString();
  }

  // The school skill an authoring agent is given, and the references it links (RFC 9 §5.3,
  // flyingrobots/school#257): this checkout's by default; compose mounts them under /framework.
  // Whether they are there is reported at start (server/skill.ts), never a refusal to start.
  const skill = env.SCHOOL_SKILL === "" ? null : abs(env.SCHOOL_SKILL ?? join(framework, ".agents", "skills", "school"), cwd);
  const skillDocs = abs(env.SCHOOL_SKILL_DOCS || join(framework, "docs", "topics"), cwd);

  const port = Number(env.PORT ?? 4747);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT ${JSON.stringify(env.PORT)} is not a port`);

  return {
    framework,
    courses,
    untrusted: Object.keys(untrusted).sort(),
    state,
    store,
    skill,
    skillDocs,
    dbPath,
    database,
    web,
    mounts,
    host: env.HOST ?? "127.0.0.1",
    port,
    clock,
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
