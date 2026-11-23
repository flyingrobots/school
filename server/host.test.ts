// DNS rebinding (flyingrobots/school#18). A page on another site can rebind its own name to
// 127.0.0.1 and become same-origin with School; the JSON-body guard cannot tell. What it cannot
// change is the Host header, which still names the attacker's site. So every request whose Host
// is not one of School's own names is refused before routing, and changes nothing.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedHosts, hostAllowed } from "./hosts.ts";
import { startSchool, type Started } from "./testing/processes.ts";

const root = mkdtempSync(join(tmpdir(), "school-host-"));
const TAILNET = "school.tail1234.ts.net";

// Started at load rather than in beforeAll, because the Host headers below name the port School
// actually got (flyingrobots/school#82). A failed start fails this file with the helper's reason.
mkdirSync(join(root, "course", "lessons"), { recursive: true });
mkdirSync(join(root, "course", "reference"), { recursive: true });
mkdirSync(join(root, "papers"), { recursive: true });
writeFileSync(join(root, "papers", "p.html"), "<p>paper</p>");
writeFileSync(join(root, "course", "reference", "r.html"), "<p>ref</p>");
writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify({
  type: "page", id: "l1", title: "One", subtitle: "",
  children: [{ type: "quiz", id: "q1", q: "Which?", why: "So.", choices: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }] }],
}));
const env = { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_MOUNTS: `papers=${join(root, "papers")}`,
  SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1", SCHOOL_ALLOWED_HOSTS: TAILNET };
delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_URL;
delete (env as Record<string, string | undefined>).SCHOOL_BRIDGE_TOKEN;
const server: Started = await startSchool(env).catch((e) => { rmSync(root, { recursive: true, force: true }); throw e; });
const PORT = server.port;
const base = server.url;

afterAll(async () => {
  server.proc.kill();
  await server.proc.exited;
  rmSync(root, { recursive: true, force: true });
});

const JSONH = { "content-type": "application/json" };
const as = (host: string, path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), host } });

// Every route the server has, and a few it does not, with the method each answers.
const ROUTES: [string, string, unknown?][] = [
  ["GET", "/"], ["GET", "/some/page"], ["GET", "/api/courses"], ["GET", "/api/courses/c"], ["GET", "/api/courses/c/lessons/l1"],
  ["GET", "/api/settings/status"], ["GET", "/api/settings/bridge"], ["GET", "/api/settings/agents"], ["GET", "/api/nothing"],
  ["GET", "/courses/c/reference/r.html"], ["GET", "/papers/p.html"],
  ["POST", "/api/answer", {}], ["POST", "/api/explanation", {}], ["POST", "/api/grade", {}], ["POST", "/api/view", { course: "c", lesson: "l1" }],
  ["POST", "/api/settings/bridge", { url: "http://127.0.0.1:9", token: "attacker-token-0123456789" }],
  ["POST", "/api/settings/agents", { agents: [{ name: "x", command: "touch /tmp/pwned" }] }], ["POST", "/api/settings/agents/test", { agent: "x" }],
  ["PUT", "/api/settings/agents", {}], ["DELETE", "/api/courses"],
];

const REBOUND = [
  `evil.example:${PORT}`, "evil.example", `127.0.0.1.evil.example:${PORT}`, `localhost.evil.example:${PORT}`,
  `${TAILNET}.evil.example`, `evil.${TAILNET}`, "other.tail1234.ts.net", `127.0.0.2:${PORT}`, `0.0.0.0:${PORT}`,
  `user@127.0.0.1:${PORT}`, "",
];

test.each(REBOUND)("a request with Host %p is refused on every route", async (host) => {
  for (const [method, path, body] of ROUTES) {
    const r = await as(host, path, { method, headers: JSONH, body: body === undefined ? undefined : JSON.stringify(body) });
    expect([method, path, r.status]).toEqual([method, path, 403]);
  }
});

