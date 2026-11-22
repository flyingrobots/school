// The explanation lifecycle (RFC 1 proposal 4; flyingrobots/school#10). The explanation is
// saved before grading; every grading attempt is stored, success or failure; nothing is
// ever overwritten.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "./blocks.ts";
import { migrate } from "./migrate.ts";
import { openEncounter } from "./record.ts";
import { encounterExplanations, gradeExplanation, saveExplanation } from "./explain.ts";
import type { Outcome } from "./grade.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function db(): Database {
  const dir = mkdtempSync(join(tmpdir(), "school-explain-"));
  dirs.push(dir);
  const d = new Database(join(dir, "progress.db"), { create: true, strict: true });
  d.exec("PRAGMA foreign_keys = ON;");
  migrate(d);
  return d;
}

const explain: Block = {
  type: "explain", id: "e1", prompt: "Say why.", model: "Because it is so.",
  sources: [{ id: "src", title: "Source", text: "It is so because of reasons." }],
};
const page: Block = { type: "page", id: "l1", title: "L", subtitle: "", children: [explain] };
const now = (n: number) => new Date(Date.parse("2026-11-22T10:00:00Z") + n).toISOString();
const findings = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "ok" }, completeness: { verdict: "meets", note: "ok" },
  accessibility: { verdict: "meets", note: "ok" },
  contradictions: [{ source_id: "src", quote: "because of reasons", note: "n" }, { source_id: "src", quote: "invented", note: "n" }],
  summary: "Good.",
} as const;
const ok = async (): Promise<Outcome> => ({ status: "succeeded", findings: structuredClone(findings) as never, raw: "{}", model: "m" });
const down = async (): Promise<Outcome> => ({ status: "failed", error: "connection refused" });

function setup() {
  const d = db();
  const e = openEncounter(d, { course: "c", lesson: "l1", page, now: now(0) });
  const sub = { submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "e1", text: "Because reasons.", ms: 5 };
  return { d, e, sub };
}
const grader = (fn: () => Promise<Outcome>) => ({ adapter: "test", model: "m", grade: fn });

test("the explanation is stored before grading, and a failure is stored as failed, not as a verdict", async () => {
  const { d, sub } = setup();
  expect(saveExplanation(d, sub, now(1)).status).toBe("stored");
  expect(d.query("SELECT count(*) AS n FROM explanations").get()).toEqual({ n: 1 });

  const g = await gradeExplanation(d, sub.submissionId, grader(down), now(2));
  expect(g).toMatchObject({ status: "failed", error: "connection refused" });
  const rows = d.query<Record<string, unknown>, []>("SELECT * FROM gradings").all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "failed", findings: null, rubric_version: "rubric-v1" });
});

test("a retry adds a new grading that names the one it supersedes, and none is overwritten", async () => {
  const { d, sub } = setup();
  saveExplanation(d, sub, now(1));
  const first = await gradeExplanation(d, sub.submissionId, grader(down), now(2));
  const second = await gradeExplanation(d, sub.submissionId, grader(ok), now(3));
  expect(second).toMatchObject({ status: "succeeded", supersedes: first.id });
  expect(d.query("SELECT status FROM gradings ORDER BY id").all()).toEqual([{ status: "failed" }, { status: "succeeded" }]);
  expect(() => d.exec("UPDATE gradings SET status = 'succeeded'")).toThrow(/append-only/);
  expect(() => d.exec("DELETE FROM explanations")).toThrow(/append-only/);
});

test("the grading records what was sent, and checks each quote against its source", async () => {
  const { d, sub } = setup();
  saveExplanation(d, sub, now(1));
  const g = await gradeExplanation(d, sub.submissionId, grader(ok), now(2));
  expect(g.status).toBe("succeeded");
  if (g.status === "succeeded") expect(g.findings.contradictions.map((c) => c.quote_verified)).toEqual([true, false]);
  const row = d.query<{ sources: string; adapter: string; model: string; raw_response: string }, []>("SELECT sources, adapter, model, raw_response FROM gradings").get()!;
  expect(JSON.parse(row.sources)).toEqual([{ id: "src", title: "Source", text: "It is so because of reasons." }]);
  expect(row).toMatchObject({ adapter: "test", model: "m", raw_response: "{}" });
});

test("a resent explanation stores one row; reusing its id for different text is a conflict", () => {
  const { d, sub } = setup();
  expect(saveExplanation(d, sub, now(1)).status).toBe("stored");
  expect(saveExplanation(d, sub, now(2)).status).toBe("duplicate");
  expect(saveExplanation(d, { ...sub, text: "Something else." }, now(3)).status).toBe("conflict");
  expect(d.query("SELECT count(*) AS n FROM explanations").get()).toEqual({ n: 1 });
});

test("an explanation for a block that is not an explain block in the snapshot is rejected", () => {
  const { d, sub } = setup();
  expect(saveExplanation(d, { ...sub, blockId: "nope" }, now(1)).status).toBe("rejected");
  expect(saveExplanation(d, { ...sub, encounterId: crypto.randomUUID() }, now(1)).status).toBe("rejected");
});

test("grading a submission that does not exist is refused without calling the grader", async () => {
  const { d } = setup();
  let called = false;
  const g = await gradeExplanation(d, crypto.randomUUID(), grader(async () => { called = true; return ok(); }), now(1));
  expect(g).toBeNull();
  expect(called).toBe(false);
});

test("with no grader configured, an attempt is stored as failed with that reason", async () => {
  const { d, sub } = setup();
  saveExplanation(d, sub, now(1));
  expect(await gradeExplanation(d, sub.submissionId, null, now(2))).toMatchObject({ status: "failed", error: expect.stringMatching(/no grader/i) });
});

test("a reload sees the latest explanation in the encounter and its latest grading", async () => {
  const { d, e, sub } = setup();
  saveExplanation(d, sub, now(1));
  await gradeExplanation(d, sub.submissionId, grader(down), now(2));
  await gradeExplanation(d, sub.submissionId, grader(ok), now(3));
  const [x] = encounterExplanations(d, e.id);
  expect(x).toMatchObject({ blockId: "e1", text: "Because reasons.", grading: { status: "succeeded" } });
});
