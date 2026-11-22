// Starting School and the bridge as real processes in tests (flyingrobots/school#69). This is the
// one place the start-up numbers live; it is a test helper and is not shipped in the image
// (server/.dockerignore, checked by server/docker.test.ts).
//
// - READY_MS (10 s): how long one process may take to answer its readiness endpoint before
//   start() fails with a message naming it and its stderr. A start takes well under a second
//   locally; this is headroom for a slow CI runner.
// - WORK_MS (5 s, Bun's default timeout): what a hook or test gets for its own work.
// - timeout(starts): the explicit timeout for a hook or test that starts `starts` processes,
//   starts × READY_MS + WORK_MS, always larger than the readiness poll, so a slow start fails
//   here, with the reason, rather than as a bare hook timeout.
import type { Subprocess } from "bun";
import { join } from "node:path";

export const READY_MS = 10_000;
export const WORK_MS = 5_000;
export const timeout = (starts: number) => starts * READY_MS + WORK_MS;

const SERVER = join(import.meta.dir, "..", "server.ts");
const BRIDGE = join(import.meta.dir, "..", "..", "bridge", "bridge.ts");

/** A started process, with everything it writes collected so its pipes never fill. */
export type Started = {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  url: string;
  /** Waits for the process to exit and returns all it wrote. */
  output(): Promise<{ stdout: string; stderr: string }>;
};

/** Why a process did not become ready: it exited, or the budget ran out. */
export class NotStarted extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) { super(message); }
}

type Spec = { name: string; script: string; url: string; path: string; ready: (r: Response) => boolean; env: Record<string, string | undefined> };

/** Spawns `script` and polls `url + path` until `ready`, for at most READY_MS. Throws NotStarted. */
export async function start(spec: Spec): Promise<Started> {
  const proc = Bun.spawn(["bun", spec.script], { env: spec.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const started: Started = { proc, url: spec.url, output: async () => { await proc.exited; return { stdout: await out, stderr: await err }; } };
  const deadline = Date.now() + READY_MS;
  let last = "no answer yet";
  while (Date.now() < deadline && proc.exitCode === null) {
    try {
      const r = await fetch(spec.url + spec.path, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      if (spec.ready(r)) return started;
      last = `answered ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(50);
  }
  const exited = proc.exitCode !== null;
  if (!exited) proc.kill("SIGKILL");
  const code = await proc.exited;
  const stderr = await err;
  const why = exited ? `exited with code ${code} before it was ready` : `was not ready within ${READY_MS} ms (last: ${last})`;
  throw new NotStarted(`${spec.name} (${spec.script}) ${why} at ${spec.url}${spec.path}; its stderr:\n${stderr || "(empty)"}`, exited ? code : null, stderr);
}

/** School's server, ready when GET /api/courses is ok. `env` is its whole environment; PORT is required. */
export function startSchool(env: Record<string, string | undefined>, opts: { script?: string } = {}) {
  if (!env.PORT) throw new Error("startSchool needs PORT in its environment");
  return start({ name: "School", script: opts.script ?? SERVER, url: `http://${env.HOST ?? "127.0.0.1"}:${env.PORT}`, path: "/api/courses", ready: (r) => r.ok, env });
}

/** The bridge, ready when GET /health refuses a request without the token. SCHOOL_BRIDGE_PORT is required. */
export function startBridge(env: Record<string, string | undefined>, opts: { script?: string } = {}) {
  if (!env.SCHOOL_BRIDGE_PORT) throw new Error("startBridge needs SCHOOL_BRIDGE_PORT in its environment");
  return start({ name: "The bridge", script: opts.script ?? BRIDGE, url: `http://127.0.0.1:${env.SCHOOL_BRIDGE_PORT}`, path: "/health", ready: (r) => r.status === 401, env });
}
