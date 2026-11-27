// The course list (RFC 7 §5 and §7, task 4; flyingrobots/school#234): the configured courses and
// the record's current installs, served together under one namespace of names.
//
// - Configured courses come from the configuration and their course.json, read once at start
//   (`configuredCourses`); a malformed course.json stops the start, as before.
// - Installed courses come from `installed_courses()` on every read (`current`), so an install, a
//   removal or a trust choice is served on the next request with no restart, and no read serves a
//   list older than the record. Each is served from its install's folder in the course store,
//   `<SCHOOL_COURSE_STORE>/courses/<install id>/`, trusted only when the record's latest trust choice
//   for that install says so.
// - An install's folder is written once and never changed, so its content digest (RFC 7 §7) is
//   checked the first time the registry sees the install, and the answer kept for that install id.
//   That its folder still exists is checked on every read. An install with no folder, or whose files
//   are not the ones recorded, is listed with its reason and never served.
// - A name both configured and installed refuses the start (`RegistryError`, exit 2). One that
//   appears later, written to the record while School runs, is logged and the configured course
//   keeps the name.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { course, courseNames, type Config, type Course } from "./config.ts";
import { CourseFileError, readCourseFile, type CourseFile } from "./course-file.ts";
import type { InstalledCourse } from "./core/model.ts";

/** A course list School must not start with. */
export class RegistryError extends Error {}

/** What a course declares about itself beyond its title, each null when it does not (flyingrobots/school#209). */
export type Manifest = { summary: string | null; author: string | null; license: string | null; format: number | null };
/** A course School serves: where its files are, its title and manifest, and where it came from. */
export type ServedCourse = Course & { title: string; manifest: Manifest; source: "configured" | "installed" };
/** An installed course School lists but does not serve, and why, in a sentence for a person. */
export type UnavailableCourse = { name: string; title: string; trusted: boolean; manifest: Manifest; reason: string };
export type Listed = { kind: "served"; course: ServedCourse } | { kind: "unavailable"; course: UnavailableCourse };
/** One read of the course list: every listed course by name, the served ones, and a lookup. */
export type Registry = { listed: Listed[]; served: ServedCourse[]; find(name: string): Listed | null };
export type Digest = { ok: true; digest: string } | { ok: false; path: string; message: string };

const NO_MANIFEST: Manifest = { summary: null, author: null, license: null, format: null };
const manifestOf = (d: CourseFile): Manifest => ({ summary: d.summary, author: d.author, license: d.license, format: d.format });

/** The folder that holds one install's files in the course store (RFC 7 Listing 5.1). */
export function installFolder(store: string, installId: string): string {
  return join(store, "courses", installId);
}

const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * The content digest of an installed folder (RFC 7 §7): the SHA-256 of its manifest, one line per
 * file, `<sha256 of the file> <path>\n`, the path relative to the folder with `/` between names,
 * sorted by the path's UTF-8 bytes. An installed folder holds only regular files and folders, so
 * anything else (a symlink, a device) is answered with its path instead of a digest.
 */
export function contentDigest(folder: string): Digest {
  const files: { path: string; hash: string }[] = [];
  const walk = (dir: string, prefix: string): Digest | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const refused = walk(full, path);
        if (refused !== null) return refused;
      } else if (e.isFile()) {
        files.push({ path, hash: sha256(readFileSync(full)) });
      } else {
        return { ok: false, path, message: `${JSON.stringify(path)} is not a regular file or a folder; an installed course holds only those` };
      }
    }
    return null;
  };
  const refused = walk(folder, "");
  if (refused !== null) return refused;
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { ok: true, digest: sha256(files.map((f) => `${f.hash} ${f.path}\n`).join("")) };
}

/** Every configured course with its course.json read; a malformed one is a `RegistryError`. */
export function configuredCourses(config: Config): ServedCourse[] {
  return courseNames(config).map((name) => {
    const c = course(config, name)!;
    let d: CourseFile;
    try {
      d = readCourseFile(c.root);
    } catch (e) {
      if (e instanceof CourseFileError) throw new RegistryError(`course ${JSON.stringify(name)}: ${e.message}`);
      throw e;
    }
    return { ...c, title: d.title ?? name, manifest: manifestOf(d), source: "configured" };
  });
}

