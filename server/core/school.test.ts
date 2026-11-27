// The use cases, against fake adapters: no database, network or clock.
import { describe, expect, test } from "bun:test";
import type { Block, DueItem, GradingRecord, Outcome } from "./model.ts";
import type { Grader, LearningRecord } from "./ports.ts";
import { REVIEW_DELAY_MS, REVIEW_LIMIT, REVIEW_SECTION_ID, createSchool, resumeFrom, reviewReason, type CourseOutline, type LessonOutline } from "./school.ts";

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
    openLessonEncounter: async (o: { page: Block }) => (opened.push(o), { encounter: { id: "e", hash: "h", resumed: false }, page: o.page }),
    encounterAnswers: async () => [],
    encounterExplanations: async () => [],
    encounterDecisionNotes: async () => [],
  } as unknown as LearningRecord;
  const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
  const page: Block = { type: "page", id: "l1", title: "l1", subtitle: "", children: [] };
  await school.openLesson("c", page, 1);
  await school.openLesson("c", page, null);
  expect(opened).toEqual([
    { course: "c", lesson: "l1", lessonPage: page, page, notes: [], now: NOW, aidTracking: 1 },
    { course: "c", lesson: "l1", lessonPage: page, page, notes: [], now: NOW, aidTracking: null },
  ]);
});

