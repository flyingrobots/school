// The pinned school skill (RFC 9 §5.3, flyingrobots/school#257). Not implemented yet.

/** Whether School can author a course, and the skill that would write it. */
export type Authoring =
  | { authoring: "on"; skill: { digest: string; files: number } }
  | { authoring: "off"; reason: string };

/** Why the mounted skill cannot be hashed. Its message is the reason authoring is off. */
export class GuideError extends Error {}

/** The manifest of the guide an authoring agent is given. */
export function guideManifest(_skill: string, _docs: string): string {
  throw new Error("not implemented");
}

/** The SHA-256 of a manifest's text, as lowercase hex. */
export function manifestDigest(_manifest: string): string {
  throw new Error("not implemented");
}

/** Authoring's status at start: on with the guide's digest, or off with the reason. */
export function authoringStatus(_skill: string | null, _docs: string): Authoring {
  throw new Error("not implemented");
}
