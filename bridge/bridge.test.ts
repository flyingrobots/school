// The bridge over HTTP, as the real process (flyingrobots/school#10).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, timeout, type Started } from "../server/testing/processes.ts";

// Every test gets its own bridge, directory and port: none depends on another having run first.
let dir = "";
let base = "";
const TOKEN = "test-token-0123456789";
let bridge: Started | null = null;

const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "school-bridge-http-"));
  const good = join(dir, "good");
  writeFileSync(good, `#!/bin/sh\necho '{"ok": true}'\n`);
  chmodSync(good, 0o755);
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ timeout_seconds: 5, agents: [
    { name: "missing", command: "no-such-cli-qqq {prompt}" },
    { name: "good", command: `${good} {prompt}` },
  ] }));
  bridge = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json") });
  base = bridge.url;
}, timeout(1));
afterEach(async () => {
  bridge?.proc.kill();
  await bridge?.proc.exited;
  bridge = null;
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
  bridge!.proc.kill();
  const out = (await bridge!.output()).stdout;
  bridge = null;
  const lines = out.trim().split("\n");
  for (const l of lines) expect(typeof JSON.parse(l).kind).toBe("string");
  expect(out).not.toContain("SECRET-LEARNER-TEXT");
});

// The bridge's agents are declared in its own file on the host (flyingrobots/school#13, narrowed
// by flyingrobots/school#18): over HTTP they can be reordered, turned on and off, and tested, but
// no request can write a command.
test("a bridge with no configuration file starts, reports itself unconfigured, and takes its agents only from that file", async () => {
  const d = mkdtempSync(join(tmpdir(), "school-bridge-fresh-"));
  const file = join(d, "nested", "bridge.json");
  const p = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: file });
  const at = p.url;
  const send = (method: string, path: string, body?: unknown) =>
    fetch(at + path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    expect(await (await send("GET", "/health")).json()).toMatchObject({ status: "unconfigured", agents: [] });
    expect(await (await send("GET", "/config")).json()).toMatchObject({ status: "unconfigured", raw: { agents: [] } });
    expect(await (await send("POST", "/run", { prompt: "p", schema })).json()).toMatchObject({ status: "failed", error: expect.stringContaining(file) });

    // With no file, nothing can be configured over HTTP, a whole configuration least of all.
    const good = join(d, "good");
    writeFileSync(good, `#!/bin/sh\necho '{"ok": true}'\n`);
    chmodSync(good, 0o755);
    const config = { timeout_seconds: 5, agents: [{ name: "good", command: `${good} {prompt}`, output: "text" }, { name: "other", command: "no-such-cli-qqq" }] };
    const none = await send("PUT", "/config", config);
    expect(none.status).toBe(409);
    expect((await none.json()).error).toContain(file);
    expect(existsSync(file)).toBe(false);

    // An invalid file is reported with its reason.
    mkdirSync(join(d, "nested"), { recursive: true });
    writeFileSync(file, JSON.stringify({ agents: [{ name: "x", command: 'oops "unbalanced' }] }));
    expect(await (await send("GET", "/health")).json()).toMatchObject({ status: "misconfigured", error: expect.stringMatching(/quote/) });

    // The learner writes the file on the host.
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    const written = readFileSync(file, "utf8");
    expect(await (await send("GET", "/config")).json()).toMatchObject({ status: "ok", raw: config });

    // A command, or any field but the order and the switch, is refused and the file is untouched.
    for (const body of [config, { agents: [{ name: "good", command: "touch x" }, { name: "other" }] }, { agents: [{ name: "good", output: "claude-json" }, { name: "other" }] },
      { agents: [{ name: "good" }, { name: "other" }], timeout_seconds: 900 }, { agents: [{ name: "good" }] }, { agents: [{ name: "good" }, { name: "other" }, { name: "new", command: "x" }] }]) {
      const r = await send("PUT", "/config", body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(readFileSync(file, "utf8")).toBe(written);

    // Reordering and switching an agent off keeps every command as written.
    expect(await (await send("PUT", "/config", { agents: [{ name: "other", enabled: false }, { name: "good" }] })).json())
      .toMatchObject({ status: "saved", agents: [{ name: "other", enabled: false, found: false }, { name: "good", enabled: true, found: true }] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ timeout_seconds: 5, agents: [{ ...config.agents[1], enabled: false }, config.agents[0]] });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    expect(await (await send("POST", "/test", { agent: "good" })).json()).toMatchObject({ status: "succeeded", output: { ok: true } });
    expect((await send("POST", "/test", { agent: "nobody" })).status).toBe(404);
    expect((await fetch(at + "/config", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  } finally {
    p.proc.kill();
    await p.proc.exited;
    rmSync(d, { recursive: true, force: true });
  }
}, timeout(1));

// flyingrobots/school#134: a taken port was Bun's uncaught-error output on stderr, a source excerpt
// and a stack frame, which a consumer reading the bridge's output line by line cannot parse.
test("a bridge whose port is taken writes one bridge.error line naming it, nothing but JSON Lines, and exits 2", async () => {
  const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "bridge.ts")], {
      env: { ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json"), SCHOOL_BRIDGE_HOST: "127.0.0.1", SCHOOL_BRIDGE_PORT: String(holder.port) },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const lines = [...stdout.split("\n"), ...stderr.split("\n")].filter((l) => l !== "");
    for (const l of lines) {
      let parsed: unknown;
      try { parsed = JSON.parse(l); } catch { throw new Error(`not a JSON line: ${l}\n--- stdout\n${stdout}--- stderr\n${stderr}`); }
      expect(typeof (parsed as { kind?: unknown }).kind).toBe("string");
    }
    const errors = lines.map((l) => JSON.parse(l)).filter((l) => l.kind === "bridge.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ host: "127.0.0.1", port: holder.port });
    expect(errors[0].message).toContain(`127.0.0.1:${holder.port}`);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!).kind).toBe("bridge.error");
    expect(stdout + stderr).not.toContain(TOKEN);
    expect(code).toBe(2);
  } finally {
    holder.stop(true);
  }
}, timeout(1));
