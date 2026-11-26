// Extracting a course from a git commit's tree (RFC 7 §4 and §6, task 5; flyingrobots/school#235).
export type Limits = { files: number; fileBytes: number; totalBytes: number; pathBytes: number; depth: number; gitMs: number };
const MiB = 1024 * 1024;
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ files: 2000, fileBytes: 8 * MiB, totalBytes: 64 * MiB, pathBytes: 255, depth: 8, gitMs: 60_000 });
export type RefusalReason =
  | "bad-destination" | "not-a-commit" | "unsafe-name" | "case-collision" | "symlink" | "submodule" | "lfs-pointer"
  | "too-many-files" | "file-too-large" | "total-too-large" | "path-too-long" | "too-deep" | "timeout" | "git-failed";
export type Refusal = { reason: RefusalReason; path: string | null; message: string };
export type ExtractedFile = { path: string; bytes: number };
export type Extraction = { ok: true; folder: string; commit: string; files: ExtractedFile[]; bytes: number } | { ok: false; refusal: Refusal };
export type ExtractRequest = { repository: string; commit: string; into: string; limits?: Partial<Limits>; git?: string };

export async function extractCommit(_request: ExtractRequest): Promise<Extraction> {
  throw new Error("not implemented");
}
