// Installing a previewed course (RFC 7 §4 stages 4 and 5, §5.1 and §5.2; task 8, flyingrobots/school#238).
//
// `installPreviewed` takes a request's body, `{preview, name}` and nothing else. The preview is one
// `previewInstall` (server/install-preview.ts) staged in `<store>/staging/<preview id>/`: its checked
// `course/` and `preview.json`, which holds the URL, the full commit, when it expires and the content
// digest of `course/`. In order:
//
// 1. The name must be a course name (`CourseName`: the rule and reserved names of server/config.ts),
//    and neither a configured course's nor a current install's. A refused name keeps the preview, so
//    the learner can choose another.
// 2. The preview must still be there, as School left it: `staging/`, the preview's folder and its
//    `course/` real folders and `preview.json` a real file (no symlink is followed out of the store),
//    `preview.json` well formed and not expired. An expired preview is deleted.
// 3. `course/` is moved (one rename, in the same store) to a new folder `courses/<install id>/`, and
//    the rest of the preview deleted: from here the preview is spent. `courses/` must be a real
//    folder, and the install's folder must not exist.
// 4. The moved folder is checked again where it now lies, so nothing changed in staging after the
//    preview's check is installed: it holds only course.json, lessons/*.json and reference/**, only
//    regular files and folders, within RFC 7 Table 6.2's limits (`DEFAULT_LIMITS`), sizes read with
//    lstat before any file is; its content digest is the one `preview.json` recorded; and it passes
//    `checkCourse`, which also gives the title and format the row records.
// 5. Every file is made read-only (RFC 7 §5.1), and the install recorded (`school.install_course`),
//    untrusted, since no trust choice names it yet.
//
// Any refusal or failure after step 3 deletes the moved folder. The course list
// (server/course-registry.ts) serves an install only once the record names it, so a folder in
// `courses/` is never served before it is recorded; a crash between the move and the record leaves
// a folder no row names, which `sweepCourses` deletes at the next start.
//
// `courseInstaller` runs one install at a time, so two installs of one preview, or of one name, do
// not race between the name check and the record: the second sees what the first did. One School
// process writes one store; the record's own answer covers anything else.
import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { checkCourse } from "./check-course.ts";
import { CourseInstall, CourseName, type InstallResult } from "./core/model.ts";
import { contentDigest, installFolder } from "./course-registry.ts";
import { DEFAULT_LIMITS, type Limits } from "./extract-tree.ts";
import { PreviewFile } from "./install-preview.ts";

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
  /** RFC 7 Table 6.2's limits, for tests to lower; `DEFAULT_LIMITS` otherwise. */
  limits?: Partial<Limits>;
};

/**
 * Why an install was refused. `bad-name` and `name-taken` keep the preview; `unknown-preview` found
 * none to take; every other reason spends it: `expired`, `changed` (its files or preview.json are not
 * what the preview checked), `over-limit`, `invalid-course`, and `not-recorded` (the record refused it).
 */
export type InstallReason = "bad-name" | "name-taken" | "unknown-preview" | "expired" | "changed" | "over-limit" | "invalid-course" | "not-recorded";
export type InstallAnswer =
  | { status: "installed"; install: string; course: string; url: string; commit: string; trusted: false }
  | { status: "refused"; reason: InstallReason; message: string }
  | { status: "invalid"; error: string };

/** The body, exactly: a preview id as previewInstall makes them (a lowercase UUID) and a name, and no other field. */
const InstallRequest = z.object({
  preview: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  name: z.string().max(255),
}).strict();

/** preview.json is a few hundred bytes; anything much larger is not one School wrote. */
const PREVIEW_FILE_BYTES = 64 * 1024;

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

/** The first problem with the installed folder's shape and size, or null: only what School installs, only regular files and folders, within `limits`. */
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

/** Makes every file under `dir` read-only; folders stay writable, so the start sweep can delete them. */
function readOnly(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) readOnly(p);
    else chmodSync(p, 0o444);
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

  // 2. The preview, as School left it.
  const gone = refused("unknown-preview", `School holds no preview ${preview}; it may have been installed already, or deleted when School restarted. Would you like to preview the course again?`);
  const staging = join(sources.store, "staging");
  const folder = join(staging, preview);
  const course = join(folder, "course");
  const file = join(folder, "preview.json");
  if (kind(staging) !== "folder" || kind(folder) !== "folder" || kind(course) !== "folder" || kind(file) !== "file") return gone;
  let kept: PreviewFile;
  try {
    if (lstatSync(file).size > PREVIEW_FILE_BYTES) throw new Error("too large");
    kept = PreviewFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    rmSync(folder, { recursive: true, force: true });
    return refused("changed", `preview ${preview} is not as School left it, so it was deleted. Would you like to preview the course again?`);
  }
  if (Date.parse(kept.expires) <= sources.now()) {
    rmSync(folder, { recursive: true, force: true });
    return refused("expired", `preview ${preview} expired at ${kept.expires}, so it was deleted. Would you like to preview the course again?`);
  }

  // 3. The move.
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
  try {
    // 4. The folder, checked where it now lies.
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
    if (!install.success) return refused("changed", `preview ${preview} does not name an https URL and a full commit, so the course was not installed`);

    // 5. Read-only, then the record: only now can the course list serve it.
    readOnly(dest);
    const result = await sources.record(install.data);
    if (result.status !== "installed" && result.status !== "updated" && result.status !== "duplicate") {
      return refused("not-recorded", `the record did not take the install (${result.status}), so the course was not installed`);
    }
    recorded = true;
    return { status: "installed", install: id, course: name, url: kept.url, commit: kept.commit, trusted: false };
  } finally {
    if (!recorded) rmSync(dest, { recursive: true, force: true });
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
