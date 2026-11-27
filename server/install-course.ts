// Installing a previewed course (RFC 7 §4 stages 4 and 5, §5.1 and §5.2; task 8, flyingrobots/school#238).
//
// `installPreviewed` takes a request's body, `{preview, name}` and nothing else. The preview is one
// `previewInstall` (server/install-preview.ts) staged in `<store>/staging/<preview id>/course/` and
// remembered in the server's memory (`previews`): the URL, the full commit, when it expires and the
// content digest of `course/` as checked. None of that is read from disk. In order:
//
// 1. The name must be a course name (`CourseName`: the rule and reserved names of server/config.ts),
//    and neither a configured course's nor a current install's. A refused name keeps the preview, so
//    the learner can choose another.
// 2. The preview must be one this process staged and still remembers, or it is `unknown-preview`;
//    an expired one is deleted and forgotten. Its `staging/`, its folder and its `course/` must be
//    real folders (lstat; no symlink is followed), or it is `unknown-preview`.
// 3. The preview is forgotten, so it is spent, and `course/` is moved (one rename, in the same
//    store) to a new folder `courses/<install id>/`, and the rest of the preview deleted.
//    `courses/` must be a real folder, and the install's folder must not exist. After the rename,
//    `courses/<install id>` must be a real folder by lstat: a `course/` swapped for a symlink after
//    step 2 is moved as the symlink, which is removed, never followed, and the install is `changed`.
// 4. The moved folder is checked again where it now lies, so nothing changed in staging after the
//    preview's check is installed: it holds only course.json, lessons/*.json and reference/**, only
//    regular files with one link each (no hard link to a file elsewhere) and folders, within RFC 7
//    Table 6.2's limits (`DEFAULT_LIMITS`), sizes read with lstat before any file is; its content
//    digest is the one the preview remembered; and it passes `checkCourse`, which also gives the
//    title and format the row records.
// 5. Every file is made read-only (RFC 7 §5.1), and the install recorded (`school.install_course`)
//    with the URL and commit the preview remembered, untrusted, since no trust choice names it yet.
//
// Any refusal or failure after step 3 deletes the moved folder. The course list
// (server/course-registry.ts) serves an install only once the record names it, so a folder in
// `courses/` is never served before it is recorded; a crash between the move and the record leaves
// a folder no row names, which `sweepCourses` deletes at the next start.
//
// These checks hold against a change made to staging before each one runs. They are not a lock: a
// process that can write the course store can still change a file between the check of step 4 and
// the record, which is then recorded with step 4's digest, or change `courses/` after the install;
// the course list's fingerprint and digest find either (docs/topics/architecture/README.md, the
// course list). Just before step 5 the install's folder is lstat'ed again and must have the device
// and inode the rename gave it, or the install is `changed` and nothing there is removed. Step 5 opens each file without following a symlink and changes it only while it has
// one link, but a folder swapped for a symlink between step 4 and step 5 is followed, and the files
// it leads to are made read-only. What memory holds (the URL, commit and digest) no write to the
// store can change.
//
// `courseInstaller` runs one install at a time, so two installs of one preview, or of one name, do
// not race between the name check and the record: the second sees what the first did. One School
// process writes one store; the record's own answer covers anything else.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { checkCourse } from "./check-course.ts";
import { CourseInstall, CourseName, type InstallResult } from "./core/model.ts";
import { contentDigest, installFolder } from "./course-registry.ts";
import { DEFAULT_LIMITS, type Limits } from "./extract-tree.ts";
import type { Previews } from "./install-preview.ts";

/** What an install reads and writes besides the staged preview. */
export type InstallSources = {
  /** The course store, `SCHOOL_COURSE_STORE`. */
  store: string;
  /** Every configured course's name. */
  configured: readonly string[];
  /** Every current install's name. */
  installedNames: () => Promise<string[]>;
  /** Records the install; it becomes the name's current install (`school.install_course`). */
  record: (install: CourseInstall) => Promise<InstallResult>;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** A new install id, a UUID. */
  newId: () => string;
  /** The server's memory of the previews it staged (`previewInstall`); an install forgets the one it takes. */
  previews: Previews;
  /** RFC 7 Table 6.2's limits, for tests to lower; `DEFAULT_LIMITS` otherwise. */
  limits?: Partial<Limits>;
};

/**
 * Why an install was refused. `bad-name` and `name-taken` keep the preview; `unknown-preview` found
 * none to take; every other reason spends it: `expired`, `changed` (its files are not what the
 * preview checked), `over-limit`, `invalid-course`, and `not-recorded` (the record refused it).
 */
export type InstallReason = "bad-name" | "name-taken" | "unknown-preview" | "expired" | "changed" | "over-limit" | "invalid-course" | "not-recorded";
export type InstallAnswer =
  | { status: "installed"; install: string; course: string; url: string; commit: string; trusted: false }
  | { status: "refused"; reason: InstallReason; message: string }
  | { status: "invalid"; error: string };

