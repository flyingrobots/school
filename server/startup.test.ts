// The config checks, exercised through the real server process and Bun's actual database
// creation rather than parseConfig alone (review of #8, P2).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function boot(env: Record<string, string>): Promise<{ code: number | null; up: boolean; err: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env }, stdout: "ignore", stderr: "pipe",
  });
  let up = false;
  for (let i = 0; i < 100 && proc.exitCode === null; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/courses`)).ok) { up = true; break; } } catch {}
    await Bun.sleep(50);
  }
  if (up) proc.kill();
  const code = await proc.exited;
  return { code: up ? null : code, up, err: await new Response(proc.stderr).text() };
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
});

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
});
