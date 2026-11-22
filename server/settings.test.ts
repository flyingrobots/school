// The settings page (flyingrobots/school#13): connect the bridge and edit its agents from School,
// through the real server and a real bridge. The only fake is the agent CLI.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveBridge } from "./settings.ts";

const root = mkdtempSync(join(tmpdir(), "school-settings-"));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BRIDGE_PORT = PORT + 1;
const base = `http://127.0.0.1:${PORT}`;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const TOKEN = "settings-token-NEVER-ECHO-ME";
const procs: ReturnType<typeof Bun.spawn>[] = [];
let serverOut: ReturnType<typeof Bun.spawn> | null = null;

const verdict = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "n" }, completeness: { verdict: "meets", note: "n" }, accessibility: { verdict: "meets", note: "n" },
  contradictions: [], summary: "Good.",
};

async function until(url: string, ok: (r: Response) => boolean) {
  for (let i = 0; i < 100; i++) {
    try { if (ok(await fetch(url))) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`${url} did not come up`);
}

beforeAll(async () => {
  writeFileSync(join(root, "verdict.json"), JSON.stringify(verdict));
  writeFileSync(join(root, "agent"), `#!/bin/sh\ncat "${root}/verdict.json"\n`);
  chmodSync(join(root, "agent"), 0o755);
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify({
    type: "page", id: "l1", title: "One", subtitle: "", children: [{ type: "explain", id: "e1", prompt: "Explain.", model: "M", sources: [] }],
  }));
  // A bridge with no configuration file yet: the settings page is how it gets one.
  const bridge = Bun.spawn(["bun", join(import.meta.dir, "..", "bridge", "bridge.ts")], {
    env: { ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(root, "bridge", "bridge.json"), SCHOOL_BRIDGE_PORT: String(BRIDGE_PORT) },
    stdout: "ignore", stderr: "ignore",
  });
  procs.push(bridge);
  await until(`${BRIDGE_URL}/health`, (r) => r.status === 401);
  // A server with no bridge configured at all, as the learner's was.
  const env = { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), PORT: String(PORT), HOST: "127.0.0.1" };
  delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_URL;
  delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_TOKEN;
  serverOut = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { env, stdout: "pipe", stderr: "pipe" });
  procs.push(serverOut);
  await until(base + "/", (r) => r.ok);
});
afterAll(async () => {
  for (const p of procs) { p.kill(); await p.exited; }
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const status = async () => (await fetch(base + "/api/settings/status")).json();
const everything: string[] = []; // every page and API body, checked for the token at the end
const text = async (r: Response) => { const t = await r.text(); everything.push(t); return t; };


test("with nothing configured, the status says so", async () => {
  expect(await status()).toMatchObject({ connection: "none" });
});

test("a wrong token and an unreachable bridge are each reported as such", async () => {
  expect((await post("/api/settings/bridge", { url: BRIDGE_URL, token: "wrong-token-but-long-enough" })).status).toBe(200);
  expect(await status()).toMatchObject({ connection: "unauthorised" });
  expect((await post("/api/settings/bridge", { url: "http://127.0.0.1:9", token: TOKEN })).status).toBe(200);
  expect(await status()).toMatchObject({ connection: "unreachable" });
});

test("bad settings are refused", async () => {
  expect((await post("/api/settings/bridge", { url: "ftp://x", token: TOKEN })).status).toBe(400);
  expect((await post("/api/settings/bridge", { url: BRIDGE_URL, token: "short" })).status).toBe(400);
});

test("saving the bridge connects it; the token is stored privately and never shown again", async () => {
  const saved = await post("/api/settings/bridge", { url: BRIDGE_URL, token: TOKEN });
  expect(saved.status).toBe(200);
  expect(await text(saved)).not.toContain(TOKEN);
  expect(await status()).toMatchObject({ connection: "unconfigured", agents: [] });
  const file = join(root, "state", "settings.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8")).bridge.url).toBe(BRIDGE_URL);
  const shown = JSON.parse(await text(await fetch(base + "/api/settings/bridge")));
  expect(shown).toEqual({ url: BRIDGE_URL, urlFrom: "settings", tokenSet: true, tokenFrom: "settings" });
  // Saving the URL alone keeps the saved token.
  expect((await post("/api/settings/bridge", { url: BRIDGE_URL })).status).toBe(200);
  expect(await status()).toMatchObject({ connection: "unconfigured" });
});

test("an invalid agent command is refused with its reason, and the bridge file is not written", async () => {
  const r = await post("/api/settings/agents", { timeout_seconds: 10, agents: [{ name: "x", command: 'oops "unbalanced', output: "text" }] });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toMatch(/quote/);
  expect(existsSync(join(root, "bridge", "bridge.json"))).toBe(false);
});

test("agents saved from the page reach the bridge, can be tested, and grading then works without a restart", async () => {
  const chain = { timeout_seconds: 10, agents: [
    { name: "missing", command: "no-such-agent-cli {prompt}", output: "text" },
    { name: "fake", command: `${join(root, "agent")} -p {prompt}`, output: "text" },
  ] };
  const saved = await post("/api/settings/agents", chain);
  expect(saved.status).toBe(200);
  expect(JSON.parse(readFileSync(join(root, "bridge", "bridge.json"), "utf8"))).toEqual(chain);
  expect(await (await fetch(base + "/api/settings/agents")).json()).toMatchObject({ raw: chain });
  expect(await status()).toMatchObject({ connection: "ok", agents: [{ name: "missing", found: false }, { name: "fake", found: true }] });

  const tested = await (await post("/api/settings/agents/test", { agent: "fake" })).json();
  expect(tested.status).toBe("failed"); // the fake agent answers the rubric, not {"ok": true}, and the test says so
  expect(tested.attempts[0].error).toMatch(/schema/);

  const e = JSON.parse(await text(await fetch(base + "/api/courses/c/lessons/l1"))).encounterId;
  const id = crypto.randomUUID();
  await post("/api/explanation", { submissionId: id, encounterId: e, blockId: "e1", text: "Because.", ms: 1 });
  const graded = await (await post("/api/grade", { submissionId: id })).json();
  expect(graded.status).toBe("succeeded");
});

test("the token appears in no page, no API response and no server output", async () => {
  everything.push(JSON.stringify(await status()), await text(await fetch(base + "/api/settings/agents")));
  for (const body of everything) expect(body).not.toContain(TOKEN);
  serverOut!.kill();
  await serverOut!.exited;
  const out = (await new Response(serverOut!.stdout as ReadableStream).text()) + (await new Response(serverOut!.stderr as ReadableStream).text());
  expect(out).not.toContain(TOKEN);
});

test("environment variables override saved settings, and the page says which", () => {
  const saved = { bridge: { url: "http://saved:1", token: "saved-token-0123456789" } };
  expect(effectiveBridge({}, saved)).toMatchObject({ url: "http://saved:1", urlFrom: "settings", tokenFrom: "settings" });
  expect(effectiveBridge({ SCHOOL_BRIDGE_URL: "http://env:2", SCHOOL_BRIDGE_TOKEN: "env-token-0123456789ab" }, saved))
    .toMatchObject({ url: "http://env:2", urlFrom: "environment", token: "env-token-0123456789ab", tokenFrom: "environment" });
  expect(effectiveBridge({}, {})).toMatchObject({ url: null, token: null, urlFrom: "none", tokenFrom: "none" });
});
