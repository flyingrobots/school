// The bridge over HTTP, as the real process (flyingrobots/school#10).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

// flyingrobots/school#123 (SEC-T1): the token comes from the environment, else from the Keychain
// item `school up` stores (host/secrets.ts). Here the account is a fresh name that holds nothing, so
// the test reads no existing Keychain item and writes none.
test("SEC-T1: with no token in the environment or the Keychain the bridge refuses to start, exit 2, naming both places", async () => {
  const account = `school-test-${crypto.randomUUID().slice(0, 8)}`;
  const env: Record<string, string | undefined> = { ...process.env, SCHOOL_KEYCHAIN_ACCOUNT: account, SCHOOL_BRIDGE_PORT: "0" };
  delete env.SCHOOL_BRIDGE_TOKEN;
  const p = Bun.spawn(["bun", join(import.meta.dir, "bridge.ts")], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(2);
  const error = (stdout + stderr).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).find((l) => l.kind === "bridge.error");
  expect(error?.message).toContain("SCHOOL_BRIDGE_TOKEN");
  expect(error?.message).toContain(`Keychain (account ${account})`);
});

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

// flyingrobots/school#287: the `ask` list (RFC 6 §5.4) is reported by /health and reordered by
// PUT /config as the grading list is: every declared agent named once, only `name` and `enabled`.
describe("the ask list in /health and PUT /config", () => {
  const send = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const file = () => join(dir, "bridge.json");
  /** A configuration of one grading agent and the ask agents `ask` (a list that is not checked here). */
  function write(ask: unknown): string {
    const config = { timeout_seconds: 5, agents: [{ name: "good", command: `${join(dir, "good")} {prompt}` }], ...(ask === undefined ? {} : { ask }) };
    writeFileSync(file(), JSON.stringify(config, null, 2) + "\n");
    return readFileSync(file(), "utf8");
  }
  // Built per test: `dir` is set by beforeEach.
  const two = () => ({ timeout_seconds: 60, agents: [{ name: "first", command: "no-such-cli-qqq {prompt}", output: "claude-stream-json" }, { name: "second", command: `${join(dir, "good")} {prompt}`, output: "text" }] });

  test("health lists the ask agents and whether each program was found", async () => {
    write(two());
    expect(await (await send("GET", "/health")).json()).toMatchObject({ status: "ok",
      ask: [{ name: "first", enabled: true, found: false }, { name: "second", enabled: true, found: true }] });
  });

  test("health reports no ask list as null", async () => {
    write(undefined);
    expect(await (await send("GET", "/health")).json()).toMatchObject({ status: "ok", ask: null });
  });

  test("health reports an empty ask list as misconfigured, with its reason", async () => {
    write({ agents: [] });
    expect(await (await send("GET", "/health")).json()).toMatchObject({ status: "misconfigured", error: 'list at least one agent under "ask"' });
  });

  test("golden: PUT /config reorders two ask agents and saves them to bridge.json, the grading list as written", async () => {
    write(two());
    const before = JSON.parse(readFileSync(file(), "utf8"));
    const r = await send("PUT", "/config", { ask: { agents: [{ name: "second" }, { name: "first", enabled: false }] } });
    expect(await r.json()).toEqual({ status: "saved", agents: [{ name: "good", enabled: true, found: true }],
      ask: [{ name: "second", enabled: true, found: true }, { name: "first", enabled: false, found: false }] });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ ...before, ask: { timeout_seconds: 60, agents: [two().agents[1], { ...two().agents[0], enabled: false }] } });
  });

  test("PUT /config can reorder both lists in one request", async () => {
    write(two());
    writeFileSync(file(), JSON.stringify({ ...JSON.parse(readFileSync(file(), "utf8")), agents: [{ name: "good", command: "true" }, { name: "other", command: "true" }] }));
    const r = await send("PUT", "/config", { agents: [{ name: "other" }, { name: "good" }], ask: { agents: [{ name: "second" }, { name: "first" }] } });
    expect((await r.json()).status).toBe("saved");
    const saved = JSON.parse(readFileSync(file(), "utf8"));
    expect([saved.agents.map((a: { name: string }) => a.name), saved.ask.agents.map((a: { name: string }) => a.name)]).toEqual([["other", "good"], ["second", "first"]]);
  });

  test("a grading-only PUT /config keeps the ask list as written", async () => {
    write(two());
    const before = JSON.parse(readFileSync(file(), "utf8"));
    expect((await send("PUT", "/config", { agents: [{ name: "good", enabled: false }] })).status).toBe(200);
    expect(JSON.parse(readFileSync(file(), "utf8")).ask).toEqual(before.ask);
  });

  test("PUT /config refuses an ask list that does not name every declared ask agent once, by name and enabled only, and leaves the file as written", async () => {
    const written = write(two());
    for (const body of [
      { ask: { agents: [] } }, { ask: { agents: [{ name: "second" }] } }, { ask: { agents: [{ name: "first" }, { name: "first" }, { name: "second" }] } },
      { ask: { agents: [{ name: "first" }, { name: "second" }, { name: "new" }] } }, { ask: { agents: [{ name: "first", command: "touch x" }, { name: "second" }] } },
      { ask: { agents: [{ name: "first", enabled: "yes" }, { name: "second" }] } }, { ask: { timeout_seconds: 900, agents: [{ name: "first" }, { name: "second" }] } },
      { ask: [{ name: "first" }, { name: "second" }] }, { ask: null },
    ]) {
      const r = await send("PUT", "/config", body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(readFileSync(file(), "utf8")).toBe(written);
  });

  test("PUT /config refuses an ask list when the file declares none, and leaves the file as written", async () => {
    const written = write(undefined);
    const r = await send("PUT", "/config", { ask: { agents: [{ name: "first" }] } });
    expect([r.status, (await r.json()).error]).toEqual([400, `no "ask" list is declared in ${file()}`]);
    expect(readFileSync(file(), "utf8")).toBe(written);
  });
});

