// The settings page (flyingrobots/school#13): connect the bridge and order, toggle and test its
// agents from School (their commands are set only on the bridge's host, flyingrobots/school#18),
// through the real server and a real bridge. The only fake is the agent CLI.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveBridge } from "./settings.ts";
import { startBridge, startSchool, timeout, type Started } from "./testing/processes.ts";

// Every test gets its own server, bridge, state and ports, and sets up what it needs: none
// depends on another having run first.
let root = "";
let base = "";
let BRIDGE_URL = "";
const TOKEN = "settings-token-NEVER-ECHO-ME";
const procs: Started[] = [];
let serverOut: Started | null = null;

const verdict = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "n" }, completeness: { verdict: "meets", note: "n" }, accessibility: { verdict: "meets", note: "n" },
  contradictions: [], summary: "Good.",
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "school-settings-"));
  writeFileSync(join(root, "verdict.json"), JSON.stringify(verdict));
  writeFileSync(join(root, "agent"), `#!/bin/sh\ncat "${root}/verdict.json"\n`);
  chmodSync(join(root, "agent"), 0o755);
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify({
    type: "page", id: "l1", title: "One", subtitle: "", children: [{ type: "explain", id: "e1", prompt: "Explain.", model: "M", sources: [] }],
  }));
  // A bridge with no configuration file yet: the settings page is how it gets one.
  const bridge = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(root, "bridge", "bridge.json") });
  procs.push(bridge);
  BRIDGE_URL = bridge.url;
  // A server with no bridge configured at all, as the learner's was.
  const env = { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), HOST: "127.0.0.1" };
  delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_URL;
  delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_TOKEN;
  serverOut = await startSchool(env);
  base = serverOut.url;
  procs.push(serverOut);
}, timeout(2));
afterEach(async () => {
  for (const p of procs.splice(0)) { p.proc.kill(); await p.proc.exited; }
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
  serverOut!.proc.kill();
  const { stdout, stderr } = await serverOut!.output();
  const out = stdout + stderr;
  expect(out).not.toContain(TOKEN);
});

test("environment variables override saved settings, and the page says which", () => {
  const saved = { bridge: { url: "http://saved:1", token: "saved-token-0123456789" } };
  expect(effectiveBridge({}, saved)).toMatchObject({ url: "http://saved:1", urlFrom: "settings", tokenFrom: "settings" });
  expect(effectiveBridge({ SCHOOL_BRIDGE_URL: "http://env:2", SCHOOL_BRIDGE_TOKEN: "env-token-0123456789ab" }, saved))
    .toMatchObject({ url: "http://env:2", urlFrom: "environment", token: "env-token-0123456789ab", tokenFrom: "environment" });
  expect(effectiveBridge({}, {})).toMatchObject({ url: null, token: null, urlFrom: "none", tokenFrom: "none" });
});

// flyingrobots/school#60: anyone who can reach School can post a bridge URL. The token must
// never follow it there. A listener stands in for an attacker's address and records the
// Authorization header of every request it receives, whatever the path.
type Listener = { url: string; seen: (string | null)[]; stop: () => void };
function listener(reply: (req: Request) => Response = () => Response.json({ status: "ok", agents: [], raw: { evil: true } })): Listener {
  const seen: (string | null)[] = [];
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen.push(req.headers.get("authorization")); return reply(req); } });
  return { url: `http://127.0.0.1:${s.port}`, seen, stop: () => s.stop(true) };
}
const listeners: Listener[] = [];
afterEach(() => { for (const l of listeners.splice(0)) l.stop(); });
const listen = (reply?: (req: Request) => Response) => { const l = listener(reply); listeners.push(l); return l; };

