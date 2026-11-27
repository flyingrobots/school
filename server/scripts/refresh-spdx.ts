// Regenerates the vendored SPDX lists (flyingrobots/school#274). Not implemented yet.

/** The release of an npm package a list was copied from, and the day npm says it was published (YYYY-MM-DD). */
export type Release = { package: string; version: string; published: string };

export function renderLicenseIds(_release: Release, _ids: readonly string[], _deprecated: readonly string[]): string {
  throw new Error("not implemented");
}
export function renderExceptionIds(_release: Release, _ids: readonly string[]): string {
  throw new Error("not implemented");
}
export function readRelease(_source: string): Release {
  throw new Error("not implemented");
}
export const REFRESH_AFTER_MONTHS = 12;
export function isStale(_published: string, _today: string): boolean {
  throw new Error("not implemented");
}
