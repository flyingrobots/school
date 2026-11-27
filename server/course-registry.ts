// The course list (RFC 7 §5 and §7, task 4; flyingrobots/school#234). Stub for the red commit.
import type { Config, Course } from "./config.ts";
import type { InstalledCourse } from "./core/model.ts";

export class RegistryError extends Error {}

export type Manifest = { summary: string | null; author: string | null; license: string | null; format: number | null };
export type ServedCourse = Course & { title: string; manifest: Manifest; source: "configured" | "installed" };
export type UnavailableCourse = { name: string; title: string; trusted: boolean; manifest: Manifest; reason: string };
export type Listed = { kind: "served"; course: ServedCourse } | { kind: "unavailable"; course: UnavailableCourse };
export type Registry = { listed: Listed[]; served: ServedCourse[]; find(name: string): Listed | null };
export type Digest = { ok: true; digest: string } | { ok: false; path: string; message: string };

export function contentDigest(_folder: string): Digest {
  throw new Error("not implemented");
}

export function installFolder(_store: string, _installId: string): string {
  throw new Error("not implemented");
}

export function configuredCourses(_config: Config): ServedCourse[] {
  throw new Error("not implemented");
}

export function courseRegistry(_opts: { config: Config; configured: ServedCourse[]; installed: () => Promise<InstalledCourse[]>; log: (line: string) => void }):
  { start(): Promise<Registry>; current(): Promise<Registry> } {
  throw new Error("not implemented");
}
