// The LearningRecord contract (RFC 1, "The learning record contract"; RFC 3, §4). Every adapter
// of the port must pass this suite, so SQLite, PGlite and real Postgres cannot drift apart.
// It speaks only through the port; storage-level rules (append-only triggers, privileges) are
// tested beside each adapter, since how they are enforced is the adapter's business.
import { expect, test } from "bun:test";
import { ExposureKind, type Block, type DecisionNoteInput, type GradingRecord } from "../core/model.ts";
import type { LearningRecord } from "../core/ports.ts";

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
 * `declared.recordsExposures` is what the adapter says of itself (LearningRecord.recordsExposures):
 * an adapter that records exposures must pass the aid cases (RFC 2 §3); one that does not must
 * refuse every exposure and report every aid as unknown, never as "no recorded aid".
 */
export function learningRecordContract(name: string, make: () => Promise<LearningRecord>, declared: { recordsExposures: boolean }): void {
  const t = (title: string, fn: (r: LearningRecord) => Promise<void>) => test(`${name}: ${title}`, async () => fn(await make()));
  /** A case that holds only for an adapter that records exposures; skipped, visibly, for one that does not. */
  const tx = (title: string, fn: (r: LearningRecord) => Promise<void>) =>
    test.skipIf(!declared.recordsExposures)(`${name}: aid: ${title}`, async () => fn(await make()));

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

  t("the adapter declares whether it records exposures, as registered", async (r) => {
    expect(r.recordsExposures).toBe(declared.recordsExposures);
  });

  const exposure = (encounterId: string, blockId: string, kind: ExposureKind = "model-answer") =>
    ({ exposureId: uuid(), encounterId, blockId, kind });
  const tracked = (r: LearningRecord, page: Block, now = at(0)) => r.openEncounter({ course: "c", lesson: "l1", page, now, aidTracking: 1 });

  if (!declared.recordsExposures) {
    t("an adapter that does not record exposures refuses them, and every aid it reports is unknown", async (r) => {
      const e = await tracked(r, lesson("l1", [quiz("q1"), explain]));
      const answer = uuid();
      const explanation = uuid();
      await r.submit({ submissionId: answer, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1));
      expect(await r.recordExposure(exposure(e.id, "e1"), at(2))).toEqual({ status: "unsupported" });
      await r.saveExplanation({ submissionId: explanation, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, at(3));
      expect(await r.aid(answer)).toBe("unknown");
      expect(await r.aid(explanation)).toBe("unknown");
      expect(await r.aid(uuid())).toBeNull();
    });
  }

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
  // ---- Decision notes (RFC 2 §3 and §5; flyingrobots/school#31) --------------------------------

  const note = (o: Partial<DecisionNoteInput> & Pick<DecisionNoteInput, "evidence">): DecisionNoteInput => ({
    noteId: uuid(), choice: { course: "c", lesson: "l1", blockId: "q1" }, encounterId: null,
    rule: "due-review/wrong-first-try", reason: "The first answer was wrong, and the correction followed a model-answer reveal.", ...o,
  });
  const seqs = async (r: LearningRecord, encounterId: string, kind: string) =>
    (await r.encounterEvidence(encounterId)).filter((x) => x.kind === kind).map((x) => x.seq);

  tx("an encounter's evidence is every row it holds, by seq, with its kind and block", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1"), explain]));
    await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
    await r.recordExposure(exposure(e.id, "q1", "feedback"), at(2));
    const x = uuid();
    await r.saveExplanation({ submissionId: x, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, at(3));
    await r.recordGrading(failed(x, "down"), at(4));
    const rows = await r.encounterEvidence(e.id);
    expect(rows.map((row) => [row.kind, row.blockId])).toEqual([
      ["encounter", null], ["answer", "q1"], ["exposure", "q1"], ["explanation", "e1"], ["grading", "e1"],
    ]);
    expect(rows.map((row) => row.seq)).toEqual(rows.map((row) => row.seq).sort((a, b) => a - b));
    expect(new Set(rows.map((row) => row.seq)).size).toBe(rows.length);
    expect(await r.encounterEvidence(uuid())).toEqual([]);
  });

  tx("decision note, golden: it cites a wrong first try and a later aided correction, and reads back for its choice and encounter", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const first = await tracked(r, page);
    const wrong = uuid();
    const fixed = uuid();
    await r.submit({ submissionId: wrong, encounterId: first.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
    await r.recordExposure(exposure(first.id, "q1", "feedback"), at(2));
    await r.submit({ submissionId: fixed, encounterId: first.id, blockId: "q1", choiceId: "right", ms: 1 }, at(3));
    expect(await r.aid(fixed)).toBe("aided");
    const [wrongSeq, fixedSeq] = await seqs(r, first.id, "answer");
    const [shownSeq] = await seqs(r, first.id, "exposure");
    // The review is a later encounter, past the resume window, that the note was made for.
    const review = await tracked(r, page, at(4 * RESUME_WINDOW_MS));
    expect(review.id).not.toBe(first.id);
    const n = note({ encounterId: review.id, evidence: [wrongSeq!, shownSeq!, fixedSeq!] });
    const stored = await r.recordDecisionNote(n, at(4 * RESUME_WINDOW_MS + 1));
    expect(stored).toEqual({ status: "stored", note: {
      id: n.noteId, seq: expect.any(Number), choice: n.choice, encounterId: review.id, rule: n.rule, reason: n.reason,
      evidence: [wrongSeq!, shownSeq!, fixedSeq!], at: at(4 * RESUME_WINDOW_MS + 1),
    } });
    if (stored.status !== "stored") throw new Error("not stored");
    // Its evidence precedes it in the record's order.
    expect(Math.max(...stored.note.evidence)).toBeLessThan(stored.note.seq);
    expect(await r.decisionNotes(n.choice)).toEqual([stored.note]);
    expect(await r.encounterDecisionNotes(review.id)).toEqual([stored.note]);
    expect(await r.encounterDecisionNotes(first.id)).toEqual([]);
  });

  tx("a decision note citing a row that does not exist is refused, and stores nothing", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1")]));
    await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
    const [answer] = await seqs(r, e.id, "answer");
    const missing = 1_000_000_000;
    expect(await r.recordDecisionNote(note({ evidence: [missing] }), at(2))).toEqual({ status: "rejected" });
    expect(await r.recordDecisionNote(note({ evidence: [answer!, missing] }), at(3))).toEqual({ status: "rejected" });
    expect(await r.decisionNotes({ course: "c", lesson: "l1", blockId: "q1" })).toEqual([]);
  });

  tx("a decision note citing another course's evidence is refused", async (r) => {
    const mine = await tracked(r, lesson("l1", [quiz("q1")]));
    const theirs = await r.openEncounter({ course: "other", lesson: "l1", page: lesson("l1", [quiz("q1")]), now: at(1), aidTracking: 1 });
    await r.submit({ submissionId: uuid(), encounterId: mine.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(2));
    await r.submit({ submissionId: uuid(), encounterId: theirs.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(3));
    const [own] = await seqs(r, mine.id, "answer");
    const [foreign] = await seqs(r, theirs.id, "answer");
    expect(await r.recordDecisionNote(note({ evidence: [foreign!] }), at(4))).toEqual({ status: "rejected" });
    expect(await r.recordDecisionNote(note({ evidence: [own!, foreign!] }), at(5))).toEqual({ status: "rejected" });
    expect(await r.recordDecisionNote(note({ evidence: [own!] }), at(6))).toMatchObject({ status: "stored" });
    expect((await r.decisionNotes({ course: "c", lesson: "l1", blockId: "q1" })).map((x) => x.evidence)).toEqual([[own!]]);
  });

  tx("a decision note cites evidence, not notes: citing another note is refused", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1")]));
    await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
    const first = await r.recordDecisionNote(note({ evidence: await seqs(r, e.id, "answer") }), at(2));
    if (first.status !== "stored") throw new Error("not stored");
    expect(await r.recordDecisionNote(note({ evidence: [first.note.seq] }), at(3))).toEqual({ status: "rejected" });
  });

  tx("a decision note for an encounter of another course or lesson, or one without its block, is refused", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const e = await tracked(r, page);
    await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
    const evidence = await seqs(r, e.id, "answer");
    const otherLesson = await r.openEncounter({ course: "c", lesson: "l2", page: lesson("l2", [quiz("q1")]), now: at(2), aidTracking: 1 });
    const otherCourse = await r.openEncounter({ course: "other", lesson: "l1", page, now: at(3), aidTracking: 1 });
    for (const encounterId of [otherLesson.id, otherCourse.id, uuid()]) {
      expect(await r.recordDecisionNote(note({ encounterId, evidence }), at(4))).toEqual({ status: "rejected" });
    }
    expect(await r.recordDecisionNote(note({ encounterId: e.id, choice: { course: "c", lesson: "l1", blockId: "q9" }, evidence }), at(5)))
      .toEqual({ status: "rejected" });
    // A course-level choice may be made for any encounter of the course.
    expect(await r.recordDecisionNote(note({ encounterId: otherLesson.id, choice: { course: "c", lesson: null, blockId: null }, evidence }), at(6)))
      .toMatchObject({ status: "stored" });
  });

  tx("a decision note is stored once: a resend is a duplicate, and its id naming another note a conflict", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1")]));
    await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
    const n = note({ evidence: await seqs(r, e.id, "answer") });
    const stored = await r.recordDecisionNote(n, at(2));
    if (stored.status !== "stored") throw new Error("not stored");
    expect(await r.recordDecisionNote(n, at(3))).toEqual({ status: "duplicate", note: stored.note });
    expect(await r.recordDecisionNote({ ...n, reason: "Another reason." }, at(4))).toEqual({ status: "conflict" });
    expect(await r.recordDecisionNote({ ...n, rule: "due-review/other-rule" }, at(4))).toEqual({ status: "conflict" });
    expect(await r.recordDecisionNote({ ...n, evidence: [...n.evidence, ...(await seqs(r, e.id, "encounter"))] }, at(4))).toEqual({ status: "conflict" });
    expect(await r.decisionNotes(n.choice)).toEqual([stored.note]);
  });

  tx("decision notes are read for exactly their choice: a course, a lesson and a block are different choices", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1"), quiz("q2")]));
    const evidence = await seqs(r, e.id, "encounter");
    const choices = [
      { course: "c", lesson: null, blockId: null }, { course: "c", lesson: "l1", blockId: null },
      { course: "c", lesson: "l1", blockId: "q1" }, { course: "c", lesson: "l1", blockId: "q2" },
    ];
    const ids: string[] = [];
    for (const [i, choice] of choices.entries()) {
      const n = note({ choice, evidence });
      ids.push(n.noteId);
      expect(await r.recordDecisionNote(n, at(10 + i))).toMatchObject({ status: "stored" });
    }
    for (const [i, choice] of choices.entries()) expect((await r.decisionNotes(choice)).map((x) => x.id)).toEqual([ids[i]!]);
    expect(await r.decisionNotes({ course: "other", lesson: null, blockId: null })).toEqual([]);
  });

  tx("a decision note keeps citing the rows it named after a reinterpretation: a later grading supersedes, the note does not move", async (r) => {
    const e = await tracked(r, lesson("l1", [explain]));
    const x = uuid();
    await r.saveExplanation({ submissionId: x, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, at(1));
    const judged = await r.recordGrading(failed(x, "down"), at(2));
    const evidence = [...await seqs(r, e.id, "explanation"), ...await seqs(r, e.id, "grading")];
    expect(evidence).toHaveLength(2);
    const stored = await r.recordDecisionNote(note({ choice: { course: "c", lesson: "l1", blockId: "e1" }, evidence }), at(3));
    if (stored.status !== "stored") throw new Error("not stored");
    const regraded = await r.recordGrading(succeeded(x), at(4));
    expect(regraded.supersedes).toBe(judged.id);
    const [again] = await r.decisionNotes({ course: "c", lesson: "l1", blockId: "e1" });
    expect(again).toEqual(stored.note);
    expect(again!.evidence).not.toContain(regraded.id);
    // The cited grading is still in the record, though no longer the latest.
    expect(await seqs(r, e.id, "grading")).toEqual([evidence[1]!, regraded.id]);
  });
}
