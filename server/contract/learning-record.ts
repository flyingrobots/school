// The LearningRecord contract (RFC 1, "The learning record contract"; RFC 3, §4). Every adapter
// of the port must pass this suite, so PGlite and real Postgres cannot drift apart.
// It speaks only through the port; storage-level rules (append-only triggers, privileges) are
// tested beside each adapter, since how they are enforced is the adapter's business.
import { expect, test } from "bun:test";
import { ExposureKind, type Block, type GradingRecord } from "../core/model.ts";
import type { LearningRecord } from "../core/ports.ts";

/**
 * Six hours: `school.open_encounter`'s resume window. 0001_init.sql's comment calls it
 * server/record.ts RESUME_WINDOW_MS; that module went with SQLite (flyingrobots/school#49).
 */
export const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

const quiz = (id: string): Block => ({
  type: "quiz", id, q: "Which?", why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});
const explain: Block = {
  type: "explain", id: "e1", prompt: "Say why.", model: "Because it is so.",
  sources: [{ id: "src", title: "Source", text: "It is so because of reasons." }],
};
const lesson = (id: string, children: Block[], subtitle = ""): Block => ({ type: "page", id, title: id, subtitle, children });

const T0 = Date.parse("2026-11-21T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const uuid = () => crypto.randomUUID();

const failed = (submissionId: string, error: string): GradingRecord => ({
  status: "failed", findings: null, error, submissionId, rubricVersion: "rubric-v1", promptVersion: "prompt-v1",
  adapter: "test", model: null, sources: [], raw: null,
});
const succeeded = (submissionId: string): GradingRecord => ({
  status: "succeeded", error: null, submissionId, rubricVersion: "rubric-v1", promptVersion: "prompt-v1",
  adapter: "test", model: "m", sources: [], raw: "{}",
  findings: {
    insufficient_evidence: false, summary: "Good.", contradictions: [],
    fidelity: { verdict: "meets", note: "" }, completeness: { verdict: "partly", note: "" }, accessibility: { verdict: "meets", note: "" },
  },
});

/**
 * Register the contract's tests for one adapter. `make` returns a fresh, empty record each time.
 * Every adapter records exposures and must pass the aid cases (RFC 2 §3).
 */
export function learningRecordContract(name: string, make: () => Promise<LearningRecord>): void {
  const t = (title: string, fn: (r: LearningRecord) => Promise<void>) => test(`${name}: ${title}`, async () => fn(await make()));
  /** An aid case (RFC 2 §3). */
  const tx = (title: string, fn: (r: LearningRecord) => Promise<void>) => test(`${name}: aid: ${title}`, async () => fn(await make()));

  t("wrong, then right, then a resend: correctness and first try are derived, and the resend is a duplicate", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(0) });
    expect(e.resumed).toBe(false);
    const rightId = uuid();
    expect(await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1000 }, at(1000)))
      .toEqual({ status: "stored", correct: false, firstTry: true });
    expect(await r.submit({ submissionId: rightId, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 2000 }, at(2000)))
      .toEqual({ status: "stored", correct: true, firstTry: false });
    expect(await r.submit({ submissionId: rightId, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 2000 }, at(3000)))
      .toEqual({ status: "duplicate", correct: true, firstTry: false });
    expect(await r.encounterAnswers(e.id)).toEqual([
      { blockId: "q1", choiceId: "wrong", correct: false },
      { blockId: "q1", choiceId: "right", correct: true },
    ]);
  });

  t("correctness comes from the snapshot, not from the client", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(0) });
    const forged = { submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 5, correct: true };
    expect(await r.submit(forged, at(1))).toMatchObject({ status: "stored", correct: false });
  });

  t("a reload inside the resume window resumes the encounter, so first try does not reset", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) });
    await r.submit({ submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1000));
    const e2 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(60_000) });
    expect(e2).toEqual({ id: e1.id, hash: e1.hash, resumed: true });
    expect(await r.submit({ submissionId: uuid(), encounterId: e2.id, blockId: "q1", choiceId: "right", ms: 1 }, at(61_000)))
      .toMatchObject({ firstTry: false });
  });

  t("the resume window runs from the last answer, and past it a new encounter starts afresh", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) });
    await r.submit({ submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(RESUME_WINDOW_MS - 1000));
    expect((await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(RESUME_WINDOW_MS + 1000) })).id).toBe(e1.id);
    const later = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(3 * RESUME_WINDOW_MS) });
    expect(later.id).not.toBe(e1.id);
    expect(later.resumed).toBe(false);
    expect(await r.submit({ submissionId: uuid(), encounterId: later.id, blockId: "q1", choiceId: "right", ms: 1 }, at(3 * RESUME_WINDOW_MS + 1)))
      .toMatchObject({ firstTry: true });
  });

  t("an explanation is activity: one written late in the window keeps the encounter open past it", async (r) => {
    const page = lesson("l1", [quiz("q1"), explain]);
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) });
    await r.saveExplanation({ submissionId: uuid(), encounterId: e1.id, blockId: "e1", text: "Because.", ms: 1 }, at(RESUME_WINDOW_MS - 1000));
    expect(await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(RESUME_WINDOW_MS + 1000) }))
      .toEqual({ id: e1.id, hash: e1.hash, resumed: true });
  });

  t("grading is not the learner's activity: a late grading does not keep the encounter open", async (r) => {
    const page = lesson("l1", [explain]);
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) });
    const id = uuid();
    await r.saveExplanation({ submissionId: id, encounterId: e1.id, blockId: "e1", text: "Because.", ms: 1 }, at(1000));
    await r.recordGrading(succeeded(id), at(2 * RESUME_WINDOW_MS));
    const later = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(2 * RESUME_WINDOW_MS + 1000) });
    expect(later.id).not.toBe(e1.id);
    expect(later.resumed).toBe(false);
  });

  t("an edited lesson is a new snapshot and a new encounter; the old answers stay with the old one", async (r) => {
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(0) });
    await r.submit({ submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1));
    const e2 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")], "edited"), now: at(2) });
    expect(e2.hash).not.toBe(e1.hash);
    expect(e2.id).not.toBe(e1.id);
    expect(await r.encounterAnswers(e1.id)).toHaveLength(1);
    expect(await r.encounterAnswers(e2.id)).toEqual([]);
  });

  t("the same content in any key order is the same snapshot", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const shuffled = JSON.parse(JSON.stringify({ children: page.type === "page" ? page.children : [], subtitle: "", title: "l1", id: "l1", type: "page" }));
    const a = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) });
    const b = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: shuffled, now: at(1) });
    expect(b).toEqual({ id: a.id, hash: a.hash, resumed: true });
  });

  t("a choice, block or encounter that is not in the snapshot is rejected and stores nothing", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(0) });
    expect(await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "nope", ms: 1 }, at(1))).toEqual({ status: "rejected" });
    expect(await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q9", choiceId: "right", ms: 1 }, at(1))).toEqual({ status: "rejected" });
    expect(await r.submit({ submissionId: uuid(), encounterId: uuid(), blockId: "q1", choiceId: "right", ms: 1 }, at(1))).toEqual({ status: "rejected" });
    expect(await r.encounterAnswers(e.id)).toEqual([]);
  });

  t("reusing a submission id for a different answer is a conflict, and the first answer stands", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(0) });
    const id = uuid();
    await r.submit({ submissionId: id, encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
    expect(await r.submit({ submissionId: id, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(2))).toEqual({ status: "conflict" });
    expect((await r.encounterAnswers(e.id)).map((a) => a.choiceId)).toEqual(["wrong"]);
  });

  t("a submission resent fifty times is stored once", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(0) });
    const s = { submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 };
    for (let i = 0; i < 50; i++) await r.submit(s, at(i));
    expect(await r.encounterAnswers(e.id)).toHaveLength(1);
  });

  t("course progress lists each lesson's quizzes ever answered correctly, across encounters", async (r) => {
    const page = lesson("l1", [quiz("q1"), quiz("q2")]);
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) });
    await r.submit({ submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1));
    await r.submit({ submissionId: uuid(), encounterId: e1.id, blockId: "q2", choiceId: "wrong", ms: 1 }, at(2));
    const e2 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(10 * RESUME_WINDOW_MS) });
    await r.submit({ submissionId: uuid(), encounterId: e2.id, blockId: "q1", choiceId: "right", ms: 1 }, at(10 * RESUME_WINDOW_MS + 1));
    expect(await r.lessonProgress("c")).toEqual({ l1: ["q1"] });
    expect(await r.lessonProgress("other")).toEqual({});
  });

  t("where the learner left off is null on an empty record", async (r) => {
    expect(await r.lastStudied()).toBeNull();
  });

  t("where the learner left off is the lesson of their latest opening, answer, explanation or view", async (r) => {
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1"), explain]), now: at(0) });
    expect(await r.lastStudied()).toEqual({ course: "c", lesson: "l1", at: at(0) });
    const e2 = await r.openEncounter({ course: "c", lesson: "l2", aidTracking: null, page: lesson("l2", [quiz("q2")]), now: at(1000) });
    expect(await r.lastStudied()).toEqual({ course: "c", lesson: "l2", at: at(1000) });
    await r.submit({ submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(2000));
    expect(await r.lastStudied()).toEqual({ course: "c", lesson: "l1", at: at(2000) });
    await r.submit({ submissionId: uuid(), encounterId: e2.id, blockId: "q2", choiceId: "right", ms: 1 }, at(3000));
    expect(await r.lastStudied()).toEqual({ course: "c", lesson: "l2", at: at(3000) });
    await r.saveExplanation({ submissionId: uuid(), encounterId: e1.id, blockId: "e1", text: "Because.", ms: 1 }, at(4000));
    expect(await r.lastStudied()).toEqual({ course: "c", lesson: "l1", at: at(4000) });
    await r.recordView({ course: "d", lesson: "x" }, at(5000));
    expect(await r.lastStudied()).toEqual({ course: "d", lesson: "x", at: at(5000) });
  });

  t("an answer the record refuses does not move where the learner left off", async (r) => {
    const e1 = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(0) });
    await r.openEncounter({ course: "c", lesson: "l2", aidTracking: null, page: lesson("l2", [quiz("q2")]), now: at(1000) });
    expect(await r.submit({ submissionId: uuid(), encounterId: e1.id, blockId: "no-such-quiz", choiceId: "right", ms: 1 }, at(2000)))
      .toEqual({ status: "rejected" });
    expect(await r.lastStudied()).toEqual({ course: "c", lesson: "l2", at: at(1000) });
  });

  t("an explanation is saved once; a resend is a duplicate and different text under its id a conflict", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [explain]), now: at(0) });
    const s = { submissionId: uuid(), encounterId: e.id, blockId: "e1", text: "Because reasons.", ms: 10 };
    expect(await r.saveExplanation(s, at(1))).toEqual({ status: "stored" });
    expect(await r.saveExplanation(s, at(2))).toEqual({ status: "duplicate" });
    expect(await r.saveExplanation({ ...s, text: "Other." }, at(3))).toEqual({ status: "conflict" });
    const saved = await r.explanation(s.submissionId);
    expect(saved?.block).toEqual(explain as never);
    expect(saved?.state).toEqual({ submissionId: s.submissionId, blockId: "e1", text: "Because reasons.", at: at(1), grading: null });
  });

  t("an explanation for a block that is not an explain block in the snapshot, or no encounter, is rejected", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1"), explain]), now: at(0) });
    expect(await r.saveExplanation({ submissionId: uuid(), encounterId: e.id, blockId: "q1", text: "x", ms: 1 }, at(1))).toEqual({ status: "rejected" });
    expect(await r.saveExplanation({ submissionId: uuid(), encounterId: uuid(), blockId: "e1", text: "x", ms: 1 }, at(1))).toEqual({ status: "rejected" });
    expect(await r.explanation(uuid())).toBeNull();
  });

  t("each grading attempt is stored; a retry supersedes the latest, and nothing is overwritten", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [explain]), now: at(0) });
    const id = uuid();
    await r.saveExplanation({ submissionId: id, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, at(1));
    const first = await r.recordGrading(failed(id, "the bridge could not be reached"), at(2));
    expect(first).toMatchObject({ status: "failed", error: "the bridge could not be reached", supersedes: null, model: null, at: at(2) });
    const second = await r.recordGrading(succeeded(id), at(3));
    expect(second).toMatchObject({ status: "succeeded", supersedes: first.id, model: "m", at: at(3) });
    expect(second.status === "succeeded" && second.findings.summary).toBe("Good.");
    expect((await r.explanation(id))?.state.grading).toEqual(second);
  });

  t("a reload sees the latest explanation per block, each with its latest grading", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page: lesson("l1", [explain]), now: at(0) });
    const old = uuid();
    const latest = uuid();
    await r.saveExplanation({ submissionId: old, encounterId: e.id, blockId: "e1", text: "First go.", ms: 1 }, at(1));
    await r.saveExplanation({ submissionId: latest, encounterId: e.id, blockId: "e1", text: "Second go.", ms: 1 }, at(2));
    const g = await r.recordGrading(succeeded(latest), at(3));
    expect(await r.encounterExplanations(e.id)).toEqual([{ submissionId: latest, blockId: "e1", text: "Second go.", at: at(2), grading: g }]);
  });

  t("a view is recorded without error", async (r) => {
    await r.recordView({ course: "c", lesson: "l1" }, at(0));
  });

  // ---- Exposures and derived aid (RFC 2 §3, Listing 1; flyingrobots/school#29) ----------------

  const exposure = (encounterId: string, blockId: string, kind: ExposureKind = "model-answer") =>
    ({ exposureId: uuid(), encounterId, blockId, kind });
  const tracked = (r: LearningRecord, page: Block, now = at(0)) => r.openEncounter({ course: "c", lesson: "l1", page, now, aidTracking: 1 });

  tx("RFC 2 Figure 4: submit, reveal, revise is no recorded aid, then aided", async (r) => {
    const e = await tracked(r, lesson("l1", [explain]));
    const a = uuid();
    const b = uuid();
    expect(await r.saveExplanation({ submissionId: a, encounterId: e.id, blockId: "e1", text: "First go.", ms: 1 }, at(1))).toEqual({ status: "stored" });
    expect(await r.aid(a)).toBe("no-recorded-aid");
    expect(await r.recordExposure(exposure(e.id, "e1", "model-answer"), at(2))).toEqual({ status: "stored" });
    expect(await r.saveExplanation({ submissionId: b, encounterId: e.id, blockId: "e1", text: "Revised.", ms: 1 }, at(3))).toEqual({ status: "stored" });
    expect(await r.aid(b)).toBe("aided");
    // A later exposure never reclassifies earlier work.
    expect(await r.aid(a)).toBe("no-recorded-aid");
  });

  for (const kind of ExposureKind.options) {
    tx(`a ${kind} exposure is recorded, and makes the next answer to its block aided`, async (r) => {
      const e = await tracked(r, lesson("l1", [quiz("q1")]));
      const before = uuid();
      const after = uuid();
      await r.submit({ submissionId: before, encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
      expect(await r.recordExposure(exposure(e.id, "q1", kind), at(2))).toEqual({ status: "stored" });
      await r.submit({ submissionId: after, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(3));
      expect(await r.aid(before)).toBe("no-recorded-aid");
      expect(await r.aid(after)).toBe("aided");
    });
  }

  tx("an untracked encounter's aid is unknown, and it refuses exposures", async (r) => {
    const e = await r.openEncounter({ course: "c", lesson: "l1", page: lesson("l1", [quiz("q1"), explain]), now: at(0), aidTracking: null });
    const answer = uuid();
    const explanation = uuid();
    await r.submit({ submissionId: answer, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1));
    expect(await r.recordExposure(exposure(e.id, "e1"), at(2))).toEqual({ status: "rejected" });
    await r.saveExplanation({ submissionId: explanation, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, at(3));
    expect(await r.aid(answer)).toBe("unknown");
    expect(await r.aid(explanation)).toBe("unknown");
  });

  tx("a tracked open does not resume an untracked encounter, or the reverse", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const untracked = await r.openEncounter({ course: "c", lesson: "l1", page, now: at(0), aidTracking: null });
    const on = await tracked(r, page, at(1));
    expect(on.id).not.toBe(untracked.id);
    expect(on.resumed).toBe(false);
    expect(await tracked(r, page, at(2))).toEqual({ id: on.id, hash: on.hash, resumed: true });
    expect((await r.openEncounter({ course: "c", lesson: "l1", page, now: at(3), aidTracking: null })).id).not.toBe(on.id);
  });

  tx("an exposure aids only its own block in its own encounter", async (r) => {
    const page = lesson("l1", [quiz("q1"), quiz("q2")]);
    const e1 = await tracked(r, page);
    await r.recordExposure(exposure(e1.id, "q1", "feedback"), at(1));
    const other = uuid();
    await r.submit({ submissionId: other, encounterId: e1.id, blockId: "q2", choiceId: "right", ms: 1 }, at(2));
    expect(await r.aid(other)).toBe("no-recorded-aid");
    const e2 = await tracked(r, page, at(10 * RESUME_WINDOW_MS));
    expect(e2.id).not.toBe(e1.id);
    const later = uuid();
    await r.submit({ submissionId: later, encounterId: e2.id, blockId: "q1", choiceId: "right", ms: 1 }, at(10 * RESUME_WINDOW_MS + 1));
    expect(await r.aid(later)).toBe("no-recorded-aid");
  });

  tx("before and after are the record's order, never the clock's", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1"), quiz("q2")]));
    // Shown first, though its clock reads later than the answer after it.
    await r.recordExposure(exposure(e.id, "q1"), at(9000));
    const aided = uuid();
    await r.submit({ submissionId: aided, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1000));
    expect(await r.aid(aided)).toBe("aided");
    // Answered first, though its clock reads later than the exposure after it.
    const unaided = uuid();
    await r.submit({ submissionId: unaided, encounterId: e.id, blockId: "q2", choiceId: "right", ms: 1 }, at(9000));
    await r.recordExposure(exposure(e.id, "q2"), at(1000));
    expect(await r.aid(unaided)).toBe("no-recorded-aid");
  });

  tx("an exposure is stored once: a resend is a duplicate, and its id naming something else a conflict", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1"), explain]));
    const x = exposure(e.id, "e1", "model-answer");
    expect(await r.recordExposure(x, at(1))).toEqual({ status: "stored" });
    for (let i = 0; i < 5; i++) expect(await r.recordExposure(x, at(2 + i))).toEqual({ status: "duplicate" });
    expect(await r.recordExposure({ ...x, kind: "hint" }, at(8))).toEqual({ status: "conflict" });
    expect(await r.recordExposure({ ...x, blockId: "q1" }, at(8))).toEqual({ status: "conflict" });
    // The conflicting resend stored nothing: q1 still has no recorded aid.
    const answer = uuid();
    await r.submit({ submissionId: answer, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(9));
    expect(await r.aid(answer)).toBe("no-recorded-aid");
  });

  tx("an exposure for a block that is not a quiz or explain block in the snapshot, or for no encounter, is rejected", async (r) => {
    const page = lesson("l1", [{ type: "prose", id: "p1", html: "<p>Hi</p>" }, quiz("q1")]);
    const e = await tracked(r, page);
    expect(await r.recordExposure(exposure(e.id, "q9"), at(1))).toEqual({ status: "rejected" });
    expect(await r.recordExposure(exposure(e.id, "p1"), at(1))).toEqual({ status: "rejected" });
    expect(await r.recordExposure(exposure(e.id, "right"), at(1))).toEqual({ status: "rejected" }); // a choice id, not a block
    expect(await r.recordExposure(exposure(uuid(), "q1"), at(1))).toEqual({ status: "rejected" });
    // None of the rejected exposures was stored.
    const answer = uuid();
    await r.submit({ submissionId: answer, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(2));
    expect(await r.aid(answer)).toBe("no-recorded-aid");
  });

  tx("an exposure after the resume window is still its encounter's, and aids a later answer there", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1")]));
    expect(await r.recordExposure(exposure(e.id, "q1", "feedback"), at(2 * RESUME_WINDOW_MS))).toEqual({ status: "stored" });
    const late = uuid();
    await r.submit({ submissionId: late, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(2 * RESUME_WINDOW_MS + 1));
    expect(await r.aid(late)).toBe("aided");
  });

  tx("the aid of a submission that does not exist is null", async (r) => {
    expect(await r.aid(uuid())).toBeNull();
  });
}
