// Review findings #3-#8, over HTTP against the real server process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "school-harden-"));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof Bun.spawn> | null = null;

const quiz = { type: "quiz", id: "q1", q: "<img src=x onerror=alert(1)> Which?", why: "Because & so.",
  choices: [{ id: "wrong", text: "Wrong", correct: false }, { id: "right", text: "Right", correct: true }] };

beforeAll(async () => {
  // ok: a normal course, with a reference symlink that escapes it.
  mkdirSync(join(root, "ok", "lessons"), { recursive: true });
  mkdirSync(join(root, "ok", "reference"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(root, "outside", "secret.html"), "TOP SECRET");
  symlinkSync(join(root, "outside", "secret.html"), join(root, "ok", "reference", "leak.html"));
  writeFileSync(join(root, "ok", "reference", "fine.html"), "<p>fine</p>");
  writeFileSync(join(root, "ok", "lessons", "0001.json"), JSON.stringify({
    type: "page", id: "l1", title: "One", subtitle: "<script>alert(1)</script>",
    children: [quiz, { type: "explain", id: "e1", prompt: "Say <b>why</b>", model: "Because <i>so</i>" }],
  }));
  // empty: a course with no lessons directory at all.
  mkdirSync(join(root, "empty"), { recursive: true });
  // broken: never valid, with an error message carrying markup.
  mkdirSync(join(root, "broken", "lessons"), { recursive: true });
  writeFileSync(join(root, "broken", "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "b1", title: "B", subtitle: "", children: [{ ref: "<x>&\"" }] }));

  server = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, SCHOOL_COURSES: `ok=${join(root, "ok")},empty=${join(root, "empty")},broken=${join(root, "broken")}`,
      SCHOOL_STATE: join(root, "state"), PORT: String(PORT), HOST: "127.0.0.1" },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/")).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
});
afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
const JSONH = { "content-type": "application/json" };

test("every POST /api/* refuses a body that is not declared JSON (a CORS simple request)", async () => {
  for (const path of ["/api/view", "/api/answer", "/api/anything-added-later"]) {
    expect((await post(path, { course: "ok", lesson: "l1" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(path, { course: "ok", lesson: "l1" }, {})).status).toBe(415);
  }
});

test("every POST /api/* refuses a cross-site request even when it is JSON", async () => {
  for (const path of ["/api/view", "/api/answer"]) {
    expect((await post(path, { course: "ok", lesson: "l1" }, { ...JSONH, "sec-fetch-site": "cross-site" })).status).toBe(403);
  }
});

test("a same-origin JSON view is still recorded", async () => {
  expect((await post("/api/view", { course: "ok", lesson: "l1" }, { ...JSONH, "sec-fetch-site": "same-origin" })).status).toBe(204);
  expect((await post("/api/view", { course: "ok", lesson: "l1" }, { "content-type": "application/json; charset=utf-8" })).status).toBe(204);
});

test("malformed percent-encoding is a 400, not a crash", async () => {
  expect((await fetch(base + "/assets/%E0%A4%A")).status).toBe(400);
  expect((await fetch(base + "/courses/ok/reference/%E0%A4%A")).status).toBe(400);
});

test("a course with no lessons directory lists no lessons instead of failing", async () => {
  const res = await fetch(base + "/courses/empty");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("No lessons yet");
});

test("a symlink out of a served directory is not followed, and a directory is not a file", async () => {
  expect((await fetch(base + "/courses/ok/reference/fine.html")).status).toBe(200);
  const leak = await fetch(base + "/courses/ok/reference/leak.html");
  expect(leak.status).toBe(404);
  expect(await leak.text()).not.toContain("TOP SECRET");
  expect((await fetch(base + "/assets/")).status).toBe(404);
});

test("plain-text lesson fields are escaped; only html blocks carry markup", async () => {
  const html = await (await fetch(base + "/courses/ok/lessons/l1")).text();
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("Say &lt;b&gt;why&lt;/b&gt;");
  expect(html).toContain("Because &lt;i&gt;so&lt;/i&gt;");
});

test("a lesson error escapes the whole message", async () => {
  const res = await fetch(base + "/courses/broken/lessons/b1");
  expect(res.status).toBe(500);
  const body = await res.text();
  expect(body).toContain("&lt;x&gt;&amp;&quot;");
  expect(body).not.toContain("<x>");
});

test("the slides view links no assets that do not exist", async () => {
  const html = await (await fetch(base + "/courses/ok/lessons/l1?view=slides")).text();
  for (const m of html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)) {
    expect([m[1], (await fetch(base + m[1])).status]).toEqual([m[1], 200]);
  }
});

test("feedback is announced, and a settled quiz's choices are disabled", async () => {
  const page = await (await fetch(base + "/courses/ok/lessons/l1")).text();
  expect(page).toMatch(/class="fb" aria-live="polite"/);
  const e = /data-encounter="([^"]+)"/.exec(page)![1];
  await post("/api/answer", { submissionId: crypto.randomUUID(), encounterId: e, blockId: "q1", choiceId: "right", ms: 1 }, JSONH);
  const after = await (await fetch(base + "/courses/ok/lessons/l1")).text();
  expect(after).toMatch(/<button data-choice="wrong"[^>]* disabled>/);
});
