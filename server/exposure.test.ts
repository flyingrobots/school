// POST /api/exposure and the lesson API's `aid` capture version, over HTTP against the real server
// process (flyingrobots/school#29). The server still runs on SQLite, which records no exposures,
// so a valid exposure is refused as unsupported here; RFC 2 Figure 4 over HTTP needs the server on
// Postgres (flyingrobots/school#47). Until then it is proved through the port and the use cases
// on PGlite (server/contract/learning-record.ts, server/adapters/postgres.test.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

let root = "";
let base = "";
let server: Started | null = null;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "school-exposure-"));
  const courseDir = join(root, "demo");
  mkdirSync(join(courseDir, "lessons"), { recursive: true });
  writeFileSync(join(courseDir, "lessons", "0001.json"), JSON.stringify({ type: "page", id: "l1", title: "One", subtitle: "", children: [
    { type: "explain", id: "e1", prompt: "Say why.", model: "Because.", sources: [] },
  ] }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  server = await startSchool({ ...process.env, SCHOOL_COURSE: courseDir, SCHOOL_STATE: join(root, "state"), PORT: String(port), HOST: "127.0.0.1" });
}, timeout(1));
afterEach(async () => {
  server?.proc.kill("SIGKILL");
  await server?.proc.exited;
  server = null;
  rmSync(root, { recursive: true, force: true });
});

const lesson = (query = "") => fetch(`${base}/api/courses/demo/lessons/l1${query}`);
const expose = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${base}/api/exposure`, { method: "POST", headers, body: JSON.stringify(body) });

test("the lesson API accepts a known aid capture version and refuses any other value", async () => {
  expect((await lesson()).status).toBe(200);
  const tracked = await lesson("?aid=1");
  expect(tracked.status).toBe(200);
  expect((await tracked.json()).encounterId).toBeTruthy();
  for (const bad of ["?aid=2", "?aid=0", "?aid=x", "?aid=", "?aid=1&aid=1"]) {
    const r = await lesson(bad);
    expect(`${bad}: ${r.status}`).toBe(`${bad}: 400`);
    expect(await r.json()).toEqual({ status: "invalid", error: "aid must be a known capture version: 1" });
  }
});

test("POST /api/exposure is behind the API guard and parses its body", async () => {
  const { encounterId } = await (await lesson("?aid=1")).json();
  const valid = { exposureId: crypto.randomUUID(), encounterId, blockId: "e1", kind: "model-answer" };
  expect((await expose(valid, { "content-type": "text/plain" })).status).toBe(415);
  expect((await expose(valid, { "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
  for (const bad of [{ ...valid, kind: "peeking" }, { ...valid, exposureId: "not-a-uuid" }, { ...valid, blockId: "" }, { encounterId }]) {
    const r = await expose(bad);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ status: "invalid" });
  }
});

test("on SQLite a valid exposure is refused as unsupported, never acknowledged as stored", async () => {
  const { encounterId } = await (await lesson("?aid=1")).json();
  const r = await expose({ exposureId: crypto.randomUUID(), encounterId, blockId: "e1", kind: "model-answer" });
  expect(r.status).toBe(501);
  expect(await r.json()).toEqual({ status: "unsupported" });
});