test("a refused request changes nothing", async () => {
  const opened = await (await fetch(base + "/api/courses/c/lessons/l1")).json();
  const answer = { submissionId: crypto.randomUUID(), encounterId: opened.encounterId, blockId: "q1", choiceId: "a", ms: 1 };
  expect((await as("evil.example", "/api/answer", { method: "POST", headers: JSONH, body: JSON.stringify(answer) })).status).toBe(403);
  expect((await as("evil.example", "/api/settings/bridge", { method: "POST", headers: JSONH,
    body: JSON.stringify({ url: "http://127.0.0.1:9", token: "attacker-token-0123456789" }) })).status).toBe(403);
  expect(existsSync(join(root, "state", "settings.json"))).toBe(false);
  const again = await (await fetch(base + "/api/courses/c/lessons/l1")).json();
  expect(again.encounterId).toBe(opened.encounterId);
  expect(again.answers).toEqual(opened.answers);
  expect(await (await fetch(base + "/api/settings/bridge")).json()).toMatchObject({ url: null, tokenSet: false });
});

test("a request with no Host header at all is refused", async () => {
  const reply = await new Promise<string>((resolve, reject) => {
    let got = "";
    Bun.connect({ hostname: "127.0.0.1", port: PORT, socket: {
      open: (s) => { s.write("GET /api/courses HTTP/1.0\r\n\r\n"); },
      data: (_s, d) => { got += d.toString(); },
      close: () => resolve(got),
      error: (_s, e) => reject(e),
    } }).catch(reject);
  });
  expect(reply).toMatch(/^HTTP\/1\.[01] (400|403)/);
  expect(reply).not.toContain('"lessons"');
});

test.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`, "localhost", TAILNET, `${TAILNET}:443`, "School.Tail1234.TS.net", `${TAILNET}.`])(
  "an allowlisted Host %p still works", async (host) => {
    expect((await as(host, "/api/courses")).status).toBe(200);
    expect((await as(host, "/api/settings/status")).status).toBe(200);
    expect((await as(host, "/api/view", { method: "POST", headers: JSONH, body: JSON.stringify({ course: "c", lesson: "l1" }) })).status).toBe(204);
  });

test("the allowlist is the configured host, the localhost names and SCHOOL_ALLOWED_HOSTS", () => {
  expect(allowedHosts({ host: "127.0.0.1" }, {}).sort()).toEqual(["127.0.0.1", "::1", "localhost"]);
  expect(allowedHosts({ host: "school.lan" }, { SCHOOL_ALLOWED_HOSTS: " a.ts.net , B.ts.net " }).sort())
    .toEqual(["127.0.0.1", "::1", "a.ts.net", "b.ts.net", "localhost", "school.lan"]);
  // A wildcard bind address is not a name anyone browses to.
  expect(allowedHosts({ host: "0.0.0.0" }, {})).not.toContain("0.0.0.0");
  expect(allowedHosts({ host: "::" }, {})).not.toContain("::");
});

test("SCHOOL_ALLOWED_HOSTS takes bare names only", () => {
  for (const bad of ["*", "*.ts.net", "a.ts.net:443", "https://a.ts.net", "a b", "a.ts.net/x"]) {
    expect(() => allowedHosts({ host: "127.0.0.1" }, { SCHOOL_ALLOWED_HOSTS: bad })).toThrow(/SCHOOL_ALLOWED_HOSTS/);
  }
});

test("a Host header is matched by name, ignoring port, case and a trailing dot, and nothing looser", () => {
  const allowed = ["127.0.0.1", "localhost", "::1", "a.ts.net"];
  for (const h of ["127.0.0.1:4747", "localhost", "LocalHost:80", "[::1]:4747", "[::1]", "a.ts.net", "a.ts.net.:443"]) expect([h, hostAllowed(h, allowed)]).toEqual([h, true]);
  for (const h of [null, "", "::1", "[::1", "a.ts.net.evil", "x.a.ts.net", "a.ts.net:", "a.ts.net:x", "a.ts.net:1:2", "u@localhost", "localhost/", "127.0.0.1 "])
    expect([h, hostAllowed(h, allowed)]).toEqual([h, false]);
});