const INSTALL_STATUS: Record<InstallReason, number> = {
  "bad-name": 422, "name-taken": 409, "unknown-preview": 404, expired: 410, changed: 409, "over-limit": 422, "invalid-course": 422, "not-recorded": 409,
};

/** The HTTP status `POST /api/installs` answers with: 201 for an install, 400 for a body that is not an install request, and the reason's own for a refusal. */
export function installStatus(answer: InstallAnswer): number {
  return answer.status === "installed" ? 201 : answer.status === "invalid" ? 400 : INSTALL_STATUS[answer.reason];
}

/** The body, exactly: a preview id as previewInstall makes them (a lowercase UUID) and a name, and no other field. */
const InstallRequest = z.object({
  preview: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  name: z.string().max(255),
}).strict();

const refused = (reason: InstallReason, message: string): InstallAnswer => ({ status: "refused", reason, message });

/** What lstat says `p` is, without following a symlink; null when nothing is there. */
function kind(p: string): "folder" | "file" | "other" | null {
  try {
    const s = lstatSync(p);
    return s.isDirectory() ? "folder" : s.isFile() ? "file" : "other";
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return null;
    throw e;
  }
}

/** The first problem with the installed folder's shape and size, or null: only what School installs, only regular files with one link each and folders, within `limits`. */
function shapeProblem(folder: string, limits: Limits): { reason: "changed" | "over-limit"; message: string } | null {
  let files = 0;
  let total = 0;
  const walk = (dir: string, prefix: string, depth: number): { reason: "changed" | "over-limit"; message: string } | null => {
    for (const name of readdirSync(dir)) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const s = lstatSync(join(dir, name));
      const allowed = s.isDirectory()
        ? path === "lessons" || path === "reference" || path.startsWith("reference/")
        : s.isFile() && (path === "course.json" || (prefix === "lessons" && name.endsWith(".json")) || path.startsWith("reference/"));
      if (!allowed) return { reason: "changed", message: `${JSON.stringify(path)} is not one of the files the preview checked` };
      // A hard link shares its inode with a file elsewhere, which the read-only step would change.
      if (s.isFile() && s.nlink !== 1) return { reason: "changed", message: `${JSON.stringify(path)} is linked to a file outside the course` };
      if (Buffer.byteLength(path) > limits.pathBytes) return { reason: "over-limit", message: `${JSON.stringify(path)} is longer than ${limits.pathBytes} bytes` };
      if (s.isDirectory()) {
        if (depth + 1 > limits.depth) return { reason: "over-limit", message: `${JSON.stringify(path)} is more than ${limits.depth} folders deep` };
        const inner = walk(join(dir, name), path, depth + 1);
        if (inner !== null) return inner;
        continue;
      }
      if (++files > limits.files) return { reason: "over-limit", message: `the course holds more than ${limits.files} files` };
      if (s.size > limits.fileBytes) return { reason: "over-limit", message: `${JSON.stringify(path)} is larger than ${limits.fileBytes} bytes` };
      total += s.size;
      if (total > limits.totalBytes) return { reason: "over-limit", message: `the course's files together are larger than ${limits.totalBytes} bytes` };
    }
    return null;
  };
  return walk(folder, "", 0);
}

/**
 * Makes every file under `dir` read-only; folders stay writable, so the start sweep can delete them.
 * Each file is opened without following a symlink, and changed only if it is still a regular file
 * with one link, so a symlink or hard link put there after the check makes the install fail instead
 * of changing a file elsewhere. A folder swapped for a symlink after its entry was listed is still
 * followed (Node has no openat); the header says what that leaves.
 */
function readOnly(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      readOnly(p);
      continue;
    }
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1) throw new Error(`${p} changed after the install checked it`);
      fchmodSync(fd, 0o444);
    } finally {
      closeSync(fd);
    }
  }
}

