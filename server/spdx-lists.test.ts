// The vendored SPDX lists (flyingrobots/school#274): server/spdx-license-ids.ts and
// server/spdx-exception-ids.ts are copied from npm packages, and a license SPDX adds later is refused
// until someone refreshes them. `bun server/scripts/refresh-spdx.ts` regenerates both; these tests keep the
// files, their recorded releases and the docs in step, and pin the rule for when a release is due for a
// refresh. None of them touches the network or the clock: a rule that read today's date would turn this
// suite red on a day nothing changed (the exceptions release is already older than a year, and upstream
// has published nothing since). docs/topics/course-format/test-plan.md lists the cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import * as realFs from "node:fs";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXCEPTION_IDS } from "./spdx-exception-ids.ts";
import { DEPRECATED_LICENSE_IDS, LICENSE_IDS } from "./spdx-license-ids.ts";
import { isStale, readRelease, refresh, Refusal, type Fetched, REFRESH_AFTER_MONTHS, renderExceptionIds, renderLicenseIds, type Release } from "./scripts/refresh-spdx.ts";

const LICENSE_FILE = join(import.meta.dir, "spdx-license-ids.ts");
const EXCEPTION_FILE = join(import.meta.dir, "spdx-exception-ids.ts");
const SCRIPT = join(import.meta.dir, "scripts", "refresh-spdx.ts");
const NOTICE_FILE = join(import.meta.dir, "..", "NOTICE");
const read = (path: string) => readFileSync(path, "utf8");

