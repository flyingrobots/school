// Drafting a course (RFC 9 §5.1 and §5.2, flyingrobots/school#259). Not implemented yet.
import type { Limits } from "../server/extract-tree.ts";
import type { AuthorConfig, Usage } from "./run.ts";

export type CourseFile = { path: string; bytes: Uint8Array };
export type AuthorLimits = Pick<Limits, "files" | "fileBytes" | "totalBytes" | "pathBytes" | "depth">;
export class AuthorInputError extends Error {}
export type AuthorStep = { tool: string; path: string | null };
export type RefusalReason = "no-course" | "symlink" | "not-regular" | "too-many-files" | "file-too-large" | "total-too-large" | "path-too-long" | "too-deep";
export type Refusal = { reason: RefusalReason; path: string | null; message: string };
export type AuthorAttempt = { agent: string; status: "succeeded" | "failed" | "skipped" | "refused"; error: string | null; exitCode: number | null; ms: number; steps: number };
export type AuthorResult =
  | { status: "succeeded"; agent: string; usage: Usage | null; files: CourseFile[]; bytes: number; guideSha256: string; attempts: AuthorAttempt[] }
  | { status: "refused"; agent: string; usage: Usage | null; refusal: Refusal; guideSha256: string; attempts: AuthorAttempt[] }
  | { status: "failed"; agent: string | null; error: string; guideSha256: string | null; attempts: AuthorAttempt[] };
export type AuthorJob = { prompt: string; files: CourseFile[]; guide: CourseFile[]; deadlineMs?: number; signal?: AbortSignal; limits?: Partial<AuthorLimits>; heartbeatMs?: number };
export type AuthorEvents = { step(s: AuthorStep): void; heartbeat?(): void };

export function entries(_list: unknown, _where: "files" | "guide", _limits?: Partial<AuthorLimits>): CourseFile[] {
  throw new Error("not implemented");
}

export async function runAuthor(_cfg: AuthorConfig, _job: AuthorJob, _on: AuthorEvents): Promise<AuthorResult> {
  throw new Error("not implemented");
}
