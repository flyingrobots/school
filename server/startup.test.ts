// The config checks, exercised through the real server process and Bun's actual database
// creation rather than parseConfig alone (review of #8, P2).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotStarted, startSchool, timeout } from "./testing/processes.ts";

async function boot(env: Record<string, string>): Promise<{ code: number | null; up: boolean; err: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  try {
    const s = await startSchool({ ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env });
    s.proc.kill();
    return { code: null, up: true, err: (await s.output()).stderr };
  } catch (e) {
    if (!(e instanceof NotStarted)) throw e;
    return { code: e.exitCode, up: false, err: e.stderr };
  }
}

test("a dangling DB_PATH symlink into a course stops the server before it creates anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "school-boot-"));
  try {
    mkdirSync(join(root, "course", "lessons"), { recursive: true });
    mkdirSync(join(root, "state"));
    symlinkSync(join(root, "course", "new-progress.db"), join(root, "state", "progress.db"));
    const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state") });
    expect(r.up).toBe(false);
    expect(r.code).toBe(2);
    expect(r.err).toContain("symlink");
    expect(existsSync(join(root, "course", "new-progress.db"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, timeout(1));

test("a first run creates its state directory and database outside the course", async () => {
  const root = mkdtempSync(join(tmpdir(), "school-boot-"));
  try {
    mkdirSync(join(root, "course", "lessons"), { recursive: true });
    const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "fresh", "state") });
    expect(r.up).toBe(true);
    expect(existsSync(join(root, "fresh", "state", "progress.db"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, timeout(1));
