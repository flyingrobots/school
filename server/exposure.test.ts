// POST /api/exposure and the lesson API's `aid` capture version, over HTTP against the real server
// process (flyingrobots/school#29). The server runs on Postgres (PGlite here, flyingrobots/school#47),
// which records exposures, so a valid exposure in a tracked encounter is stored. Aid derived from
// exposures is proved through the port (server/contract/learning-record.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchool, timeout, type Started } from "./testing/processes.ts";
import { ownerQuery } from "./testing/record.ts";

let root = "";
let env: Record<string, string | undefined> = {};
let base = "";
let server: Started | null = null;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "school-exposure-"));
  const courseDir = join(root, "demo");
  mkdirSync(join(courseDir, "lessons"), { recursive: true });
  writeFileSync(join(courseDir, "lessons", "0001.json"), JSON.stringify({ type: "page", id: "l1", title: "One", subtitle: "", children: [
    { type: "explain", id: "e1", prompt: "Say why.", model: "Because.", sources: [] },
  ] }));
  env = { ...process.env, SCHOOL_COURSE: courseDir, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, HOST: "127.0.0.1" };
  server = await startSchool(env);
  base = server.url;
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

// While the server ran on SQLite this asserted 501 "unsupported". On Postgres, recording an
// exposure in a tracked encounter is supported: it is stored once, and the record holds it.
test("on Postgres a valid exposure in a tracked encounter is stored once; a resend is a duplicate, a reused id a conflict", async () => {
  const { encounterId } = await (await lesson("?aid=1")).json();
  const exposure = { exposureId: crypto.randomUUID(), encounterId, blockId: "e1", kind: "model-answer" };
  const first = await expose(exposure);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ status: "stored" });
  const again = await expose(exposure);
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ status: "duplicate" });
  const reused = await expose({ ...exposure, kind: "hint" });
  expect(reused.status).toBe(409);
  expect(await reused.json()).toEqual({ status: "conflict" });
  // The record, read as its owner once the server has exited: exactly the first exposure.
  server!.proc.kill("SIGKILL");
  await server!.proc.exited;
  const rows = await ownerQuery<{ exposure_id: string; encounter_id: string; block_id: string; kind: string }>(join(root, "record"),
    "SELECT exposure_id, encounter_id, block_id, kind FROM school.exposures ORDER BY seq");
  expect(rows).toEqual([{ exposure_id: exposure.exposureId, encounter_id: encounterId, block_id: "e1", kind: "model-answer" }]);
  server = await startSchool(env);
  base = server.url;
}, timeout(2));

test("on Postgres an exposure is rejected, and nothing stored, in an untracked encounter or for a block the lesson lacks", async () => {
  const untracked = (await (await lesson()).json()).encounterId;
  const r = await expose({ exposureId: crypto.randomUUID(), encounterId: untracked, blockId: "e1", kind: "model-answer" });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ status: "rejected" });
  const tracked = (await (await lesson("?aid=1")).json()).encounterId;
  const missing = await expose({ exposureId: crypto.randomUUID(), encounterId: tracked, blockId: "nope", kind: "hint" });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ status: "rejected" });
  server!.proc.kill("SIGKILL");
  await server!.proc.exited;
  expect(await ownerQuery(join(root, "record"), "SELECT * FROM school.exposures")).toEqual([]);
  server = await startSchool(env);
  base = server.url;
}, timeout(2));
