// The use cases, against fake adapters: no database, network or clock.
import { expect, test } from "bun:test";
import type { Block, GradingRecord, Outcome } from "./model.ts";
import type { Grader, LearningRecord } from "./ports.ts";
import { createSchool } from "./school.ts";

const explain: Extract<Block, { type: "explain" }> = {
  type: "explain", id: "e1", prompt: "Say why.", model: "Because it is so.",
  sources: [{ id: "src", title: "Source", text: "It is so because of reasons." }],
};
const NOW = "2026-11-21T10:00:00.000Z";

function fakeRecord(saved: boolean) {
  const stored: { g: GradingRecord; now: string }[] = [];
  const record: Partial<LearningRecord> = {
    explanation: async (id) => saved ? { block: explain, state: { submissionId: id, blockId: "e1", text: "It is so.", at: NOW, grading: null } } : null,
    recordGrading: async (g, now) => {
      stored.push({ g, now });
      return g.status === "succeeded" ? { id: 1, status: "succeeded", findings: g.findings, model: g.model, supersedes: null, at: now }
        : { id: 1, status: "failed", error: g.error, model: g.model, supersedes: null, at: now };
    },
  };
  return { record: record as LearningRecord, stored };
}
const grader = (outcome: Outcome, calls: unknown[] = []): Grader => ({
  adapter: "fake", model: "", rubricVersion: "rubric-v1", promptVersion: "prompt-v1",
  grade: async (input) => (calls.push(input), outcome),
});
const clock = { now: () => NOW };

test("grading an unknown explanation stores nothing and never calls the grader", async () => {
  const calls: unknown[] = [];
  const { record, stored } = fakeRecord(false);
  const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }, calls), clock });
  expect(await school.gradeExplanation("00000000-0000-0000-0000-000000000000")).toBeNull();
  expect(calls).toEqual([]);
  expect(stored).toEqual([]);
});

test("the grader is sent the block from the snapshot, and quotes are checked against its sources", async () => {
  const calls: unknown[] = [];
  const { record, stored } = fakeRecord(true);
  const findings = {
    insufficient_evidence: false, summary: "s",
    fidelity: { verdict: "meets", note: "" }, completeness: { verdict: "meets", note: "" }, accessibility: { verdict: "meets", note: "" },
    contradictions: [{ source_id: "src", quote: "because of  REASONS", note: "" }, { source_id: "src", quote: "invented", note: "" }],
  } as const;
  const school = createSchool({ record, grader: grader({ status: "succeeded", findings: structuredClone(findings) as never, raw: "{}", model: "agent-a" }, calls), clock });
  const r = await school.gradeExplanation("id");
  expect(calls).toEqual([{ prompt: "Say why.", modelAnswer: "Because it is so.", sources: explain.sources, explanation: "It is so." }]);
  expect(stored[0]!.g).toMatchObject({ status: "succeeded", adapter: "fake", model: "agent-a", sources: explain.sources, raw: "{}", error: null });
  expect(stored[0]!.g.findings?.contradictions.map((c) => c.quote_verified)).toEqual([true, false]);
  expect(r?.grading.status).toBe("succeeded");
});

test("a grading failure is stored as failed, with no findings, never as a verdict", async () => {
  const { record, stored } = fakeRecord(true);
  const school = createSchool({ record, grader: grader({ status: "failed", error: "the bridge did not answer in time" }), clock });
  await school.gradeExplanation("id");
  expect(stored[0]!.g).toMatchObject({ status: "failed", findings: null, error: "the bridge did not answer in time", model: null, raw: null });
});

test("opening a lesson passes the client's aid capture version, or null, to the record", async () => {
  const opened: unknown[] = [];
  const record = {
    openEncounter: async (o: unknown) => (opened.push(o), { id: "e", hash: "h", resumed: false }),
    encounterAnswers: async () => [],
    encounterExplanations: async () => [],
  } as unknown as LearningRecord;
  const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
  const page: Block = { type: "page", id: "l1", title: "l1", subtitle: "", children: [] };
  await school.openLesson("c", page, 1);
  await school.openLesson("c", page, null);
  expect(opened).toEqual([
    { course: "c", lesson: "l1", page, now: NOW, aidTracking: 1 },
    { course: "c", lesson: "l1", page, now: NOW, aidTracking: null },
  ]);
});

test("an exposure is recorded at the clock's time, and aid is the record's to derive", async () => {
  const calls: unknown[] = [];
  const record = {
    recordExposure: async (e: unknown, now: string) => (calls.push([e, now]), { status: "stored" }),
    aid: async (id: string) => (calls.push(id), "aided"),
  } as unknown as LearningRecord;
  const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
  const x = { exposureId: "x", encounterId: "e", blockId: "e1", kind: "model-answer" } as const;
  expect(await school.recordExposure(x)).toEqual({ status: "stored" });
  expect(await school.submissionAid("s")).toBe("aided");
  expect(calls).toEqual([[x, NOW], "s"]);
});
