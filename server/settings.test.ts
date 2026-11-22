// The settings page (flyingrobots/school#13): connect the bridge and order, toggle and test its
// agents from School (their commands are set only on the bridge's host, flyingrobots/school#18),
// through the real server and a real bridge. The only fake is the agent CLI.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveBridge } from "./settings.ts";

// Every test gets its own server, bridge, state and ports, and sets up what it needs: none
// depends on another having run first.
let root = "";
let PORT = 0;
let BRIDGE_PORT = 0;
let base = "";
let BRIDGE_URL = "";
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "school-settings-"));
  PORT = 20000 + Math.floor(Math.random() * 20000);
  BRIDGE_PORT = PORT + 1;
  base = `http://127.0.0.1:${PORT}`;
  BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
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
  await until(base + "/api/courses", (r) => r.ok);
});
afterEach(async () => {
  for (const p of procs.splice(0)) { p.kill(); await p.exited; }
  serverOut = null;
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const status = async () => (await fetch(base + "/api/settings/status")).json();
const text = (r: Response) => r.text();
/** Connect the bridge from the settings page, as the learner does. */
const connect = async () => expect((await post("/api/settings/bridge", { url: BRIDGE_URL, token: TOKEN })).status).toBe(200);
// The bridge's file on the host, as the learner writes it there: the only place an agent's command
// is set (flyingrobots/school#18). School's page may reorder, toggle and test what it declares.
const CHAIN = () => ({ timeout_seconds: 10, agents: [
  { name: "missing", command: "no-such-agent-cli {prompt}", output: "text" },
  { name: "fake", command: `${join(root, "agent")} -p {prompt}`, output: "text" },
] });
const bridgeFile = () => join(root, "bridge", "bridge.json");
const declare = (c: unknown = CHAIN()) => {
  mkdirSync(join(root, "bridge"), { recursive: true });
  writeFileSync(bridgeFile(), JSON.stringify(c, null, 2) + "\n");
};
const pwned = () => join(root, "pwned");


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

test("no request can set an agent's command, and a refused one leaves the bridge's file as written", async () => {
  declare();
  await connect();
  const before = readFileSync(bridgeFile(), "utf8");
  const evil = `touch ${pwned()}`;
  const bodies = [
    // The old shape: a whole configuration, with a command rewritten.
    { timeout_seconds: 10, agents: [{ name: "missing", command: evil, output: "text" }, { name: "fake", command: evil, output: "text" }] },
    { agents: [{ name: "fake", command: evil }, { name: "missing" }] },
    { agents: [{ name: "fake", enabled: true, output: "claude-json" }, { name: "missing" }] },
    { agents: [{ name: "fake" }, { name: "missing" }], timeout_seconds: 900 },
    { agents: [{ name: "fake" }, { name: "missing" }, { name: "evil", command: evil }] },
    { agents: [{ name: "fake" }, { name: "missing" }], command: evil },
  ];
  for (const body of bodies) {
    const r = await post("/api/settings/agents", body);
    expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
    expect((await r.json()).error).toMatch(/bridge's own file|only/);
  }
  expect((await fetch(base + "/api/settings/agents", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(bodies[0]) })).status).toBe(405);
  expect(readFileSync(bridgeFile(), "utf8")).toBe(before);
  // Nothing was run either: testing is of a declared agent, as declared.
  expect((await post("/api/settings/agents/test", { agent: "fake", command: evil })).status).toBe(400);
  expect(existsSync(pwned())).toBe(false);
});

test("a bridge with no file on its host cannot be given agents from the page", async () => {
  await connect();
  const r = await post("/api/settings/agents", { agents: [] });
  expect(r.status).toBe(409);
  expect((await r.json()).error).toContain(bridgeFile());
  expect(existsSync(bridgeFile())).toBe(false);
});

test("a reorder must name every declared agent exactly once", async () => {
  declare();
  await connect();
  const before = readFileSync(bridgeFile(), "utf8");
  for (const agents of [[{ name: "fake" }], [{ name: "fake" }, { name: "missing" }, { name: "other" }], [{ name: "fake" }, { name: "fake" }], [{ name: "fake" }, { name: "missing", enabled: "no" }]]) {
    expect((await post("/api/settings/agents", { agents })).status).toBe(400);
  }
  expect(readFileSync(bridgeFile(), "utf8")).toBe(before);
});

test("testing an agent that is not declared on the host is refused", async () => {
  declare();
  await connect();
  const r = await post("/api/settings/agents/test", { agent: "nobody" });
  expect(r.status).toBe(404);
  expect((await post("/api/settings/agents/test", { agent: 7 })).status).toBe(400);
});

test("the page reorders and toggles the declared agents, commands stay as written, and test and grading work without a restart", async () => {
  declare();
  await connect();
  expect(await (await fetch(base + "/api/settings/agents")).json()).toMatchObject({ raw: CHAIN() });
  expect(await status()).toMatchObject({ connection: "ok", agents: [{ name: "missing", found: false }, { name: "fake", found: true }] });

  const saved = await post("/api/settings/agents", { agents: [{ name: "fake", enabled: true }, { name: "missing", enabled: false }] });
  expect(saved.status).toBe(200);
  const [missing, fake] = CHAIN().agents;
  expect(JSON.parse(readFileSync(bridgeFile(), "utf8"))).toEqual({ timeout_seconds: 10, agents: [{ ...fake, enabled: true }, { ...missing, enabled: false }] });
  expect(await status()).toMatchObject({ connection: "ok", agents: [{ name: "fake", enabled: true, found: true }, { name: "missing", enabled: false, found: false }] });

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
  declare();
  const everything = [await text(await post("/api/settings/bridge", { url: BRIDGE_URL, token: TOKEN }))];
  everything.push(await text(await post("/api/settings/agents", { agents: [{ name: "missing" }, { name: "fake" }] })));
  everything.push(await text(await fetch(base + "/api/settings/bridge")), JSON.stringify(await status()), await text(await fetch(base + "/api/settings/agents")));
  const e = JSON.parse(await text(await fetch(base + "/api/courses/c/lessons/l1"))).encounterId;
  const id = crypto.randomUUID();
  everything.push(await text(await post("/api/explanation", { submissionId: id, encounterId: e, blockId: "e1", text: "Because.", ms: 1 })));
  everything.push(await text(await post("/api/grade", { submissionId: id })));
  expect(everything.some((b) => b.includes('"succeeded"'))).toBe(true); // the token was really used
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
