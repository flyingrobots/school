// Explanation grading end to end: the real server, the real bridge, and a fake agent CLI (flyingrobots/school#10).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, startSchool, timeout, type Started } from "./testing/processes.ts";
import { openLesson } from "./testing/lessons.ts";
import { ownerQuery, recordBytes } from "./testing/record.ts";

// Every test gets its own server, bridge, state and ports, and sets up what it needs: none
// depends on another having run first.
let root = "";
let base = "";
const KEY = "bridge-token-NEVER-STORE-ME";
let server: Started | null = null;
let bridge: Started | null = null;

const verdict = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "Faithful to the source." },
  completeness: { verdict: "partly", note: "Give one <b>example</b>." },
  accessibility: { verdict: "meets", note: "Plain." },
  contradictions: [{ source_id: "readme", quote: "the transformation, not the state", note: "Matches." }],
  summary: "Close. Add an example.",
};
// The one fake in the chain: an agent CLI. It answers unless the file "down" exists.
let agentPath = "";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "school-grading-"));
  agentPath = join(root, "fake-agent");
  writeFileSync(join(root, "verdict.json"), JSON.stringify(verdict));
  writeFileSync(agentPath, `#!/bin/sh\nif [ -e "${root}/down" ]; then echo "model overloaded" >&2; exit 1; fi\ncat "${root}/verdict.json"\n`);
  chmodSync(agentPath, 0o755);
  writeFileSync(join(root, "bridge.json"), JSON.stringify({ timeout_seconds: 10, agents: [{ name: "fake-agent", command: `${agentPath} -p {prompt}` }] }));
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify({
    type: "page", id: "l1", title: "One", subtitle: "", children: [{
      type: "explain", id: "e1", prompt: "Explain the inversion.", model: "MODEL-ANSWER-TEXT",
      sources: [{ id: "readme", title: "README", text: "The unit of storage should be the transformation, not the state." }],
    }],
  }));
  bridge = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: KEY, SCHOOL_BRIDGE_CONFIG: join(root, "bridge.json") });
  server = await startSchool({ ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, HOST: "127.0.0.1",
    SCHOOL_BRIDGE_URL: bridge.url, SCHOOL_BRIDGE_TOKEN: KEY });
  base = server.url;
}, timeout(2));
afterEach(async () => {
  for (const p of [server, bridge]) { p?.proc.kill(); await p?.proc.exited; }
  server = null;
  bridge = null;
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Lesson = { encounterId: string; lesson: { children: { type: string; id: string }[] }; explanations: { text: string; grading: { status: string; findings?: { summary: string } } | null }[] };
const lesson = async (): Promise<Lesson> => (await openLesson(base, "c", "l1")).json();

const ANSWER = "You keep the changes; state is a replay. <script>x</script>";

/** The learner saves an explanation; returns its submission id. */
async function saved(): Promise<string> {
  const submissionId = crypto.randomUUID();
  const r = await post("/api/explanation", { submissionId, encounterId: (await lesson()).encounterId, blockId: "e1", text: ANSWER, ms: 9 });
  expect(r.status).toBe(200);
  return submissionId;
}

test("before submitting, the lesson has the explain block and no explanation yet", async () => {
  const l = await lesson();
  expect(l.lesson.children.map((b) => [b.type, b.id])).toEqual([["explain", "e1"]]);
  expect(l.explanations).toEqual([]);
});

test("submit saves, then grading returns a verdict rendered as escaped text, with the model answer", async () => {
  const e = (await lesson()).encounterId;
  const submissionId = crypto.randomUUID();
  const save = await post("/api/explanation", { submissionId, encounterId: e, blockId: "e1", text: ANSWER, ms: 9 });
  expect(save.status).toBe(200);
  expect((await save.json()).status).toBe("stored");

  const graded = await post("/api/grade", { submissionId });
  expect(graded.status).toBe(200);
  const body = await graded.json();
  expect(body.status).toBe("succeeded");
  expect(body.explanation.text).toBe(ANSWER);
  expect(body.explanation.grading.findings.completeness).toEqual({ verdict: "partly", note: "Give one <b>example</b>." });
  expect(body.explanation.grading.findings.contradictions[0].quote_verified).toBe(true);
});

test("a reload shows the explanation and its grading from the database", async () => {
  expect((await post("/api/grade", { submissionId: await saved() })).status).toBe(200);
  const [x] = (await lesson()).explanations;
  expect(x!.text).toContain("You keep the changes; state is a replay.");
  expect(x!.grading?.findings?.summary).toBe("Close. Add an example.");
});

test("a grader outage keeps the explanation and says so; a retry later succeeds", async () => {
  const submissionId = await saved();
  writeFileSync(join(root, "down"), "");
  const failed = await (await post("/api/grade", { submissionId })).json();
  expect(failed.status).toBe("failed");
  expect(failed.explanation.grading.status).toBe("failed");
  expect(failed.explanation.grading.error).toContain("fake-agent: exit 1");
  expect(failed.explanation.text).toContain("You keep the changes"); // still saved
  unlinkSync(join(root, "down"));
  expect((await (await post("/api/grade", { submissionId })).json()).status).toBe("succeeded");
});

test("grading an unknown submission is a 404, and a malformed one a 400", async () => {
  expect((await post("/api/grade", { submissionId: crypto.randomUUID() })).status).toBe(404);
  expect((await post("/api/grade", { submissionId: "x" })).status).toBe(400);
  expect((await post("/api/explanation", { submissionId: crypto.randomUUID(), encounterId: crypto.randomUUID(), blockId: "e1", text: "", ms: 1 })).status).toBe(400);
});

test("the bridge token appears nowhere: not in the database, a page or the server's output", async () => {
  expect((await post("/api/grade", { submissionId: await saved() })).status).toBe(200);
  expect(JSON.stringify(await lesson())).not.toContain(KEY);
  server!.proc.kill();
  const { stdout, stderr } = await server!.output();
  const out = stdout + stderr;
  expect(out).not.toContain(KEY);
  server = null;
  // The record, once its server has exited: every byte of the PGlite directory (its tables and
  // its write-ahead log, as progress.db and its -wal were), and every text value it holds.
  const record = join(root, "record");
  expect(recordBytes(record)).toContain("You keep the changes"); // the explanation is in these bytes, unencoded
  expect(recordBytes(record)).not.toContain(KEY);
  const tables = ["answers", "encounters", "explanations", "exposures", "gradings", "snapshots", "views"];
  const values = await ownerQuery<{ v: string }>(record, tables.map((t) => `SELECT to_jsonb(r)::text AS v FROM school.${t} r`).join(" UNION ALL "));
  expect(values.some(({ v }) => v.includes("Close. Add an example."))).toBe(true); // the grading is among them
  for (const { v } of values) expect(v).not.toContain(KEY);
}, timeout(1));

