// The process helper's ports (flyingrobots/school#82): no test picks a port, two starts never
// share one, and a port that turns out to be taken is retried rather than failing the test.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotStarted, PORT_ATTEMPTS, announcedBridgePort, probePort, startBridge, startSchool, timeout, type Started } from "./processes.ts";

const TOKEN = "processes-token-0123456789";
const live: Started[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) { s.proc.kill(); await s.proc.exited; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function schoolEnv() {
  const root = mkdtempSync(join(tmpdir(), "school-ports-"));
  dirs.push(root);
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  const env = { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), HOST: "127.0.0.1" };
  delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_URL;
  delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_TOKEN;
  return env;
}
function bridgeEnv() {
  const root = mkdtempSync(join(tmpdir(), "school-ports-bridge-"));
  dirs.push(root);
  return { ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(root, "bridge.json") };
}

/** Holds a port open on 127.0.0.1, as another program would. */
const occupy = () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });

test("processes started at the same time never share a port, and each answers on the port it reports", async () => {
  const started = await Promise.all([startSchool(schoolEnv()), startSchool(schoolEnv()), startSchool(schoolEnv()), startBridge(bridgeEnv()), startBridge(bridgeEnv())]);
  live.push(...started);
  const ports = started.map((s) => s.port);
  expect(new Set(ports).size).toBe(ports.length);
  for (const s of started) {
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    expect((await fetch(s.url + "/")).status).toBeGreaterThan(0);
  }
}, timeout(5));

test("a PORT or SCHOOL_BRIDGE_PORT inherited from the environment is ignored, not trusted", async () => {
  const held = occupy();
  try {
    const school = await startSchool({ ...schoolEnv(), PORT: String(held.port) });
    live.push(school);
    const bridge = await startBridge({ ...bridgeEnv(), SCHOOL_BRIDGE_PORT: String(held.port) });
    live.push(bridge);
    expect(school.port).not.toBe(held.port);
    expect(bridge.port).not.toBe(held.port);
  } finally {
    held.stop(true);
  }
}, timeout(2));

test("School started on a port that is already taken is retried on a fresh one", async () => {
  const held = occupy();
  const handed: number[] = [];
  try {
    const s = await startSchool(schoolEnv(), { ports: () => { const p = handed.length === 0 ? held.port : probePort(); handed.push(p); return p; } });
    live.push(s);
    expect(handed.length).toBe(2);
    expect(handed[0]).toBe(held.port);
    expect(s.port).toBe(handed[1]!);
    expect((await fetch(s.url + "/api/courses")).ok).toBe(true);
  } finally {
    held.stop(true);
  }
}, timeout(2));

test("School whose port is taken on every attempt fails with EADDRINUSE and the ports it tried", async () => {
  const held = occupy();
  let calls = 0;
  try {
    const e = await startSchool(schoolEnv(), { ports: () => { calls++; return held.port; } }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(NotStarted);
    expect(calls).toBe(PORT_ATTEMPTS);
    expect(e.message).toContain("EADDRINUSE");
    expect(e.message).toContain(`ports ${Array(PORT_ATTEMPTS).fill(held.port).join(", ")}`);
    expect(e.exitCode).not.toBeNull();
  } finally {
    held.stop(true);
  }
}, timeout(PORT_ATTEMPTS));

test("a start that fails for another reason is not retried", async () => {
  let calls = 0;
  const e = await startSchool({ ...schoolEnv(), SCHOOL_MOUNTS: `api=${tmpdir()}` }, { ports: (h) => { calls++; return probePort(h); } }).then(() => null, (x) => x);
  expect(e).toBeInstanceOf(NotStarted);
  expect(calls).toBe(1);
}, timeout(1));

test("the bridge's port is read from its bridge.listening line", () => {
  expect(announcedBridgePort("")).toBeNull();
  expect(announcedBridgePort('{"kind":"bridge.start","port":0}\n')).toBeNull();
  expect(announcedBridgePort('{"kind":"bridge.start","port":0}\n{"kind":"bridge.listening","host":"127.0.0.1","port":41234}\n')).toBe(41234);
  expect(announcedBridgePort('{"kind":"bridge.listening","host":"127.0.0.1","po')).toBeNull();
});
