// The vendored SPDX lists (flyingrobots/school#274): server/spdx-license-ids.ts and
// server/spdx-exception-ids.ts are copied from npm packages, and a license SPDX adds later is refused
// until someone refreshes them. `bun server/scripts/refresh-spdx.ts` regenerates both; these tests keep the
// files, their recorded releases and the docs in step, and pin the rule for when a release is due for a
// refresh. None of them touches the network or the clock: a rule that read today's date would turn this
// suite red on a day nothing changed (the exceptions release is already older than a year, and upstream
// has published nothing since). docs/topics/course-format/test-plan.md lists the cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXCEPTION_IDS } from "./spdx-exception-ids.ts";
import { DEPRECATED_LICENSE_IDS, LICENSE_IDS } from "./spdx-license-ids.ts";
import { isStale, readRelease, REFRESH_AFTER_MONTHS, renderExceptionIds, renderLicenseIds, type Release } from "./scripts/refresh-spdx.ts";

const LICENSE_FILE = join(import.meta.dir, "spdx-license-ids.ts");
const EXCEPTION_FILE = join(import.meta.dir, "spdx-exception-ids.ts");
const SCRIPT = join(import.meta.dir, "scripts", "refresh-spdx.ts");
const read = (path: string) => readFileSync(path, "utf8");
const docs = {
  readme: read(join(import.meta.dir, "..", "docs", "topics", "course-format", "README.md")),
  notes: read(join(import.meta.dir, "..", "docs", "working-notes.md")),
};

const lists = [
  { name: "license list", file: LICENSE_FILE, pkg: "spdx-license-ids", render: (r: Release) => renderLicenseIds(r, LICENSE_IDS, DEPRECATED_LICENSE_IDS) },
  { name: "exception list", file: EXCEPTION_FILE, pkg: "spdx-exceptions", render: (r: Release) => renderExceptionIds(r, EXCEPTION_IDS) },
];

describe.each(lists)("the vendored $name", ({ file, pkg, render }) => {
  const source = read(file);

  test("LISTS-1: regenerating it from its own recorded release gives the file back, byte for byte", () => {
    expect(render(readRelease(source))).toBe(source);
  });

  test("LISTS-2: it records the package, version and publication day it was copied from", () => {
    const release = readRelease(source);
    expect(release.package).toBe(pkg);
    expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(release.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${release.published}T00:00:00Z`).toISOString().slice(0, 10)).toBe(release.published);
  });

  test("LISTS-3: the course-format page and the working notes name the same release", () => {
    const { package: name, version } = readRelease(source);
    for (const [where, text] of Object.entries(docs)) expect(text, `${where} names ${name} ${version}`).toMatch(new RegExp(`${name}\`?[^\\n]{0,20}\\b${version.replaceAll(".", "\\.")}\\b|${name}\`?[\\s\\S]{0,30}\\b${version.replaceAll(".", "\\.")}\\b`));
  });

  test("LISTS-4: its header points at the refresh script", () => {
    expect(source).toContain("bun server/scripts/refresh-spdx.ts");
  });
});

describe("when a recorded release is due for a refresh", () => {
  test.each([
    ["published today", "2026-11-26", "2026-11-26", false],
    ["published a year ago to the day", "2025-11-26", "2026-11-26", false],
    ["published a year and a day ago", "2025-11-25", "2026-11-26", true],
    ["published two years ago", "2024-11-26", "2026-11-26", true],
    ["published on a leap day, a year later", "2024-02-29", "2025-02-28", false],
    ["published on a leap day, a year and two days later", "2024-02-29", "2025-03-03", true],
    ["published after the day asked about", "2026-12-01", "2026-11-26", false],
  ])("LISTS-5: a release %s is stale: %p", (_, published, today, stale) => {
    expect(isStale(published, today)).toBe(stale);
  });

  test("LISTS-6: the rule is twelve months, and the docs say so", () => {
    expect(REFRESH_AFTER_MONTHS).toBe(12);
    expect(docs.notes).toContain("refresh-spdx.ts");
    expect(docs.notes).toMatch(/12 months|a year/);
  });

  test("LISTS-7: a file whose stamp is old fails the rule, and the file as committed passes it on its own day", () => {
    const source = read(LICENSE_FILE);
    const current = readRelease(source);
    const old = readRelease(source.replace(current.published, "2020-01-01"));
    expect(old.published).toBe("2020-01-01");
    expect(isStale(old.published, current.published)).toBe(true);
    expect(isStale(current.published, current.published)).toBe(false);
  });
});

describe("the refresh script", () => {
  const scratch = mkdtempSync(join(tmpdir(), "school-refresh-spdx-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  async function run(args: string[], env: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { stdout: "pipe", stderr: "pipe", env: { ...env, TMPDIR: scratch, HOME: scratch } });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test("LISTS-8: with no npm it stops with one clear message, exit 1, leaving both files as they were", async () => {
    const before = [read(LICENSE_FILE), read(EXCEPTION_FILE)];
    const r = await run([], { PATH: "" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^refresh-spdx: /);
    expect(r.stderr).toContain("npm");
    expect(r.stderr).not.toContain("    at ");
    expect([read(LICENSE_FILE), read(EXCEPTION_FILE)]).toEqual(before);
  });

  test("LISTS-9: with the registry unreachable it stops saying the fetch failed, exit 1, leaving both files as they were", async () => {
    const before = [read(LICENSE_FILE), read(EXCEPTION_FILE)];
    const r = await run([], { PATH: process.env.PATH ?? "", npm_config_registry: "http://127.0.0.1:9/", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "3000" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^refresh-spdx: /);
    expect(r.stderr).toMatch(/network|registry|fetch/i);
    expect(r.stderr).not.toContain("    at ");
    expect([read(LICENSE_FILE), read(EXCEPTION_FILE)]).toEqual(before);
  }, 30_000);

  test("LISTS-10: an unknown argument is a usage error, exit 2, before anything is fetched", async () => {
    const r = await run(["--frobnicate"], { PATH: "" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^refresh-spdx: /);
    expect(r.stderr).toContain("usage");
  });
});
