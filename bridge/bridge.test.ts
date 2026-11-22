// The bridge over HTTP, as the real process (flyingrobots/school#10).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "school-bridge-http-"));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token-0123456789";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

beforeAll(async () => {
  const good = join(dir, "good");
  writeFileSync(good, `#!/bin/sh\necho '{"ok": true}'\n`);
  chmodSync(good, 0o755);
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ timeout_seconds: 5, agents: [
    { name: "missing", command: "no-such-cli-qqq {prompt}" },
    { name: "good", command: `${good} {prompt}` },
  ] }));
  proc = Bun.spawn(["bun", join(import.meta.dir, "bridge.ts")], {
    env: { ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json"), SCHOOL_BRIDGE_PORT: String(PORT) },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).status === 401) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("bridge did not start");
});
afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };
const run = (body: unknown, headers: Record<string, string> = { ...auth, "content-type": "application/json" }) =>
  fetch(base + "/run", { method: "POST", headers, body: JSON.stringify(body) });

test("every request needs the token", async () => {
  expect((await fetch(base + "/health")).status).toBe(401);
  expect((await fetch(base + "/health", { headers: { authorization: "Bearer wrong-token-0123456" } })).status).toBe(401);
  expect((await run({ prompt: "p", schema }, { "content-type": "application/json" })).status).toBe(401);
});

test("health lists the agents and whether each program was found", async () => {
  const h = await (await fetch(base + "/health", { headers: auth })).json();
  expect(h.agents).toEqual([{ name: "missing", enabled: true, found: false }, { name: "good", enabled: true, found: true }]);
});

test("a run falls back past the missing agent and returns the answer with every attempt", async () => {
  const r = await (await run({ prompt: "Is it ok?", schema })).json();
  expect(r).toMatchObject({ status: "succeeded", agent: "good", output: { ok: true } });
  expect(r.attempts.map((a: { agent: string; status: string }) => [a.agent, a.status])).toEqual([["missing", "skipped"], ["good", "succeeded"]]);
});

test("bad requests are refused", async () => {
  expect((await run({ prompt: "p", schema }, { ...auth, "content-type": "text/plain" })).status).toBe(415);
  expect((await run({ prompt: "", schema })).status).toBe(400);
  expect((await run({ prompt: "p", schema: [] })).status).toBe(400);
});

test("logs are JSON Lines and never contain the prompt", async () => {
  await run({ prompt: "SECRET-LEARNER-TEXT", schema });
  proc!.kill();
  await proc!.exited;
  const out = await new Response(proc!.stdout as ReadableStream).text();
  proc = null;
  const lines = out.trim().split("\n");
  for (const l of lines) expect(typeof JSON.parse(l).kind).toBe("string");
  expect(out).not.toContain("SECRET-LEARNER-TEXT");
});

// Configuring the bridge from School's settings page (flyingrobots/school#13).
test("a bridge with no configuration file starts, reports itself unconfigured, and accepts one", async () => {
  const d = mkdtempSync(join(tmpdir(), "school-bridge-fresh-"));
  const port = PORT + 7;
  const p = Bun.spawn(["bun", join(import.meta.dir, "bridge.ts")], {
    env: { ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(d, "nested", "bridge.json"), SCHOOL_BRIDGE_PORT: String(port) },
    stdout: "ignore", stderr: "ignore",
  });
  const at = `http://127.0.0.1:${port}`;
  const send = (method: string, path: string, body?: unknown) =>
    fetch(at + path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(at + "/health")).status === 401) break; } catch {} await Bun.sleep(50); }
    expect(await (await send("GET", "/health")).json()).toMatchObject({ status: "unconfigured", agents: [] });
    expect(await (await send("GET", "/config")).json()).toMatchObject({ status: "unconfigured", raw: { agents: [] } });
    expect(await (await send("POST", "/run", { prompt: "p", schema })).json()).toMatchObject({ status: "failed", error: expect.stringMatching(/no agents/) });

    // An invalid configuration is refused with its reason, and nothing is written.
    const bad = await send("PUT", "/config", { agents: [{ name: "x", command: 'oops "unbalanced' }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/quote/);
    expect(existsSync(join(d, "nested", "bridge.json"))).toBe(false);

    const good = join(d, "good");
    writeFileSync(good, `#!/bin/sh\necho '{"ok": true}'\n`);
    chmodSync(good, 0o755);
    const config = { timeout_seconds: 5, agents: [{ name: "good", command: `${good} {prompt}`, output: "text" }] };
    expect(await (await send("PUT", "/config", config)).json()).toMatchObject({ status: "saved", agents: [{ name: "good", found: true }] });
    expect(JSON.parse(readFileSync(join(d, "nested", "bridge.json"), "utf8"))).toEqual(config);
    expect(statSync(join(d, "nested", "bridge.json")).mode & 0o777).toBe(0o600);
    expect(await (await send("GET", "/config")).json()).toMatchObject({ status: "ok", raw: config });

    expect(await (await send("POST", "/test", { agent: "good" })).json()).toMatchObject({ status: "succeeded", output: { ok: true } });
    expect((await send("POST", "/test", { agent: "nobody" })).status).toBe(404);
    expect((await fetch(at + "/config", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  } finally {
    p.kill();
    await p.exited;
    rmSync(d, { recursive: true, force: true });
  }
});
