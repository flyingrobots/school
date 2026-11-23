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
//
// Ports (flyingrobots/school#82). No test picks a port; this helper does, and sets PORT and
// SCHOOL_BRIDGE_PORT itself, overriding anything the caller or the shell passed.
// - The bridge is started on port 0, so the OS binds it to a free port, and announces the port it
//   got in its `bridge.listening` log line. The helper reads that line from stdout.
// - School refuses PORT=0 (server/config.ts, pinned by server/config.test.ts), so the helper asks
//   the OS for a free port by binding a probe socket on port 0 and closing it, then starts School
//   there. Another socket can take the port between the probe and School's bind; a start that
//   exits with EADDRINUSE is retried on a fresh port, up to PORT_ATTEMPTS times. A port handed to
//   a process started here stays reserved until that process exits, so two starts in one test
//   run never get the same probe port.
import type { Subprocess } from "bun";
import { join } from "node:path";

export const READY_MS = 10_000;
export const WORK_MS = 5_000;
export const PORT_ATTEMPTS = 5;
export const timeout = (starts: number) => starts * READY_MS + WORK_MS;

const SERVER = join(import.meta.dir, "..", "server.ts");
const BRIDGE = join(import.meta.dir, "..", "..", "bridge", "bridge.ts");

/** A started process, with everything it writes collected so its pipes never fill. */
export type Started = {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  url: string;
  /** The port the process is listening on. */
  port: number;
  /** Waits for the process to exit and returns all it wrote. */
  output(): Promise<{ stdout: string; stderr: string }>;
};

/** Why a process did not become ready: it exited, or the budget ran out. */
export class NotStarted extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) { super(message); }
}

/** Ports given to processes this helper started and that have not exited yet. */
const reserved = new Set<number>();

/** A port the OS reports free on `hostname`: bind a probe socket on port 0, read its port, close it. */
export function probePort(hostname = "127.0.0.1"): number {
  const probe = Bun.listen({ hostname, port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Collects a stream as text while it is written, so the start-up can read lines before the process exits. */
function collect(stream: ReadableStream<Uint8Array>) {
  let text = "";
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    return text;
  })();
  return { now: () => text, done };
}

type Spec = {
  name: string; script: string; host: string; path: string; ready: (r: Response) => boolean; env: Record<string, string | undefined>;
  /** The port the process was told to use, or `announced` to read it from stdout. */
  port: number | { announced: (stdout: string) => number | null };
};

const hostPart = (host: string) => (host.includes(":") ? `[${host}]` : host);

/** Spawns `script` and polls `url + path` until `ready`, for at most READY_MS. Throws NotStarted. */
export async function start(spec: Spec): Promise<Started> {
  const proc = Bun.spawn(["bun", spec.script], { env: spec.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  let port = typeof spec.port === "number" ? spec.port : null;
  const urlOf = (p: number) => `http://${hostPart(spec.host)}:${p}`;
  const deadline = Date.now() + READY_MS;
  // A probe that reaches whatever else holds the port may never be answered; stop waiting when the process exits.
  const gone = new AbortController();
  proc.exited.then(() => gone.abort(new Error("the process exited")));
  let last = "no answer yet";
  while (Date.now() < deadline && proc.exitCode === null) {
    if (port === null && typeof spec.port !== "number") {
      port = spec.port.announced(out.now());
      if (port === null) {
        last = "no port announced on stdout yet";
        await Bun.sleep(20);
        continue;
      }
      reserved.add(port);
      const p = port;
      proc.exited.then(() => reserved.delete(p));
    }
    try {
      const r = await fetch(urlOf(port!) + spec.path, { signal: AbortSignal.any([gone.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
      if (spec.ready(r)) {
        return { proc, url: urlOf(port!), port: port!, output: async () => { await proc.exited; return { stdout: await out.done, stderr: await err.done }; } };
      }
      last = `answered ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(50);
  }
  const exited = proc.exitCode !== null;
  if (!exited) proc.kill("SIGKILL");
  const code = await proc.exited;
  const stderr = await err.done;
  const why = exited ? `exited with code ${code} before it was ready` : `was not ready within ${READY_MS} ms (last: ${last})`;
  const at = port === null ? "(no port announced)" : urlOf(port) + spec.path;
  throw new NotStarted(`${spec.name} (${spec.script}) ${why} at ${at}; its stderr:\n${stderr || "(empty)"}`, exited ? code : null, stderr);
}

/** True when a start failed only because its port was taken. */
const portTaken = (e: unknown) => e instanceof NotStarted && e.exitCode !== null && /EADDRINUSE/.test(e.stderr);

/** A free port no live process from this helper holds. */
async function freshPort(source: (host: string) => number | Promise<number>, host: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const p = await source(host);
    if (!reserved.has(p)) return p;
  }
  throw new Error("could not find a port that is not already reserved by a running test process");
}

/**
 * School's server, ready when GET /api/courses is ok. `env` is its whole environment; PORT is
 * chosen here (see the header) and any PORT in `env` is ignored. `opts.ports` replaces the probe,
 * so a test can hand it a port that is already taken.
 */
export async function startSchool(env: Record<string, string | undefined>, opts: { script?: string; ports?: (host: string) => number | Promise<number> } = {}): Promise<Started> {
  const host = env.HOST ?? "127.0.0.1";
  const tried: number[] = [];
  let last: NotStarted | null = null;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = await freshPort(opts.ports ?? probePort, host);
    tried.push(port);
    reserved.add(port);
    try {
      const s = await start({ name: "School", script: opts.script ?? SERVER, host, port, path: "/api/courses", ready: (r) => r.ok, env: { ...env, PORT: String(port) } });
      s.proc.exited.then(() => reserved.delete(port));
      return s;
    } catch (e) {
      reserved.delete(port);
      if (!portTaken(e)) throw e;
      last = e as NotStarted;
    }
  }
  throw new NotStarted(`School could not start: its port was taken (EADDRINUSE) on all ${PORT_ATTEMPTS} attempts, ports ${tried.join(", ")}. Last failure: ${last!.message}`, last!.exitCode, last!.stderr);
}

/** The port in the bridge's `bridge.listening` log line, once it has written one. */
export function announcedBridgePort(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"bridge.listening"')) continue;
    try {
      const l = JSON.parse(line);
      if (l.kind === "bridge.listening" && Number.isInteger(l.port) && l.port > 0) return l.port;
    } catch { /* a partly written line: read it again on the next poll */ }
  }
  return null;
}

/**
 * The bridge, ready when GET /health refuses a request without the token. It is started on port 0
 * and the helper reads the port it got from its stdout; any SCHOOL_BRIDGE_PORT in `env` is ignored.
 */
export function startBridge(env: Record<string, string | undefined>, opts: { script?: string } = {}): Promise<Started> {
  return start({ name: "The bridge", script: opts.script ?? BRIDGE, host: env.SCHOOL_BRIDGE_HOST ?? "127.0.0.1", path: "/health", ready: (r) => r.status === 401,
    env: { ...env, SCHOOL_BRIDGE_PORT: "0" }, port: { announced: announcedBridgePort } });
}