/** Every route that can reach the bridge, exercised once, so a leak anywhere shows up in a listener. */
async function touchEverything(at: string) {
  const g = (p: string) => fetch(at + p);
  const p = (path: string, body: unknown) => fetch(at + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const replies = [await g("/api/settings/status"), await g("/api/settings/agents"), await p("/api/settings/agents", { agents: [{ name: "fake" }] }), await p("/api/settings/agents/test", { agent: "fake" })];
  const e = JSON.parse(await (await g("/api/courses/c/lessons/l1")).text()).encounterId;
  const id = crypto.randomUUID();
  await p("/api/explanation", { submissionId: id, encounterId: e, blockId: "e1", text: "Because.", ms: 1 });
  replies.push(await p("/api/grade", { submissionId: id }));
  return Promise.all(replies.map((r) => r.text()));
}

/** A second server, with the bridge settings given in its environment. */
async function serverWith(extra: Record<string, string>) {
  const env = { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state-env"), HOST: "127.0.0.1", ...extra };
  for (const k of ["SCHOOL_BRIDGE_URL", "SCHOOL_BRIDGE_TOKEN"]) if (!(k in extra)) delete (env as Record<string, string | undefined>)[k];
  const s = await startSchool(env);
  procs.push(s);
  return s.url;
}

test("with the token in the environment, the URL cannot be changed from the page", async () => {
  const evil = listen();
  const at = await serverWith({ SCHOOL_BRIDGE_TOKEN: TOKEN });
  const r = await fetch(at + "/api/settings/bridge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: evil.url }) });
  expect(r.status).toBe(409);
  const body = await r.json();
  expect(body.status).toBe("locked");
  expect(body.error).toContain("SCHOOL_BRIDGE_TOKEN");
  expect(await (await fetch(at + "/api/settings/bridge")).json()).toMatchObject({ url: null, tokenFrom: "environment" });
  await touchEverything(at);
  expect(evil.seen).toEqual([]);
}, timeout(1));

test("changing the URL clears the saved token, so no request carries it to the new address", async () => {
  declare();
  await connect();
  const evil = listen();
  const moved = await post("/api/settings/bridge", { url: evil.url });
  expect(moved.status).toBe(200);
  expect(await moved.json()).toMatchObject({ status: "saved", tokenSet: false });
  expect(JSON.parse(readFileSync(join(root, "state", "settings.json"), "utf8")).bridge).toEqual({ url: evil.url });
  expect(await (await fetch(base + "/api/settings/bridge")).json()).toEqual({ url: evil.url, urlFrom: "settings", tokenSet: false, tokenFrom: "none" });
  const replies = await touchEverything(base);
  expect(evil.seen).toEqual([]);
  // Nothing the address would have said reaches the page either.
  for (const r of replies) expect(r).not.toContain("evil");
  // Moving back does not bring the old token back: it has to be entered again.
  expect(await (await post("/api/settings/bridge", { url: BRIDGE_URL })).json()).toMatchObject({ tokenSet: false });
  expect(await status()).toMatchObject({ connection: "none" });
  await connect();
  expect(await status()).toMatchObject({ connection: "ok" });
});

test("a token saved together with a new URL goes to that URL, and only a new token does", async () => {
  await connect();
  const other = listen();
  const fresh = "a-different-token-0123456789";
  expect((await post("/api/settings/bridge", { url: other.url, token: fresh })).status).toBe(200);
  await touchEverything(base);
  expect(other.seen.length).toBeGreaterThan(0);
  expect(other.seen.every((h) => h === `Bearer ${fresh}`)).toBe(true);
  // The same goes for a generated one.
  const gen = listen();
  const g = await (await post("/api/settings/bridge", { url: gen.url, generate: true })).json();
  await touchEverything(base);
  expect(gen.seen.length).toBeGreaterThan(0);
  expect(gen.seen.every((h) => h === `Bearer ${g.generated}`)).toBe(true);
  // Saving the same URL again, written with a trailing slash, is not a change.
  expect(await (await post("/api/settings/bridge", { url: gen.url + "/" })).json()).toMatchObject({ tokenSet: true });
});

test("a bridge that redirects does not take the token with it", async () => {
  const evil = listen();
  const redirector = listen((req) => new Response(null, { status: 307, headers: { location: evil.url + new URL(req.url).pathname } }));
  expect((await post("/api/settings/bridge", { url: redirector.url, token: TOKEN })).status).toBe(200);
  await touchEverything(base);
  expect(redirector.seen.length).toBeGreaterThan(0);
  expect(evil.seen).toEqual([]);
});

// flyingrobots/school#61: the reply to saving the bridge reports the token in effect, from the
// environment as much as from settings, as GET /api/settings/bridge does, and never the token.
test("with the token in the environment, saving the same URL reports the token as set", async () => {
  const saved = listen();
  mkdirSync(join(root, "state-env"), { recursive: true });
  writeFileSync(join(root, "state-env", "settings.json"), JSON.stringify({ bridge: { url: saved.url } }));
  const at = await serverWith({ SCHOOL_BRIDGE_TOKEN: TOKEN });
  const r = await fetch(at + "/api/settings/bridge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: saved.url }) });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).not.toContain(TOKEN);
  expect(JSON.parse(text)).toEqual({ status: "saved", tokenSet: true });
  expect(await (await fetch(at + "/api/settings/bridge")).json()).toMatchObject({ url: saved.url, tokenSet: true, tokenFrom: "environment" });
}, timeout(1));
