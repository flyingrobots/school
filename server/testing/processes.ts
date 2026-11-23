// Starting School and the bridge as real processes in tests (flyingrobots/school#69). This is the
// one place the start-up numbers live; it is a test helper and is not shipped in the image
// (server/.dockerignore, checked by server/docker.test.ts).
//
// - READY_MS (10 s): how long one process may take, from the call to answering its readiness
//   endpoint, before start() fails. The failure names the process, the time it waited, what the
//   last probe got, and everything the process wrote to stdout and stderr, so a slow start is told
//   apart from a broken one.
// - WORK_MS (5 s, Bun's default timeout): what a hook or test gets for its own work.
// - timeout(starts): the explicit timeout for a hook or test that starts `starts` processes,
//   starts × READY_MS + WORK_MS, always larger than the readiness poll, so a slow start fails
//   here, with the reason, rather than as a bare hook timeout.
//
// Where a start's time goes (flyingrobots/school#129). Measured on a 10-core Mac at load average
// ~40: creating a PGlite cluster in an empty directory (its initdb) takes 2.5 to 4 s, applying the
// migrations to it another 0.25 to 0.35 s, and opening an already migrated copy 0.15 to 0.3 s;
// Bun itself starts in milliseconds and the server builds nothing (it serves web/dist as files). So
// a server given an empty `pglite:` directory spent nearly all of its start in initdb, and with
// several suites running at once that passed READY_MS. Instead, startSchool gives each server a
// record that is already created and migrated: the first start in a test process opens one
// template record through openDatabase, exactly as a server's first start does, closes it, and
// every start whose `pglite:` directory does not exist yet gets a copy of it. Each test still gets
// a record of its own, empty of learner data, that no other server shares, and the server still
// runs its migrations on it at start (finding none to apply). The template's cost counts against
// the first start's READY_MS. A test about what the server does with a record that is not there
// yet (server/startup.test.ts) passes `{ record: "server" }` and gets no copy.
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
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { openDatabase } from "../adapters/database.ts";

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
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string, readonly stdout = "") { super(message); }
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
  /** When the start began (Date.now()), if before this call: READY_MS runs from then. */
  began?: number;
  /** The readiness budget, READY_MS unless a test of this helper shortens it. */
  readyMs?: number;
};

const hostPart = (host: string) => (host.includes(":") ? `[${host}]` : host);

/** Spawns `script` and polls `url + path` until `ready`, until READY_MS after `began`. Throws NotStarted. */
export async function start(spec: Spec): Promise<Started> {
  const began = spec.began ?? Date.now();
  const readyMs = spec.readyMs ?? READY_MS;
  const proc = Bun.spawn(["bun", spec.script], { env: spec.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  let port = typeof spec.port === "number" ? spec.port : null;
  const urlOf = (p: number) => `http://${hostPart(spec.host)}:${p}`;
  const deadline = began + readyMs;
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
  const [stdout, stderr] = [await out.done, await err.done];
  const waited = Date.now() - began;
  const why = exited ? `exited with code ${code} before it was ready, after ${waited} ms` : `was not ready within ${readyMs} ms (waited ${waited} ms; last: ${last})`;
  const at = port === null ? "(no port announced)" : urlOf(port) + spec.path;
  throw new NotStarted(`${spec.name} (${spec.script}) ${why} at ${at}; its stdout:\n${stdout || "(empty)"}\nits stderr:\n${stderr || "(empty)"}`, exited ? code : null, stderr, stdout);
}

let template: Promise<string> | null = null;

/**
 * A PGlite record created and migrated by openDatabase, as a server's first start does, then
 * closed: made once per test process, in a temporary directory removed when the process exits.
 */
export function migratedRecord(): Promise<string> {
  template ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "school-record-template-"));
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, "record");
    const opened = await openDatabase({ driver: "pglite", dir });
    await opened.close();
    return dir;
  })();
  return template;
}

/** Copies the migrated template to the `pglite:` record `env` names, if it is an absolute directory that does not exist yet. */
async function seedRecord(env: Record<string, string | undefined>): Promise<void> {
  const url = env.SCHOOL_DATABASE_URL;
  if (url === undefined || !url.startsWith("pglite:")) return;
  const dir = url.slice("pglite:".length);
  if (!isAbsolute(dir) || existsSync(dir)) return;
  cpSync(await migratedRecord(), dir, { recursive: true });
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
 * so a test can hand it a port that is already taken. A `pglite:` record that does not exist yet
 * is created as a copy of the migrated template (see the header) unless `opts.record` is "server".
 * `opts.readyMs` shortens READY_MS, for this helper's own tests of a start that never gets ready.
 */
export async function startSchool(env: Record<string, string | undefined>,
  opts: { script?: string; ports?: (host: string) => number | Promise<number>; record?: "template" | "server"; readyMs?: number } = {}): Promise<Started> {
  const began = Date.now();
  if ((opts.record ?? "template") === "template") await seedRecord(env);
  const host = env.HOST ?? "127.0.0.1";
  const tried: number[] = [];
  let last: NotStarted | null = null;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = await freshPort(opts.ports ?? probePort, host);
    tried.push(port);
    reserved.add(port);
    try {
      const s = await start({ name: "School", script: opts.script ?? SERVER, host, port, path: "/api/courses", ready: (r) => r.ok, env: { ...env, PORT: String(port) },
        began: attempt === 0 ? began : undefined, readyMs: opts.readyMs });
      s.proc.exited.then(() => reserved.delete(port));
      return s;
    } catch (e) {
      reserved.delete(port);
      if (!portTaken(e)) throw e;
      last = e as NotStarted;
    }
  }
  throw new NotStarted(`School could not start: its port was taken (EADDRINUSE) on all ${PORT_ATTEMPTS} attempts, ports ${tried.join(", ")}. Last failure: ${last!.message}`, last!.exitCode, last!.stderr, last!.stdout);
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
