// The pinned school skill (RFC 9 §5.3, flyingrobots/school#257). An authoring agent is given the
// skill in this checkout, `.agents/skills/school/`, and the references it links, never a copy the
// host installed, so the skill that writes a draft and the check that judges it are one version.
// Compose mounts them read-only (server/compose.yaml); at start the server hashes them into one
// manifest digest, which a later task records with every request. Without them authoring is off,
// with the reason, and School still serves.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Whether School can author a course, and the skill that would write it. */
export type Authoring =
  | { authoring: "on"; skill: { digest: string; files: number } }
  | { authoring: "off"; reason: string };

/** Why the mounted skill cannot be hashed. Its message is the reason authoring is off. */
export class GuideError extends Error {}

/** The references the skill links, each a folder under SCHOOL_SKILL_DOCS, and where a checkout keeps it. */
const REFERENCES = ["course-format", "voice"] as const;

const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e);

/** Every regular file under `dir`, as [path under `as`, absolute path]. Refuses anything else. */
function files(dir: string, as: string): [string, string][] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    throw new GuideError(`cannot read ${dir}: ${code(e)}`);
  }
  return entries.flatMap((name): [string, string][] => {
    const path = join(dir, name);
    const under = as === "" ? name : `${as}/${name}`;
    if (name.includes("\n")) throw new GuideError(`${JSON.stringify(path)} has a line break in its name, which the manifest cannot hold`);
    let s;
    try {
      s = lstatSync(path);
    } catch (e) {
      throw new GuideError(`cannot read ${path}: ${code(e)}`);
    }
    if (s.isSymbolicLink()) throw new GuideError(`${path} is a symlink: School hashes and sends only regular files and folders`);
    if (s.isDirectory()) return files(path, under);
    if (!s.isFile()) throw new GuideError(`${path} is not a regular file: School hashes and sends only regular files and folders`);
    return [[under, path]];
  });
}

/** `path` is a folder, following a symlink, as a bind mount or a checkout's link may be; else why not. */
function folder(path: string, missing: string): void {
  let s;
  try {
    s = statSync(path);
  } catch (e) {
    if (code(e) === "ENOENT") throw new GuideError(missing);
    throw new GuideError(`cannot read ${path}: ${code(e)}`);
  }
  if (!s.isDirectory()) throw new GuideError(`${path} is not a folder`);
}

const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/**
 * The manifest of the guide an authoring agent is given: the skill's files at the guide's root and
 * each reference under `docs/<name>/`. One line per regular file, `<sha256> <path>\n`: the SHA-256
 * of its bytes in lowercase hex, one space, its path under the guide with `/` between parts. Sorted
 * by path as UTF-8 bytes. Throws GuideError when a folder is missing or holds anything but regular
 * files and folders.
 */
export function guideManifest(skill: string, docs: string): string {
  folder(skill, `the school skill is not at ${skill}: mount the checkout's .agents/skills/school there, read-only (server/compose.yaml)`);
  const all = files(skill, "");
  if (!all.some(([p]) => p === "SKILL.md")) throw new GuideError(`the school skill at ${skill} has no SKILL.md`);
  for (const name of REFERENCES) {
    const dir = join(docs, name);
    folder(dir, `the ${name} reference is not at ${dir}: mount the checkout's docs/topics/${name} there, read-only (server/compose.yaml)`);
    all.push(...files(dir, `docs/${name}`));
  }
  const lines = all.map(([under, path]): [Buffer, string] => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      throw new GuideError(`cannot read ${path}: ${code(e)}`);
    }
    return [Buffer.from(under, "utf8"), `${sha256(bytes)} ${under}\n`];
  });
  return lines.sort(([a], [b]) => Buffer.compare(a, b)).map(([, line]) => line).join("");
}

/** The SHA-256 of a manifest's text, as lowercase hex. */
export function manifestDigest(manifest: string): string {
  return sha256(manifest);
}

/** Authoring's status at start: on with the guide's digest, or off with the reason. */
export function authoringStatus(skill: string | null, docs: string): Authoring {
  if (skill === null) return { authoring: "off", reason: "SCHOOL_SKILL is empty, so there is no school skill to give an authoring agent" };
  try {
    const manifest = guideManifest(skill, docs);
    return { authoring: "on", skill: { digest: manifestDigest(manifest), files: manifest.split("\n").length - 1 } };
  } catch (e) {
    if (e instanceof GuideError) return { authoring: "off", reason: e.message };
    throw e;
  }
}
