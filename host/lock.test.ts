// The launcher's lock (flyingrobots/school#132 review): one `school` command at a time per Keychain
// account resolves and stores secrets, so two overlapping first runs cannot each store a different
// superuser password. A real directory in a temp folder; no Keychain. docs/topics/secrets/test-plan.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { acquireLock } from "./lock.ts";
import { SecretError } from "./secrets.ts";

test("SEC-L27: the lock is exclusive, waits for its holder, takes over a dead holder's lock, and gives up on a live one naming its pid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "school-lock-test-"));
  try {
    const path = join(dir, "school-test.lock");
    const opts = { path, retryMs: 5, timeoutMs: 2000 };
    const release = await acquireLock(opts);
    expect(existsSync(path)).toBe(true);
    let second = false;
    const waiting = acquireLock(opts).then((r) => { second = true; return r; });
    await Bun.sleep(30);
    expect(second).toBe(false);
    release();
    const release2 = await waiting;
    expect(second).toBe(true);
    release2();
    expect(existsSync(path)).toBe(false);

    // A lock left by a process that is gone: taken over.
    const dead = Bun.spawnSync(["true"]).pid;
    mkdirSync(path);
    writeFileSync(join(path, "pid"), String(dead));
    (await acquireLock(opts))();

    // A lock held by a live process (this one, from outside the call): refused after the timeout.
    mkdirSync(path);
    writeFileSync(join(path, "pid"), String(process.pid));
    const refused = acquireLock({ ...opts, timeoutMs: 50 });
    await expect(refused).rejects.toBeInstanceOf(SecretError);
    await expect(acquireLock({ ...opts, timeoutMs: 50 })).rejects.toThrow(new RegExp(`pid ${process.pid}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
