// The use cases, against fake adapters: no database, network or clock.
import { describe, expect, test } from "bun:test";
import type { Block, GradingRecord, Outcome } from "./model.ts";
import type { Grader, LearningRecord } from "./ports.ts";
import { createSchool, resumeFrom, type CourseOutline, type LessonOutline } from "./school.ts";

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

// Where the learner left off, and what to study next (flyingrobots/school#39): a pure rule over the
// record's latest activity and the courses as served.
describe("resumeFrom", () => {
  const q = (id: string) => ({ id, q: `Question ${id}?` });
  const l = (id: string, quizzes: string[]): LessonOutline => ({ id, title: `Lesson ${id}`, subtitle: `About ${id}`, quizzes: quizzes.map(q) });
  const aion = (progress: CourseOutline["progress"] = {}): CourseOutline =>
    ({ name: "aion", lessons: [l("l1", ["q1", "q2"]), l("l2", []), l("l3", ["q3"])], progress });
  const empty: CourseOutline = { name: "empty", lessons: [], progress: {} };
  const AT = "2026-11-21T10:00:00.000Z";
  const last = (course: string, lesson: string) => ({ course, lesson, at: AT });

  test("nothing studied starts the first lesson of the first course that has one", () => {
    expect(resumeFrom(null, [empty, aion()])).toEqual({
      kind: "start", course: "aion", lastStudied: null, question: null,
      lesson: { id: "l1", title: "Lesson l1", subtitle: "About l1", position: 1, of: 3, quizzes: 2, answeredCorrectly: 0 },
    });
  });

  test("a lesson with a quiz still to answer correctly is continued, with that quiz's question, in document order", () => {
    expect(resumeFrom(last("aion", "l1"), [aion({ l1: ["q1"] })])).toMatchObject({
      kind: "continue", course: "aion", lastStudied: AT, question: "Question q2?",
      lesson: { id: "l1", position: 1, of: 3, quizzes: 2, answeredCorrectly: 1 },
    });
    expect(resumeFrom(last("aion", "l1"), [aion({ l1: ["q2"] })])).toMatchObject({ kind: "continue", question: "Question q1?" });
  });

  test("a finished lesson leads to the next one not finished, and a reading lesson counts as not finished", () => {
    expect(resumeFrom(last("aion", "l1"), [aion({ l1: ["q1", "q2"] })]))
      .toMatchObject({ kind: "next", course: "aion", lastStudied: AT, question: null, lesson: { id: "l2", position: 2, quizzes: 0 } });
    // A reading lesson the learner was last in is read: the next one follows it.
    expect(resumeFrom(last("aion", "l2"), [aion({ l1: ["q1", "q2"] })])).toMatchObject({ kind: "next", lesson: { id: "l3" } });
  });

  test("at the end of a course it wraps to the first lesson still to finish, and says when none is left", () => {
    expect(resumeFrom(last("aion", "l3"), [aion({ l3: ["q3"] })])).toMatchObject({ kind: "next", lesson: { id: "l1", answeredCorrectly: 0 } });
    expect(resumeFrom(last("aion", "l3"), [aion({ l1: ["q1", "q2"], l3: ["q3"] })]))
      .toEqual({ kind: "finished", course: "aion", lastStudied: AT });
  });

  test("a lesson or course no longer served falls back to its course's start, or the first course", () => {
    expect(resumeFrom(last("aion", "gone"), [aion({ l1: ["q1"] })])).toMatchObject({ kind: "next", lastStudied: AT, lesson: { id: "l1" } });
    expect(resumeFrom(last("gone", "l1"), [empty, aion()])).toMatchObject({ kind: "start", course: "aion", lastStudied: AT, lesson: { id: "l1" } });
  });

  test("with no lessons anywhere there is nothing to study", () => {
    expect(resumeFrom(null, [empty])).toEqual({ kind: "nothing" });
    expect(resumeFrom(last("aion", "l1"), [])).toEqual({ kind: "nothing" });
  });

  test("the use case reads where the learner left off from the record", async () => {
    const record = { lastStudied: async () => last("aion", "l1") } as Partial<LearningRecord> as LearningRecord;
    const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
    expect(await school.lastStudied()).toEqual(last("aion", "l1"));
  });
});
