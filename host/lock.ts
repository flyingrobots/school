// The launcher's lock (flyingrobots/school#132 review). `school up` reads the Keychain, and when a
// secret is missing it asks for or generates one and stores it. Two overlapping first runs could
// each find the superuser's password missing and each store a different one; the database keeps
// the first, the Keychain the second. So resolving and storing happen under this lock, one command
// at a time per Keychain account.
//
// The lock is a directory, made with mkdir, which either creates it or fails: atomic on one host.
// The holder writes its pid inside. A lock whose pid is no longer a process is stale, left by a
// command that was killed, and is taken over. A live holder is waited for, up to a timeout.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { SecretError } from "./secrets.ts";

export type LockOptions = { path: string; retryMs?: number; timeoutMs?: number };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: a process of another user holds that pid, which is still a live process.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Removes the lock at `path` if it is still the one `pid` left. Two takers could otherwise both
 * see the same stale lock, and the second remove the lock the first had just made; so the check and
 * the removal happen under a second, short lock. That one is only ever held for a few file
 * operations, so one older than ten seconds was left by a killed taker and is cleared.
 */
function takeOver(path: string, pid: number): boolean {
  const guard = `${path}.takeover`;
  try {
    mkdirSync(guard);
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > 10_000) rmSync(guard, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
    return false;
  }
  try {
    if (Number.parseInt(readFileSync(`${path}/pid`, "utf8"), 10) === pid) rmSync(path, { recursive: true, force: true });
  } catch {
    // Gone already, or a new holder between its mkdir and its pid write: left alone.
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
  return true;
}

/** Takes the lock at `path`, waiting for a live holder; resolves to the function that releases it. */
export async function acquireLock({ path, retryMs = 100, timeoutMs = 60_000 }: LockOptions): Promise<() => void> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(`${path}/pid`, String(process.pid));
      return () => rmSync(path, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid: number | null = null;
    try {
      pid = Number.parseInt(readFileSync(`${path}/pid`, "utf8"), 10);
    } catch {
      // Between the holder's mkdir and its pid write: treated as live.
    }
    if (pid !== null && Number.isInteger(pid) && pid > 0 && !alive(pid)) {
      // Taken over: try again at once. Another taker is at it: give it a moment.
      if (!takeOver(path, pid)) await Bun.sleep(retryMs);
      continue;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new SecretError(`another school command${pid === null || Number.isNaN(pid) ? "" : ` (pid ${pid})`} is resolving School's secrets and holds ${path}; wait for it to finish, or remove that directory if no school command is running`, 1);
    }
    await Bun.sleep(retryMs);
  }
}
