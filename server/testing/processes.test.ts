// The process helper's ports (flyingrobots/school#82): no test picks a port, two starts never
// share one, and a port that turns out to be taken is retried rather than failing the test. Its
// start-up (flyingrobots/school#129): each server gets a migrated record of its own, and a start
// that never gets ready says how long it waited and what the process wrote.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrations } from "../db/migrate.ts";
import { NotStarted, PORT_ATTEMPTS, announcedBridgePort, migratedRecord, probePort, startBridge, startSchool, timeout, type Started } from "./processes.ts";
import { ownerQuery } from "./record.ts";

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
  const env = { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, HOST: "127.0.0.1" };
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

// flyingrobots/school#129: a server gets a record already created and migrated, a copy of its own.
test("each School start on a pglite: record that does not exist gets a migrated copy of its own, and applies no migration", async () => {
  const versions = readMigrations().map((m) => m.version);
  const a = schoolEnv();
  const first = await startSchool(a);
  first.proc.kill();
  const ran = await first.output();
  expect(ran.stdout).toContain("school: record in PGlite at");
  expect(ran.stdout).not.toContain("applied migration");
  const record = (env: Record<string, string | undefined>) => env.SCHOOL_DATABASE_URL!.slice("pglite:".length);
  const applied = async (dir: string) => (await ownerQuery<{ version: number }>(dir, "SELECT version FROM public.schema_migrations ORDER BY version")).map((r) => Number(r.version));
  expect(await applied(record(a))).toEqual(versions);
  // Writing to one copy reaches neither the template nor a record copied after it.
  await ownerQuery(record(a), "CREATE TABLE public.only_in_a (x int)");
  const b = schoolEnv();
  const second = await startSchool(b);
  second.proc.kill();
  await second.proc.exited;
  const has = async (dir: string) => (await ownerQuery<{ n: number }>(dir, "SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'only_in_a'"))[0]!.n;
  expect(record(b)).not.toBe(record(a));
  expect(await has(record(a))).toBe(1);
  expect(await has(record(b))).toBe(0);
  expect(await has(await migratedRecord())).toBe(0);
  expect(await applied(record(b))).toEqual(versions);
}, timeout(2) + 10_000);

test("with record: \"server\" the server creates and migrates the record itself", async () => {
  const env = schoolEnv();
  const s = await startSchool(env, { record: "server" });
  s.proc.kill();
  const { stdout } = await s.output();
  expect(stdout).toContain(`applied migration(s) ${readMigrations().map((m) => m.version).join(", ")}`);
}, timeout(1));

test("a start that is never ready fails with the time it waited and everything the process wrote", async () => {
  const script = join(import.meta.dir, "fixtures", "never-ready.ts");
  const began = Date.now();
  // The fake process never reads the record, so skip seeding: on a fresh process it migrates a template,
  // which can use the whole readyMs before the process starts (flyingrobots/school#215).
  const e = await startSchool(schoolEnv(), { script, readyMs: 1_000, record: "server" }).then(() => null, (x) => x);
  expect(e).toBeInstanceOf(NotStarted);
  expect(Date.now() - began).toBeGreaterThanOrEqual(1_000);
  expect(e.exitCode).toBeNull();
  expect(e.message).toMatch(/was not ready within 1000 ms \(waited \d+ ms; last: /);
  expect(e.message).toContain("its stdout:\nstill opening the record");
  expect(e.message).toContain("its stderr:\na warning on stderr");
  expect(e.stdout).toContain("still opening the record");
  expect(e.stderr).toContain("a warning on stderr");
}, timeout(1));
