// Previewing a course install from a repository (RFC 7 §4 and §5.2, task 7; flyingrobots/school#237).
//
// `previewInstall` takes a request's body, `{url, commit}` and nothing else, and runs the first
// three stages of RFC 7's pipeline in a new folder `<store>/staging/<preview id>/`:
//
// 1. fetch the commit into `repo.git` (`fetchCommit`, server/fetch-commit.ts);
// 2. extract the files School reads into `course/` (`extractCommit`, server/extract-tree.ts), then
//    delete `repo.git`, which nothing reads again;
// 3. check `course/` as `school check` does (`checkCourse`, server/check-course.ts).
//
// A refusal at any stage deletes the preview's folder and answers the stage, the reason, the tree
// path or file it concerns, and the stage's own sentence. A course that passes is kept as
// `course/` beside `preview.json` (the URL, the full commit and when the preview expires) for the
// install (RFC 7 task 8, `POST /api/installs {preview, name}`) to move into `courses/`; until then
// nothing outside `staging/` is written, and the record is only read. A preview that is never
// confirmed is deleted once it expires, an hour after it was made (`sweepStaging`), and every
// preview is deleted when School starts.
//
// The answer also suggests a name (RFC 7 §5.2): the URL's last path segment without `.git`, made a
// course name; says whether a configured course or a current install already has it; and gives
// any progress the record holds under it, so the learner can choose to continue it.
//
// The test seams of `fetchCommit` (`FetchTesting`: the git program, the network, the limits) are
// this function's third argument. Only tests pass it; the route never does, and nothing in the
// request body can reach it: the body is parsed strictly, so any field besides `url` and `commit`
// is refused.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import { checkCourse, type Lesson } from "./check-course.ts";
import { NAME, RESERVED } from "./config.ts";
import type { CourseProgress } from "./core/model.ts";
import { extractCommit } from "./extract-tree.ts";
import { fetchCommit, type FetchTesting } from "./fetch-commit.ts";

/** How long an unconfirmed preview is kept for the install to take it (RFC 7 §4): one hour. */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

/** What a preview reads besides the repository: the store, the names already taken, and the record. */
export type PreviewSources = {
  /** The course store, `SCHOOL_COURSE_STORE`. Previews are staged under its `staging/`. */
  store: string;
  /** Every configured course's name. */
  configured: readonly string[];
  /** Every current install's name. */
  installedNames: () => Promise<string[]>;
  /** What the record holds under a name. */
  progress: (course: string) => Promise<CourseProgress>;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** A new preview id, a UUID. */
  newId: () => string;
};

export type PreviewStage = "fetch" | "extract" | "check";
/** What the course declares and holds, as `school check` reports it. */
export type PreviewCourse = {
  title: string | null; summary: string | null; author: string | null; license: string | null; format: number | null;
  lessons: Lesson[]; quizzes: number; explains: number;
};
/** The suggested name, what already has it, and the progress the record holds under it (null for none). */
export type PreviewName = { suggested: string; taken: "configured" | "installed" | null; progress: CourseProgress | null };
export type PreviewAnswer =
  | { status: "ok"; preview: string; expires: string; url: string; commit: string; course: PreviewCourse; name: PreviewName }
  | { status: "refused"; stage: PreviewStage; reason: string; path: string | null; message: string }
  | { status: "invalid"; error: string };

/** The body, exactly: two strings, and no other field. Lengths are bounded here; fetchCommit checks the rest. */
const PreviewRequest = z.object({ url: z.string().max(4096), commit: z.string().max(512) }).strict();

/** What `preview.json` holds beside a kept preview's `course/`. */
const PreviewFile = z.object({ url: z.string(), commit: z.string(), expires: z.iso.datetime() });

/** Lowercased, every run of other characters one hyphen, no hyphen at either end (RFC 7 §5.2 step 1). */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const usable = (name: string) => NAME.test(name) && !(RESERVED as readonly string[]).includes(name);

/**
 * The name a preview suggests (RFC 7 §5.2 step 1): the URL's last path segment, percent-decoded and
 * without `.git`, made a course name. When that gives no name School can use (nothing, or a name its
 * own routes reserve), the course's title, the same way; failing both, `course`.
 */
export function suggestName(url: string, title: string | null): string {
  let segment = "";
  try {
    segment = new URL(url).pathname.split("/").filter((s) => s !== "").pop() ?? "";
  } catch {
    // Not a URL: the title decides.
  }
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // A stray `%` stays as it is, and becomes a hyphen.
  }
  for (const candidate of [slug(segment.replace(/\.git$/i, "")), slug(title ?? "")]) if (usable(candidate)) return candidate;
  return "course";
}