describe("due review on opening a lesson (RFC 2 §5; flyingrobots/school#32)", () => {
  const quiz = (id: string): Block => ({ type: "quiz", id, q: `${id}?`, why: ".", choices: [{ id: "a", text: "A", correct: true }] });
  const item = (blockId: string, o: Partial<DueItem> = {}): DueItem => ({
    blockId, rule: "due-review/wrong-first-try", answeredAt: "2026-11-20T12:00:00.000Z", corrected: true, shown: [],
    lastSeen: "2026-11-20T12:01:00.000Z", evidence: [3, 5], ...o,
  });
  function reviewRecord(due: DueItem[]) {
    const calls: { dueReview: unknown[]; opened: { page: Block; notes: unknown[] }[] } = { dueReview: [], opened: [] };
    const record = {
      dueReview: async (q: unknown) => (calls.dueReview.push(q), due),
      openLessonEncounter: async (x: { page: Block; notes: unknown[] }) => (calls.opened.push(x), { encounter: { id: "e", hash: "h", resumed: false }, page: x.page }),
      encounterAnswers: async () => [],
      encounterExplanations: async () => [],
      encounterDecisionNotes: async () => calls.opened.at(-1)!.notes.map((n, i) => ({
        id: `n${i}`, seq: 100 + i, choice: { course: "c", lesson: "l2", blockId: (n as { blockId: string }).blockId }, encounterId: "e",
        rule: (n as { rule: string }).rule, reason: (n as { reason: string }).reason, evidence: (n as { evidence: number[] }).evidence, at: NOW,
      })),
    } as unknown as LearningRecord;
    return { record, calls };
  }
  const lessonPage: Block = { type: "page", id: "l2", title: "Two", subtitle: "", children: [quiz("own"), { type: "section", id: "s", title: "S", children: [quiz("nested")] }] };

  test("the record is asked about the course's other quizzes, and the due ones go at the top in a Review section, a note each", async () => {
    const { record, calls } = reviewRecord([item("q1"), item("q2", { rule: "due-review/unknown-aid", corrected: false })]);
    const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
    const opened = await school.openLesson("c", lessonPage, 1, [quiz("q1"), quiz("q2"), quiz("own"), quiz("nested"), explain, quiz("q3")]);
    expect(calls.dueReview).toEqual([{ course: "c", blocks: ["q1", "q2", "q3"], now: NOW, delayMs: REVIEW_DELAY_MS, limit: REVIEW_LIMIT }]);
    const shown: Block = { ...lessonPage, children: [{ type: "section", id: REVIEW_SECTION_ID, title: "Review", children: [quiz("q1"), quiz("q2")] }, ...(lessonPage as { children: Block[] }).children] };
    expect(calls.opened[0]).toMatchObject({ course: "c", lesson: "l2", lessonPage, page: shown, now: NOW, aidTracking: 1 });
    expect(calls.opened[0]!.notes).toEqual([
      { blockId: "q1", rule: "due-review/wrong-first-try", reason: reviewReason(item("q1")), evidence: [3, 5] },
      { blockId: "q2", rule: "due-review/unknown-aid", reason: reviewReason(item("q2", { rule: "due-review/unknown-aid", corrected: false })), evidence: [3, 5] },
    ]);
    expect(opened.page).toEqual(shown);
    expect(opened.review.map((x) => [x.blockId, x.rule])).toEqual([["q1", "due-review/wrong-first-try"], ["q2", "due-review/unknown-aid"]]);
  });

  test("an item the course no longer has is skipped; nothing due leaves the lesson as written", async () => {
    const { record, calls } = reviewRecord([item("gone")]);
    const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
    const opened = await school.openLesson("c", lessonPage, 1, [quiz("q1")]);
    expect(calls.opened[0]).toMatchObject({ page: lessonPage, notes: [] });
    expect(opened.review).toEqual([]);
  });

  test("a lesson whose course has no other quizzes asks for no review", async () => {
    const { record, calls } = reviewRecord([item("q1")]);
    await createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock }).openLesson("c", lessonPage, 1, [quiz("own"), explain]);
    expect(calls.dueReview).toEqual([]);
    expect(calls.opened[0]).toMatchObject({ page: lessonPage, notes: [] });
  });

  test("each reason says in words why the item came back, with the day of the answer that decided it, encouragingly (flyingrobots/school#161)", () => {
    const back = "It's back so you can answer it from memory.";
    expect(reviewReason(item("q", { shown: ["feedback"] })))
      .toBe(`On 20 November, the explanation helped you find this one. ${back}`);
    expect(reviewReason(item("q", { shown: ["model-answer", "hint"] })))
      .toBe(`On 20 November, the model answer and a hint helped you find this one. ${back}`);
    expect(reviewReason(item("q"))).toBe(`On 20 November, you found this one on a second go. ${back}`);
    expect(reviewReason(item("q", { corrected: false }))).toBe("On 20 November, this one hadn't settled yet. It's back for a fresh look.");
    expect(reviewReason(item("q", { rule: "due-review/aided-first-try", corrected: false, shown: ["hint"] })))
      .toBe(`On 20 November, a hint helped you find this one. ${back}`);
    expect(reviewReason(item("q", { rule: "due-review/unknown-aid", corrected: false })))
      .toBe(`On 20 November, you found this one while School wasn't noting the help it showed. ${back}`);
    // School's voice: never "wrong", "failed" or "mistake" (docs/topics/voice/README.md).
    const all = [
      item("q", { shown: ["feedback"] }), item("q"), item("q", { corrected: false }),
      item("q", { rule: "due-review/aided-first-try", shown: ["hint"] }), item("q", { rule: "due-review/unknown-aid" }),
      item("q", { rule: "due-review/faded", corrected: false }),
    ].map((item) => reviewReason(item));
    for (const reason of all) expect(reason).not.toMatch(/wrong|fail|mistake|incorrect|forgot|attempt/i);
    for (const reason of [reviewReason(item("q")), reviewReason(item("q", { rule: "due-review/unknown-aid" }))]) {
      expect(reason).not.toMatch(/[0-9]+ ?%|score|points?\b/i); // results in words, never scores
    }
  });

  test("a faded quiz's reason recalls the day it was found from memory and asks how it feels now (RFC 5 §4.7; flyingrobots/school#219)", () => {
    // Oracle: RFC 5 §4.7, which gives this sentence for an answer on 21 November.
    const faded = item("q", { rule: "due-review/faded", answeredAt: "2026-11-21T12:00:00.000Z", corrected: false, shown: [] });
    expect(reviewReason(faded, "UTC")).toBe("On 21 November, you found this one from memory. Some time has passed: how does it feel now?");
    expect(reviewReason(faded, "UTC")).not.toMatch(/[0-9]+ ?%|score|points?\b|strength|half/i); // in words, never the measure
  });

  test("help for the whole encounter is named as asking about the lesson (RFC 6 §5.1, Table 5.2; flyingrobots/school#224)", () => {
    // Oracle: RFC 6 Table 5.2, row 6, which gives this sentence.
    const answeredAt = "2026-11-21T12:00:00.000Z";
    expect(reviewReason(item("q", { rule: "due-review/aided-first-try", answeredAt, corrected: false, shown: ["ai-help"] }), "UTC"))
      .toBe("On 21 November, asking about the lesson helped you find this one. It's back so you can answer it from memory.");
    expect(reviewReason(item("q", { shown: ["ai-help", "hint"] })))
      .toBe("On 20 November, asking about the lesson and a hint helped you find this one. It's back so you can answer it from memory.");
  });
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

