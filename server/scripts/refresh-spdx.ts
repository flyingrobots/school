// Regenerates the vendored SPDX lists (flyingrobots/school#274): server/spdx-license-ids.ts from the
// `spdx-license-ids` package and server/spdx-exception-ids.ts from `spdx-exceptions` (both copied, not
// dependencies: ADR 2). It fetches with `npm pack` into a scratch directory under $TMPDIR, never into
// the repository, and writes only those two files.
//
//   bun server/scripts/refresh-spdx.ts [--license-ids <version>] [--exceptions <version>]
//
// With no version it takes the package's latest release. Giving the versions the files record
// regenerates them byte for byte. Each file records the release it came from; the staleness rule is
// `isStale` below, and docs/working-notes.md says when to run this. It needs the network and npm, and
// stops, changing nothing, when either is missing.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Release } from "../spdx-license-ids.ts";

export type { Release };

const WIDTH = 100;

/** `names` as quoted strings, filled greedily into lines of at most WIDTH columns with a two-space indent. */
function wrapped(names: readonly string[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of names.map((n) => `${JSON.stringify(n)},`)) {
    if (line !== "" && 2 + line.length + 1 + item.length > WIDTH) {
      lines.push(line);
      line = item;
    } else {
      line = line === "" ? item : `${line} ${item}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => `  ${l}`).join("\n");
}

const stamp = (name: string, r: Release) =>
  `/** The release of \`${r.package}\` this list is from, and the day it was published. */
export const ${name}: Release = { package: ${JSON.stringify(r.package)}, version: ${JSON.stringify(r.version)}, published: ${JSON.stringify(r.published)} };`;

/** The text of server/spdx-license-ids.ts for `release`. */
export function renderLicenseIds(release: Release, ids: readonly string[], deprecated: readonly string[]): string {
  return `// The SPDX License List's license identifiers, current and deprecated, as \`spdx-license-ids\`
// ${release.version} (CC0-1.0, https://github.com/jslicense/spdx-license-ids) publishes them. A course's
// \`license\` (server/course-file.ts) names only these, or a \`LicenseRef-\`. Copied, not a dependency
// (ADR 2). Generated: to update, run \`bun server/scripts/refresh-spdx.ts\` (docs/working-notes.md).

/** The release of an npm package a list was copied from, and the day npm says it was published (YYYY-MM-DD). */
export type Release = { package: string; version: string; published: string };

${stamp("LICENSE_IDS_RELEASE", release)}

/** The current identifiers (${ids.length}). */
export const LICENSE_IDS: readonly string[] = [
${wrapped(ids)}
];

/** Identifiers the list has deprecated but still recognises (${deprecated.length}). */
export const DEPRECATED_LICENSE_IDS: readonly string[] = [
${wrapped(deprecated)}
];
`;
}

/** The text of server/spdx-exception-ids.ts for `release`. */
export function renderExceptionIds(release: Release, ids: readonly string[]): string {
  return `// The SPDX License List's exception identifiers, as \`spdx-exceptions\` ${release.version} (CC0-1.0,
// https://github.com/jslicense/spdx-exceptions) publishes them. A course's \`license\`
// (server/course-file.ts) names only these after \`WITH\`. Copied, not a dependency (ADR 2).
// Generated: to update, run \`bun server/scripts/refresh-spdx.ts\` (docs/working-notes.md).

import type { Release } from "./spdx-license-ids.ts";

${stamp("EXCEPTION_IDS_RELEASE", release)}

/** The exception identifiers (${ids.length}). */
export const EXCEPTION_IDS: readonly string[] = [
${wrapped(ids)}
];
`;
}

/** How many months after its publication a recorded release is due for a refresh. */
export const REFRESH_AFTER_MONTHS = 12;

/** True when a release published on `published` is more than REFRESH_AFTER_MONTHS before `today` (both YYYY-MM-DD). */
export function isStale(published: string, today: string): boolean {
  const [y, m, d] = published.split("-").map(Number) as [number, number, number];
  const due = new Date(Date.UTC(y, m - 1 + REFRESH_AFTER_MONTHS, d)).toISOString().slice(0, 10);
  return today > due;
}

/** The release a generated list file records. Throws if \`source\` has none. */
export function readRelease(source: string): Release {
  const m = /export const \w+_RELEASE: Release = \{ package: "([^"]+)", version: "([^"]+)", published: "([^"]+)" \};/.exec(source);
  if (m === null) throw new Error("no recorded release found");
  return { package: m[1]!, version: m[2]!, published: m[3]! };
}

class Refusal extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

/** Runs `npm` with `args`, giving its stdout; a Refusal saying what failed when npm is missing or exits non-zero. */
function npm(args: string[], cwd: string): string {
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false", npm_config_audit: "false" } });
  if (r.error !== undefined) throw new Refusal(`cannot run npm (${r.error.message}); this script needs npm and the network`);
  if (r.status !== 0) {
    const why = r.stderr.split("\n").filter((l) => l.trim() !== "").slice(-3).join(" / ");
    throw new Refusal(`npm ${args.slice(0, 2).join(" ")} failed (${why || `exit ${r.status}`}); this script needs the network and the npm registry`);
  }
  return r.stdout;
}

function strings(path: string): string[] {
  const parsed = z.array(z.string()).safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Refusal(`${path} is not a list of strings`);
  return parsed.data;
}

/** Downloads `pkg` at `version` (or its latest release) into `scratch`, giving the release and the unpacked directory. */
function fetchRelease(pkg: string, version: string | null, scratch: string): { release: Release; dir: string } {
  const wanted = version ?? npm(["view", pkg, "version"], scratch).trim();
  const packed = npm(["pack", `${pkg}@${wanted}`, "--silent", "--pack-destination", scratch], scratch).trim().split("\n").pop()!;
  const dir = join(scratch, pkg);
  mkdirSync(dir);
  const tar = spawnSync("tar", ["xzf", join(scratch, packed), "-C", dir, "--strip-components=1"], { encoding: "utf8" });
  if (tar.status !== 0) throw new Refusal(`cannot unpack ${packed}: ${tar.stderr.trim()}`);
  const times = z.record(z.string(), z.string()).parse(JSON.parse(npm(["view", pkg, "time", "--json"], scratch)));
  const when = times[wanted];
  if (when === undefined) throw new Refusal(`npm records no publication time for ${pkg}@${wanted}`);
  return { release: { package: pkg, version: wanted, published: when.slice(0, 10) }, dir };
}

function main(argv: string[]): void {
  const USAGE = "usage: bun server/scripts/refresh-spdx.ts [--license-ids <version>] [--exceptions <version>]";
  const versions: Record<string, string | null> = { "--license-ids": null, "--exceptions": null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!(flag in versions) || value === undefined || !/^\d+\.\d+\.\d+$/.test(value)) throw new Refusal(`${flag in versions ? `${flag} needs a version such as 1.2.3` : `unknown argument ${flag}`}; ${USAGE}`, 2);
    versions[flag] = value;
  }
  // The scratch directory is under $TMPDIR, never the repository, and goes when the run ends.
  const scratch = mkdtempSync(join(tmpdir(), "school-refresh-spdx-"));
  try {
    const licenses = fetchRelease("spdx-license-ids", versions["--license-ids"] ?? null, scratch);
    const exceptions = fetchRelease("spdx-exceptions", versions["--exceptions"] ?? null, scratch);
    const files = [
      [join(import.meta.dir, "..", "spdx-license-ids.ts"), renderLicenseIds(licenses.release, strings(join(licenses.dir, "index.json")), strings(join(licenses.dir, "deprecated.json")))],
      [join(import.meta.dir, "..", "spdx-exception-ids.ts"), renderExceptionIds(exceptions.release, strings(join(exceptions.dir, "index.json")))],
    ] as const;
    // Nothing is written until both lists have been fetched and read.
    for (const [path, text] of files) writeFileSync(path, text);
    console.log(`spdx-license-ids ${licenses.release.version} (${licenses.release.published}), spdx-exceptions ${exceptions.release.version} (${exceptions.release.published}) written.`);
    console.log(`Update the versions named in docs/working-notes.md and docs/topics/course-format/README.md to match.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    const refusal = e instanceof Refusal ? e : new Refusal(e instanceof Error ? e.message : String(e));
    console.error(`refresh-spdx: ${refusal.message}`);
    process.exit(refusal.code);
  }
}