/** When a staged preview's time is up: its preview.json's `expires`, or, for a preview still being made or left half-made, a lifetime after it last changed. */
function expiresAt(folder: string): number {
  try {
    const file = join(folder, "preview.json");
    if (lstatSync(file).isFile()) return Date.parse(PreviewFile.parse(JSON.parse(readFileSync(file, "utf8"))).expires);
  } catch {
    // No preview.json, or not one School wrote: fall back to the folder's age.
  }
  return lstatSync(folder).mtimeMs + PREVIEW_TTL_MS;
}

/**
 * Deletes every preview in `<store>/staging/` whose time is up at `now`, or every entry when `all`
 * (as at start, RFC 7 §5.1). `staging/` itself is kept, and is not swept at all unless it is a real folder; anything else in the store is not touched.
 */
export function sweepStaging(store: string, now: number, all = false): void {
  const staging = join(store, "staging");
  let names: string[];
  try {
    // A symlinked staging/ would send the sweep wherever it points: only a real folder is swept.
    if (!lstatSync(staging).isDirectory()) return;
    names = readdirSync(staging);
  } catch {
    return;
  }
  for (const name of names) {
    const entry = join(staging, name);
    try {
      if (all || !lstatSync(entry).isDirectory() || expiresAt(entry) <= now) rmSync(entry, { recursive: true, force: true });
    } catch {
      // Gone already, or deleted by a sweep running beside this one.
    }
  }
}

/**
 * Fetches, extracts and checks one commit in a new folder under `<store>/staging/`, and answers
 * what was found, or the first refusal. See the header for what is written and kept.
 */
export async function previewInstall(body: unknown, sources: PreviewSources, testing: FetchTesting = {}): Promise<PreviewAnswer> {
  const parsed = PreviewRequest.safeParse(body);
  if (!parsed.success) return { status: "invalid", error: "a preview takes {\"url\": ..., \"commit\": ...}: the repository's https URL and a full commit hash, branch or tag, and nothing else" };
  const { url, commit: asked } = parsed.data;
  const now = sources.now();
  sweepStaging(sources.store, now);
  const staging = join(sources.store, "staging");
  mkdirSync(staging, { recursive: true });
  const id = sources.newId();
  const folder = join(staging, id);
  const course = join(folder, "course");
  // A stage's sentence may name a file by its path in the store; it is answered relative to the course.
  const plain = (message: string) => message.replaceAll(course + sep, "").replaceAll(folder + sep, "").replaceAll(course, ".").replaceAll(folder, ".");
  let kept = false;
  try {
    const fetched = await fetchCommit({ url, commit: asked, staging: folder }, testing);
    if (!fetched.ok) return { status: "refused", stage: "fetch", reason: fetched.refusal.reason, path: null, message: plain(fetched.refusal.message) };
    const extracted = await extractCommit({ repository: fetched.repository, commit: fetched.commit, into: course, ...(testing.git ? { git: testing.git } : {}) });
    if (!extracted.ok) return { status: "refused", stage: "extract", reason: extracted.refusal.reason, path: extracted.refusal.path, message: plain(extracted.refusal.message) };
    rmSync(fetched.repository, { recursive: true, force: true });
    const check = checkCourse(course);
    if (!check.ok) return { status: "refused", stage: "check", reason: "invalid", path: check.file, message: plain(check.message) };

    const suggested = suggestName(url, check.title);
    const taken = sources.configured.includes(suggested) ? "configured" : (await sources.installedNames()).includes(suggested) ? "installed" : null;
    const held = await sources.progress(suggested);
    const progress = held.encounters + held.answers + held.explanations + held.views > 0 ? held : null;
    const expires = new Date(now + PREVIEW_TTL_MS).toISOString();
    writeFileSync(join(folder, "preview.json"), JSON.stringify({ url, commit: fetched.commit, expires }), { flag: "wx", mode: 0o644 });
    kept = true;
    return {
      status: "ok", preview: id, expires, url, commit: fetched.commit,
      course: { title: check.title, ...check.manifest, lessons: check.lessons, quizzes: check.quizzes, explains: check.explains },
      name: { suggested, taken, progress },
    };
  } finally {
    if (!kept) rmSync(folder, { recursive: true, force: true });
  }
}
