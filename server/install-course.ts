// Installing a previewed course (RFC 7 §4 stages 4 and 5, §5.1, §5.2; task 8, flyingrobots/school#238).
// Not implemented yet: the red tests come first.
import type { CourseInstall, InstallResult } from "./core/model.ts";
import type { Limits } from "./extract-tree.ts";

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

export type InstallReason = "bad-name" | "name-taken" | "unknown-preview" | "expired" | "changed" | "over-limit" | "invalid-course" | "not-recorded";
export type InstallAnswer =
  | { status: "installed"; install: string; course: string; url: string; commit: string; trusted: false }
  | { status: "refused"; reason: InstallReason; message: string }
  | { status: "invalid"; error: string };

export async function installPreviewed(_body: unknown, _sources: InstallSources): Promise<InstallAnswer> {
  throw new Error("not implemented");
}

export function courseInstaller(_sources: InstallSources): (body: unknown) => Promise<InstallAnswer> {
  throw new Error("not implemented");
}

export function sweepCourses(_store: string, _current: ReadonlySet<string>): void {
  throw new Error("not implemented");
}
