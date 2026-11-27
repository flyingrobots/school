// Previewing a course install from a repository (RFC 7 §4 and §5.2, task 7; flyingrobots/school#237).
import type { CourseProgress } from "./core/model.ts";
import type { FetchTesting } from "./fetch-commit.ts";
import type { Lesson } from "./check-course.ts";

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
export type PreviewCourse = {
  title: string | null; summary: string | null; author: string | null; license: string | null; format: number | null;
  lessons: Lesson[]; quizzes: number; explains: number;
};
export type PreviewName = { suggested: string; taken: "configured" | "installed" | null; progress: CourseProgress | null };
export type PreviewAnswer =
  | { status: "ok"; preview: string; expires: string; url: string; commit: string; course: PreviewCourse; name: PreviewName }
  | { status: "refused"; stage: PreviewStage; reason: string; path: string | null; message: string }
  | { status: "invalid"; error: string };

/** The name a preview suggests (RFC 7 §5.2). */
export function suggestName(url: string, title: string | null): string {
  void url;
  void title;
  throw new Error("not implemented");
}

/** Deletes previews in `<store>/staging/` whose time is up, or every one when `all`. */
export function sweepStaging(store: string, now: number, all = false): void {
  void store;
  void now;
  void all;
  throw new Error("not implemented");
}

/** Fetches, extracts and checks one commit in staging, and answers what was found. */
export async function previewInstall(body: unknown, sources: PreviewSources, testing: FetchTesting = {}): Promise<PreviewAnswer> {
  void body;
  void sources;
  void testing;
  throw new Error("not implemented");
}
