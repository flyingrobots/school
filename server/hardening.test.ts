// Review findings #3-#8, over HTTP against the real server process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const root = mkdtempSync(join(tmpdir(), "school-harden-"));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
let server: Started | null = null;

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
  mkdirSync(join(root, "ok", "reference", "folder.html"), { recursive: true }); // a directory named like a document
  mkdirSync(join(root, "ok", "reference", "folder"), { recursive: true });
  writeFileSync(join(root, "ok", "lessons", "0001.json"), JSON.stringify({
    type: "page", id: "l1", title: "One", subtitle: "<script>alert(1)</script>",
    children: [quiz, { type: "explain", id: "e1", prompt: "Say <b>why</b>", model: "Because <i>so</i>" }],
  }));
  // linked: a course whose reference DIRECTORY is a symlink to private state (review of #8, P1).
  mkdirSync(join(root, "private"), { recursive: true });
  writeFileSync(join(root, "private", "progress.db"), "PRIVATE DB BYTES");
  writeFileSync(join(root, "private", "diary-entry.html"), "PRIVATE NOTES");
  mkdirSync(join(root, "linked", "lessons"), { recursive: true });
  writeFileSync(join(root, "linked", "lessons", "0001.json"), JSON.stringify({ type: "page", id: "k1", title: "K", subtitle: "", children: [] }));
  symlinkSync(join(root, "private"), join(root, "linked", "reference"));
  // empty: a course with no lessons directory at all.
  mkdirSync(join(root, "empty"), { recursive: true });
  // broken: never valid, with an error message carrying markup.
  mkdirSync(join(root, "broken", "lessons"), { recursive: true });
  writeFileSync(join(root, "broken", "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "b1", title: "B", subtitle: "", children: [{ ref: "<x>&\"" }] }));

  server = await startSchool({ ...process.env, SCHOOL_COURSES: `ok=${join(root, "ok")},empty=${join(root, "empty")},broken=${join(root, "broken")},linked=${join(root, "linked")}`,
      // No built app, as on CI: the API and path checks must not depend on web/dist existing.
      SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_WEB: join(root, "no-web"), PORT: String(PORT), HOST: "127.0.0.1" });
}, timeout(1));
afterAll(async () => {
  server?.proc.kill();
  await server?.proc.exited;
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

test("without a built app, pages say so with a 503 and the API still answers", async () => {
  const r = await fetch(base + "/");
  expect(r.status).toBe(503);
  expect((await r.json()).error).toContain("not built");
  expect((await fetch(base + "/some/page")).status).toBe(503);
  expect((await fetch(base + "/api/courses")).status).toBe(200);
});

test("a course with no lessons directory lists no lessons instead of failing", async () => {
  const res = await fetch(base + "/api/courses/empty");
  expect(res.status).toBe(200);
  expect((await res.json()).lessons).toEqual([]);
});

test("a symlink out of a served directory is not followed, and a directory is not a file", async () => {
  expect((await fetch(base + "/courses/ok/reference/fine.html")).status).toBe(200);
  const leak = await fetch(base + "/courses/ok/reference/leak.html");
  expect(leak.status).toBe(404);
  expect(await leak.text()).not.toContain("TOP SECRET");
  expect((await fetch(base + "/courses/ok/reference/folder")).status).toBe(404);
});


test("a lesson error reports the whole message as data", async () => {
  const res = await fetch(base + "/api/courses/broken/lessons/b1");
  expect(res.status).toBe(500);
  expect((await res.json()).error).toContain('unknown ref "<x>&\""');
});


// Oracle: a reference document is listed only if it can be served (flyingrobots/school#8 review, P1).
test("a reference symlink that leaves the course is not listed", async () => {
  const course = await (await fetch(base + "/api/courses/ok")).json();
  expect(course.reference).toEqual(["fine.html"]);
});

test.each(["progress.db", "diary-entry.html"])("a reference folder that links out of the course does not serve %s", async (file) => {
  const res = await fetch(`${base}/courses/linked/reference/${file}`);
  expect([res.status, (await res.text()).includes("PRIVATE")]).toEqual([404, false]);
});

test("a reference folder that links out of the course lists nothing", async () => {
  const course = await (await fetch(base + "/api/courses/linked")).json();
  expect(course.reference).toEqual([]);
});