test("a decision note is recorded at the clock's time; reading notes and evidence is the record's", async () => {
  const calls: unknown[] = [];
  const record = {
    recordDecisionNote: async (n: unknown, now: string) => (calls.push(["record", n, now]), { status: "rejected" }),
    decisionNotes: async (c: unknown) => (calls.push(["choice", c]), []),
    encounterDecisionNotes: async (id: string) => (calls.push(["encounter", id]), []),
    encounterEvidence: async (id: string) => (calls.push(["evidence", id]), []),
  } as unknown as LearningRecord;
  const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
  const choice = { course: "c", lesson: "l1", blockId: "q1" };
  const n = { noteId: "n", choice, encounterId: null, rule: "due-review/wrong-first-try", reason: "Because.", evidence: [1] };
  expect(await school.recordDecisionNote(n)).toEqual({ status: "rejected" });
  expect(await school.decisionNotes(choice)).toEqual([]);
  expect(await school.encounterDecisionNotes("e")).toEqual([]);
  expect(await school.encounterEvidence("e")).toEqual([]);
  expect(calls).toEqual([["record", n, NOW], ["choice", choice], ["encounter", "e"], ["evidence", "e"]]);
});

test("a decision note's shape is checked at the edge: evidence, rule and choice", async () => {
  const { DecisionNoteInput } = await import("./model.ts");
  const ok = { noteId: crypto.randomUUID(), choice: { course: "c", lesson: "l1", blockId: "q1" }, encounterId: null,
    rule: "due-review/wrong-first-try", reason: "  Because.  ", evidence: [3, 1] };
  expect(DecisionNoteInput.parse(ok)).toEqual({ ...ok, reason: "Because." });
  for (const bad of [
    { evidence: [] }, { evidence: [1, 1] }, { evidence: [0] }, { evidence: [1.5] },
    { rule: "due-review" }, { rule: "Due/Review" }, { rule: "due review/x" }, { reason: "   " },
    { choice: { course: "c", lesson: null, blockId: "q1" } }, { choice: { course: "", lesson: null, blockId: null } },
  ]) expect(`${JSON.stringify(bad)}: ${DecisionNoteInput.safeParse({ ...ok, ...bad }).success}`).toBe(`${JSON.stringify(bad)}: false`);
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

// RFC 5 Table 5.1 step 6 (flyingrobots/school#222): each course's lane says how its quizzes are
// holding today, from the rollup with one group for the course, at the clock's now.
describe("activity says how each course is holding today", () => {
  const rolled = (key: string, o: Partial<{ quizzes: number; notStarted: number; settling: number; holding: number; faded: number; strength: number | null }> = {}) =>
    ({ key, quizzes: 0, notStarted: 0, settling: 0, holding: 0, faded: 0, strength: null, ...o });
  const recordWith = (rows: Record<string, ReturnType<typeof rolled>>, asked: unknown[]) => ({
    studyDays: async () => [],
    dueReview: async () => [],
    masteryRollup: async (q: { course: string }) => (asked.push(q), [rows[q.course]!]),
  }) as Partial<LearningRecord> as LearningRecord;

  test("each course's counts are read at the clock's now with due review's delay, one group holding every quiz", async () => {
    const asked: unknown[] = [];
    const record = recordWith({ astro: rolled("astro", { quizzes: 2, holding: 1, faded: 1, strength: 0.4 }) }, asked);
    const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
    const a = await school.activity([{ name: "astro", blocks: ["q1", "q2"] }], 14, "UTC");
    // Oracle: RFC 5 §4.8, "at today ... from mastery_rollup with one group for the course".
    expect(asked).toEqual([{ course: "astro", groups: { astro: ["q1", "q2"] }, now: NOW, delayMs: REVIEW_DELAY_MS }]);
    expect(a.courses[0]).toMatchObject({ course: "astro", quizzes: 2, mastery: { notStarted: 0, settling: 0, holding: 1, faded: 1 } });
  });

  test("the rollup's mean strength is not passed on: it is for ranking, never for display", async () => {
    const record = recordWith({ astro: rolled("astro", { quizzes: 1, holding: 1, strength: 0.9 }) }, []);
    const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
    const course = (await school.activity([{ name: "astro", blocks: ["q1"] }], 14, "UTC")).courses[0]!;
    expect(Object.keys(course).sort()).toEqual(["course", "due", "mastery", "quizzes", "studied"]);
    expect(Object.keys(course.mastery).sort()).toEqual(["faded", "holding", "notStarted", "settling"]);
  });

  test("a course with no quizzes counts zero in every state", async () => {
    const record = recordWith({ bare: rolled("bare") }, []);
    const school = createSchool({ record, grader: grader({ status: "failed", error: "x" }), clock });
    expect((await school.activity([{ name: "bare", blocks: [] }], 14, "UTC")).courses[0])
      .toMatchObject({ quizzes: 0, mastery: { notStarted: 0, settling: 0, holding: 0, faded: 0 } });
  });
});