/** Whether `p` is a folder itself, not a symlink to one. */
function isFolder(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

type Verified = { ok: true; file: CourseFile } | { ok: false; reason: string };

/** Whether an install's folder holds exactly the files its row recorded, and its course.json if so. */
function verify(row: InstalledCourse, folder: string): Verified {
  const again = "; installing it again from its recorded source will bring it back";
  const d = contentDigest(folder);
  if (!d.ok) return { ok: false, reason: `the files of ${JSON.stringify(row.course)} have changed since it was installed (${folder}): ${d.message}${again}` };
  if (d.digest !== row.contentSha256) {
    return { ok: false, reason: `the files of ${JSON.stringify(row.course)} have changed since it was installed (${folder}): their digest is ${d.digest}, and the record's is ${row.contentSha256}${again}` };
  }
  try {
    return { ok: true, file: readCourseFile(folder) };
  } catch (e) {
    if (e instanceof CourseFileError) return { ok: false, reason: `the course.json of ${JSON.stringify(row.course)} cannot be read (${folder}): ${e.message}` };
    throw e;
  }
}

/**
 * The course list. `start` reads it the first time and refuses a name both configured and
 * installed; `current` reads it again, from the record, for each request that needs it.
 */
export function courseRegistry(opts: { config: Config; configured: ServedCourse[]; installed: () => Promise<InstalledCourse[]>; log: (line: string) => void }):
  { start(): Promise<Registry>; current(): Promise<Registry> } {
  const { config, configured, installed, log } = opts;
  const byName = new Map(configured.map((c) => [c.name, c]));
  /** Each install id's verification, made once: its folder never changes. */
  const verified = new Map<string, Verified>();
  /** Install ids already logged as shadowed by a configured course, so each is logged once. */
  const shadowed = new Set<string>();

  const read = async (starting: boolean): Promise<Registry> => {
    const listed: Listed[] = configured.map((c) => ({ kind: "served", course: c }));
    for (const row of await installed()) {
      const own = byName.get(row.course);
      if (own !== undefined) {
        const where = config.store === null ? "with no course store set" : `in the course store at ${installFolder(config.store, row.id)}`;
        const both = `course ${JSON.stringify(row.course)} is both configured${config.untrusted.includes(row.course) ? " in SCHOOL_UNTRUSTED_COURSES" : ""} (${own.root}) and installed (install ${row.id}, ${where})`;
        if (starting) throw new RegistryError(`${both}; a name means one course, so take it out of the configuration, or rename one with bun migrate.ts --rename-course while School is stopped`);
        if (!shadowed.has(row.id)) {
          shadowed.add(row.id);
          log(`${both}; serving the configured course under that name`);
        }
        continue;
      }
      const unavailable = (reason: string): Listed => ({ kind: "unavailable", course: { name: row.course, title: row.title, trusted: row.trusted, manifest: NO_MANIFEST, reason } });
      if (config.store === null) {
        listed.push(unavailable(`${JSON.stringify(row.course)} is installed, but no course store is set (SCHOOL_COURSE_STORE), so its files cannot be found`));
        continue;
      }
      const folder = installFolder(config.store, row.id);
      if (!isFolder(folder)) {
        verified.delete(row.id); // a folder put back is checked again
        listed.push(unavailable(`the files of ${JSON.stringify(row.course)} are missing from the course store (${folder}); installing it again from its recorded source will bring it back`));
        continue;
      }
      let v = verified.get(row.id);
      if (v === undefined) {
        v = verify(row, folder);
        verified.set(row.id, v);
      }
      if (!v.ok) {
        listed.push(unavailable(v.reason));
        continue;
      }
      listed.push({ kind: "served", course: {
        name: row.course, root: folder, lessons: join(folder, "lessons"), reference: join(folder, "reference"), trusted: row.trusted,
        title: row.title, manifest: manifestOf(v.file), source: "installed",
      } });
    }
    listed.sort((a, b) => (a.course.name < b.course.name ? -1 : a.course.name > b.course.name ? 1 : 0));
    const index = new Map(listed.map((l) => [l.course.name, l]));
    return {
      listed,
      served: listed.flatMap((l) => (l.kind === "served" ? [l.course] : [])),
      find: (name) => index.get(name) ?? null,
    };
  };
  return { start: () => read(true), current: () => read(false) };
}