/** Installs one staged preview under a name. See the header for each step. */
export async function installPreviewed(body: unknown, sources: InstallSources): Promise<InstallAnswer> {
  const parsed = InstallRequest.safeParse(body);
  if (!parsed.success) return { status: "invalid", error: "an install takes {\"preview\": ..., \"name\": ...}: the id a preview answered and the course's name, and nothing else" };
  const { preview, name } = parsed.data;

  // 1. The name.
  if (!CourseName.safeParse(name).success) {
    return refused("bad-name", `${JSON.stringify(name)} cannot name a course: a name is lowercase letters, digits and hyphens, starts with a letter or digit, and is none of assets, courses, lessons, reference or api`);
  }
  if (sources.configured.includes(name)) return refused("name-taken", `a configured course is already called ${JSON.stringify(name)}; would another name suit this one?`);
  if ((await sources.installedNames()).includes(name)) return refused("name-taken", `an installed course is already called ${JSON.stringify(name)}; would another name suit this one?`);

  // 2. The preview, as this process staged it.
  const gone = refused("unknown-preview", `School holds no preview ${preview}; it may have been installed already, or deleted when School restarted. Would you like to preview the course again?`);
  const kept = sources.previews.get(preview);
  if (kept === undefined) return gone;
  const staging = join(sources.store, "staging");
  const folder = join(staging, preview);
  const course = join(folder, "course");
  if (kept.expires <= sources.now()) {
    sources.previews.delete(preview);
    if (kind(staging) === "folder") rmSync(folder, { recursive: true, force: true });
    return refused("expired", `preview ${preview} expired at ${new Date(kept.expires).toISOString()}, so it was deleted. Would you like to preview the course again?`);
  }
  if (kind(staging) !== "folder" || kind(folder) !== "folder" || kind(course) !== "folder") return gone;

  // 3. The move. From here the preview is spent.
  sources.previews.delete(preview);
  const courses = join(sources.store, "courses");
  mkdirSync(courses, { recursive: true });
  if (kind(courses) !== "folder") throw new Error("the course store's courses/ is not a folder; School installs nothing through it");
  const id = sources.newId();
  const dest = installFolder(sources.store, id);
  if (kind(dest) !== null) throw new Error(`install ${id} already has a folder in the course store's courses/`);
  try {
    renameSync(course, dest);
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return gone; // taken by an install running beside this one
    throw e;
  }
  rmSync(folder, { recursive: true, force: true });

  let recorded = false;
  // False once `dest` is no longer the folder the rename made: what is there then is not the
  // install's to delete.
  let ours = true;
  try {
    // 4. The folder, checked where it now lies: a real folder (a symlink moved here is removed in
    // the finally below, which deletes the link and never what it points at), then its contents.
    const moved = lstatSync(dest);
    if (!moved.isDirectory()) return refused("changed", `preview ${preview} is not as School left it, so the course was not installed. Would you like to preview it again?`);
    const shape = shapeProblem(dest, { ...DEFAULT_LIMITS, ...sources.limits });
    if (shape !== null) return refused(shape.reason, `${shape.message}, so the course was not installed`);
    const digest = contentDigest(dest);
    if (!digest.ok || digest.digest !== kept.contentSha256) {
      return refused("changed", `the course's files changed after preview ${preview} checked them, so it was not installed. Would you like to preview it again?`);
    }
    const check = checkCourse(dest);
    if (!check.ok) return refused("invalid-course", `School can't play this course: ${check.message.replaceAll(dest, ".")}`);
    const install = CourseInstall.safeParse({
      id, course: name, source: "git", url: kept.url, bundleSha256: null, commit: kept.commit,
      contentSha256: digest.digest, title: check.title ?? name, format: check.manifest.format,
    });
    if (!install.success) throw new Error(`preview ${preview} remembered a URL and commit School cannot record: ${install.error.message}`);

    // 5. Read-only, then the record: only now can the course list serve it. The folder must still be
    // the one the rename made (same device and inode), or something swapped it since step 4's check:
    // what is there now is not the install's, so nothing is recorded and nothing there is removed.
    const now = lstatSync(dest, { throwIfNoEntry: false });
    if (now === undefined || now.dev !== moved.dev || now.ino !== moved.ino) {
      ours = false;
      return refused("changed", `the course's folder was replaced after preview ${preview} was checked, so it was not installed. Would you like to preview it again?`);
    }
    readOnly(dest);
    const result = await sources.record(install.data);
    if (result.status !== "installed" && result.status !== "updated" && result.status !== "duplicate") {
      return refused("not-recorded", `the record did not take the install (${result.status}), so the course was not installed`);
    }
    recorded = true;
    return { status: "installed", install: id, course: name, url: kept.url, commit: kept.commit, trusted: false };
  } finally {
    if (!recorded && ours) rmSync(dest, { recursive: true, force: true });
  }
}

/** `installPreviewed` over `sources`, one install at a time (see the header). */
export function courseInstaller(sources: InstallSources): (body: unknown) => Promise<InstallAnswer> {
  let queue: Promise<unknown> = Promise.resolve();
  return (body) => {
    const next = queue.then(() => installPreviewed(body, sources));
    queue = next.catch(() => {});
    return next;
  };
}

/**
 * Deletes every entry of `<store>/courses/` that is not the folder of an install in `current`, as
 * School does at start (RFC 7 §5.1): a crash between an install's move and its record leaves such a
 * folder. A symlink is removed, never followed; a `courses/` that is not a real folder is not swept.
 * Nothing else in the store is touched.
 */
export function sweepCourses(store: string, current: ReadonlySet<string>): void {
  const courses = join(store, "courses");
  if (kind(courses) !== "folder") return;
  for (const name of readdirSync(courses)) {
    const entry = join(courses, name);
    const k = kind(entry);
    if (k === "folder" && current.has(name)) continue;
    if (k === "folder") rmSync(entry, { recursive: true, force: true });
    else if (k !== null) unlinkSync(entry);
  }
}
