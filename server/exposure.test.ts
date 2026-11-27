// POST /api/exposure and the lesson API's `aid` capture version, over HTTP against the real server
// process (flyingrobots/school#29). The server runs on Postgres (PGlite here, flyingrobots/school#47),
// which records exposures, so a valid exposure in a tracked encounter is stored. Aid derived from
// exposures is proved through the port (server/contract/learning-record.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchool, timeout, type Started } from "./testing/processes.ts";
import { openLesson } from "./testing/lessons.ts";
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

const lesson = (query = "") => openLesson(base, "demo", "l1", query);
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

// Recording an exposure in a tracked encounter: it is stored once, and the record holds it.
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

// GET /api/aid/:submissionId reads a submission's derived aid through the core use case
// (`submissionAid`, RFC 2 §3). RFC 2 Figure 4 over HTTP: submit, reveal, revise.
const explain = (encounterId: string, text: string) => {
  const submissionId = crypto.randomUUID();
  return fetch(`${base}/api/explanation`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submissionId, encounterId, blockId: "e1", text, ms: 1000 }) }).then((r) => {
    expect(r.status).toBe(200);
    return submissionId;
  });
};
const aid = (id: string) => fetch(`${base}/api/aid/${id}`);

test("GET /api/aid: Figure 4 over HTTP: the first explanation has no recorded aid, the revision after the model answer is aided", async () => {
  const { encounterId } = await (await lesson("?aid=1")).json();
  const a = await explain(encounterId, "Because it is.");
  expect((await expose({ exposureId: crypto.randomUUID(), encounterId, blockId: "e1", kind: "model-answer" })).status).toBe(200);
  const b = await explain(encounterId, "Because, as the model says.");
  const ra = await aid(a);
  expect(ra.status).toBe(200);
  expect(await ra.json()).toEqual({ submissionId: a, aid: "no-recorded-aid" });
  expect(await (await aid(b)).json()).toEqual({ submissionId: b, aid: "aided" });
  // Upper-case ids name the same submission, as everywhere else in the API.
  expect(await (await aid(b.toUpperCase())).json()).toEqual({ submissionId: b, aid: "aided" });
});

test("GET /api/aid: unknown in an untracked encounter; 404 for no such submission; 400 for an id that is not a UUID", async () => {
  const { encounterId } = await (await lesson()).json();
  const x = await explain(encounterId, "Because it is.");
  expect(await (await aid(x)).json()).toEqual({ submissionId: x, aid: "unknown" });
  const none = await aid(crypto.randomUUID());
  expect(none.status).toBe(404);
  expect(await none.json()).toEqual({ status: "unknown submission" });
  for (const bad of ["not-a-uuid", "1", `${crypto.randomUUID()}x`]) {
    const r = await aid(bad);
    expect(`${bad}: ${r.status}`).toBe(`${bad}: 400`);
    expect(await r.json()).toEqual({ status: "invalid" });
  }
});