// flyingrobots/school#290: an agent that cannot be started (Bun.spawn throws: ENOENT here, E2BIG for
// a long prompt on Linux) is that agent's failed attempt, and the next agent is tried.
test("a grading whose first agent cannot be started falls back to the next and logs that attempt as failed", async () => {
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ timeout_seconds: 5, agents: [
    { name: "unstartable", command: `${join(dir, "no-such-folder", "agent")} {prompt}` },
    { name: "good", command: `${join(dir, "good")} {prompt}` },
  ] }));
  const r = await (await run({ prompt: "SECRET-LEARNER-TEXT", schema })).json();
  expect(r).toMatchObject({ status: "succeeded", agent: "good", output: { ok: true } });
  expect(r.attempts.map((a: { agent: string; status: string }) => [a.agent, a.status])).toEqual([["unstartable", "failed"], ["good", "succeeded"]]);
  bridge!.proc.kill();
  const out = (await bridge!.output()).stdout;
  bridge = null;
  const attempts = out.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "bridge.attempt");
  expect(attempts.map((a) => [a.agent, a.status, a.error])).toEqual([
    ["unstartable", "failed", `could not start ${join(dir, "no-such-folder", "agent")} (ENOENT)`], ["good", "succeeded", null]]);
  expect(out).not.toContain("SECRET-LEARNER-TEXT");
});

// flyingrobots/school#289: an answer's unexpected key is chosen by the model, and the attempt's
// error is logged, so the log line names only where the key was.
test("a grading answer with a hostile unexpected key logs an attempt error that quotes none of it", async () => {
  const probe = "The learner wrote: SECRET-LEARNER-TEXT";
  const hostile = join(dir, "hostile");
  writeFileSync(hostile, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ ok: true, [probe]: "x" })}'\n`);
  chmodSync(hostile, 0o755);
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ timeout_seconds: 5, agents: [{ name: "hostile", command: `${hostile} {prompt}` }] }));
  const r = await (await run({ prompt: "Is it ok?", schema })).json();
  expect(r.attempts).toEqual([expect.objectContaining({ agent: "hostile", status: "failed", error: "the answer did not match the schema: unexpected key at $" })]);
  bridge!.proc.kill();
  const out = (await bridge!.output()).stdout;
  bridge = null;
  const attempts = out.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "bridge.attempt");
  expect(attempts.map((a) => a.error)).toEqual(["the answer did not match the schema: unexpected key at $"]);
  expect(out).not.toContain("SECRET-LEARNER-TEXT");
  expect(out).not.toContain("The learner wrote");
});