/** LISTS-12's rule: the NOTICE at `noticePath` names the package, version and licence that `source` records. */
function expectNoticeNamesRecord(source: string, noticePath: string): void {
  const { package: name, version, license } = readRelease(source);
  const notice = read(noticePath).replace(/\s+/g, " ");
  expect(notice).toContain(`${name} ${version}`);
  const entry = notice.split(" - ").find((part) => part.includes(`${name} ${version}`))!;
  expect(entry).toContain(license);
}
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

  test("LISTS-11: it records the licence of the package it was copied from, and its header says that licence", () => {
    const release = readRelease(source);
    expect(release.license).toBe(pkg === "spdx-exceptions" ? "CC-BY-3.0" : "CC0-1.0");
    expect(source.split("\n\n")[0]).toContain(`(${release.license},`);
    if (pkg === "spdx-exceptions") expect(source.split("\n\n")[0]).toContain("attributed in NOTICE");
  });

  test("LISTS-12: NOTICE names the package, the version and the licence the file records", () => {
    expectNoticeNamesRecord(source, NOTICE_FILE);
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

describe("refreshing, with the fetch and the file system injected", () => {
  const root = mkdtempSync(join(tmpdir(), "school-refresh-seam-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  /** A scratch tree: copies of the two vendored files, and fetched packages for `licenses` and `exceptions`. */
  function setup(fetchedLicense: { licenses?: string; exceptions?: string } = {}) {
    const dir = join(root, `t${n++}`);
    mkdirSync(join(dir, "files"), { recursive: true });
    const paths = { licenses: join(dir, "files", "spdx-license-ids.ts"), exceptions: join(dir, "files", "spdx-exception-ids.ts"), notice: join(dir, "files", "NOTICE") };
    copyFileSync(LICENSE_FILE, paths.licenses);
    copyFileSync(EXCEPTION_FILE, paths.exceptions);
    copyFileSync(NOTICE_FILE, paths.notice);
    const fetched = (pkg: string, version: string, license: string, files: Record<string, unknown>): Fetched => {
      const pkgDir = join(dir, "fetched", pkg);
      mkdirSync(pkgDir, { recursive: true });
      for (const [name, value] of Object.entries(files)) writeFileSync(join(pkgDir, name), JSON.stringify(value));
      return { release: { package: pkg, version, published: "2027-01-02", license }, dir: pkgDir };
    };
    const fetch = (pkg: string): Fetched =>
      pkg === "spdx-license-ids"
        ? fetched(pkg, "9.9.9", fetchedLicense.licenses ?? "CC0-1.0", { "index.json": ["MIT", "Zzz-1.0"], "deprecated.json": ["Old-1.0"] })
        : fetched(pkg, "8.8.8", fetchedLicense.exceptions ?? "CC-BY-3.0", { "index.json": ["Classpath-exception-2.0"] });
    const snapshot = () => Object.fromEntries(readdirSync(join(dir, "files")).sort().map((f) => [f, read(join(dir, "files", f))]));
    return { dir, paths, fetch, snapshot };
  }

  test("LISTS-13: a fetched package with a different licence from the recorded one is refused with one message, files untouched", () => {
    const { paths, fetch, snapshot } = setup({ exceptions: "CC0-1.0" });
    const before = snapshot();
    let refusal: unknown;
    try {
      refresh({ "--license-ids": null, "--exceptions": null }, { fetch, fs: realFs, paths, scratch: root });
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(Refusal);
    const message = (refusal as Refusal).message;
    expect(message).toContain("spdx-exceptions 8.8.8");
    expect(message).toContain("CC0-1.0");
    expect(message).toContain("CC-BY-3.0");
    expect(message).toContain("NOTICE");
    expect(message).not.toContain("\n");
    expect(snapshot()).toEqual(before);
  });

  test("LISTS-14: a refresh whose licences match the recorded ones writes both files, each with the licence in its header", () => {
    const { paths, fetch } = setup();
    const done = refresh({ "--license-ids": null, "--exceptions": null }, { fetch, fs: realFs, paths, scratch: root });
    expect(done.licenses.version).toBe("9.9.9");
    const exceptions = read(paths.exceptions);
    expect(readRelease(exceptions)).toEqual({ package: "spdx-exceptions", version: "8.8.8", published: "2027-01-02", license: "CC-BY-3.0" });
    expect(exceptions).toContain("(CC-BY-3.0,");
    expect(exceptions).toContain('"Classpath-exception-2.0",');
    expect(read(paths.licenses)).toContain('"Zzz-1.0",');
  });

  test("LISTS-15: when writing the second file fails, neither vendored file changes and no temporary file is left", () => {
    const { paths, fetch, snapshot } = setup();
    const before = snapshot();
    let writes = 0;
    const fs = {
      ...realFs,
      writeFileSync: ((path: string, data: string) => {
        if (++writes === 2) throw new Error("disk full");
        return realFs.writeFileSync(path, data);
      }) as typeof realFs.writeFileSync,
    };
    expect(() => refresh({ "--license-ids": null, "--exceptions": null }, { fetch, fs, paths, scratch: root })).toThrow("disk full");
    expect(writes).toBe(2);
    expect(snapshot()).toEqual(before);
  });

  test("LISTS-16: when renaming the second file fails, the first is put back and no temporary file is left", () => {
    const { paths, fetch, snapshot } = setup();
    const before = snapshot();
    let renames = 0;
    const fs = {
      ...realFs,
      renameSync: ((from: string, to: string) => {
        if (++renames === 2) throw new Error("rename failed");
        return realFs.renameSync(from, to);
      }) as typeof realFs.renameSync,
    };
    expect(() => refresh({ "--license-ids": null, "--exceptions": null }, { fetch, fs, paths, scratch: root })).toThrow("rename failed");
    expect(snapshot()).toEqual(before);
  });

  test("LISTS-17: a same-licence version bump leaves NOTICE naming the new versions, and LISTS-12 holds for the result", () => {
    const { paths, fetch } = setup();
    const noticeBefore = read(paths.notice);
    expect(noticeBefore).toContain("spdx-license-ids 3.0.24");
    refresh({ "--license-ids": null, "--exceptions": null }, { fetch, fs: realFs, paths, scratch: root });
    const notice = read(paths.notice);
    expect(notice).toContain("spdx-license-ids 9.9.9");
    expect(notice).toContain("spdx-exceptions 8.8.8");
    expect(notice).not.toContain("3.0.24");
    expect(notice).not.toContain("2.5.0");
    expectNoticeNamesRecord(read(paths.licenses), paths.notice);
    expectNoticeNamesRecord(read(paths.exceptions), paths.notice);
  });

  test("LISTS-18: a NOTICE that names neither package at its recorded version is refused before anything is written", () => {
    const { paths, fetch, snapshot } = setup();
    writeFileSync(paths.notice, "No packages are named here.\n");
    const before = snapshot();
    expect(() => refresh({ "--license-ids": null, "--exceptions": null }, { fetch, fs: realFs, paths, scratch: root })).toThrow(Refusal);
    expect(snapshot()).toEqual(before);
  });

  // The refresh makes up to three renames to move originals aside and three to put new files in place.
  // Failing the Kth rename with ENOSPC, and every write after it, must leave all three files as they were
  // with nothing left beside them, so recovery cannot depend on writing anything.
  test.each([1, 2, 3, 4, 5, 6])("LISTS-19: with rename %p failing ENOSPC and every later write failing too, the files stay as they were", (failing) => {
    const { paths, fetch, snapshot } = setup();
    const before = snapshot();
    const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    let renames = 0;
    let failed = false;
    const fs = {
      ...realFs,
      renameSync: ((from: string, to: string) => {
        if (++renames === failing) {
          failed = true;
          throw enospc();
        }
        return realFs.renameSync(from, to);
      }) as typeof realFs.renameSync,
      writeFileSync: ((path: string, data: string) => {
        if (failed) throw enospc();
        return realFs.writeFileSync(path, data);
      }) as typeof realFs.writeFileSync,
    };
    expect(() => refresh({ "--license-ids": null, "--exceptions": null }, { fetch, fs, paths, scratch: root })).toThrow("ENOSPC");
    expect(snapshot()).toEqual(before);
  });
});
