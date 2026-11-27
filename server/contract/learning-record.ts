// The LearningRecord contract (RFC 1, "The learning record contract"; RFC 3, §4). Every adapter
// of the port must pass this suite, so PGlite and real Postgres cannot drift apart.
// It speaks only through the port; storage-level rules (append-only triggers, privileges) are
// tested beside each adapter, since how they are enforced is the adapter's business.
import { expect, test } from "bun:test";
import { ExposureKind, type Block, type CourseInstall, type DecisionNoteInput, type GradingRecord, type InstalledCourse } from "../core/model.ts";
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

// Installs (RFC 7 §7). A hash here is any lowercase hex of the right length: the record checks shapes, not content.
const hex = (n: number, c: string) => c.repeat(n);
const gitInstall = (o: Partial<Extract<CourseInstall, { source: "git" }>> = {}): CourseInstall => ({
  id: uuid(), course: "bells", source: "git", url: "https://github.com/flyingrobots/school-bells.git", bundleSha256: null,
  commit: hex(40, "a"), contentSha256: hex(64, "c"), title: "Bells", format: 1, ...o,
});
const bundleInstall = (o: Partial<Extract<CourseInstall, { source: "bundle" }>> = {}): CourseInstall => ({
  id: uuid(), course: "bells", source: "bundle", url: null, bundleSha256: hex(64, "b"),
  commit: hex(64, "d"), contentSha256: hex(64, "e"), title: "Bells", format: null, ...o,
});
const current = (i: CourseInstall, now: string, trusted = false): InstalledCourse => ({ ...i, at: now, trusted });

/** A small seeded generator (mulberry32), so a fuzz case replays from its seed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** CI's fixed seed; SCHOOL_TEST_SEED replays or explores another. */
const FUZZ_SEED = Number(process.env.SCHOOL_TEST_SEED ?? 232);

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

  // Since the learner was last here (flyingrobots/school#165).
  t("study days are the local days with an answer or a saved explanation, per course, in the window (flyingrobots/school#177)", async (r) => {
    const DAY = 24 * 3600 * 1000;
    expect(await r.studyDays({ from: at(-DAY), to: at(4 * DAY), tz: "UTC" })).toEqual([]);
    const page = lesson("l1", [quiz("q1"), explain]);
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) }); // 21 Nov, 10:00 UTC
    await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(90 * 60_000)); // 11:30 UTC
    await r.saveExplanation({ submissionId: uuid(), encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, at(DAY)); // 22 Nov
    // A visit is not study: a view on the 23rd, and a lesson opened on the 24th with nothing answered.
    await r.recordView({ course: "d", lesson: "x" }, at(2 * DAY));
    await r.openEncounter({ course: "d", lesson: "x", aidTracking: null, page: lesson("x", [quiz("q1")]), now: at(3 * DAY) });
    expect(await r.studyDays({ from: at(-DAY), to: at(4 * DAY), tz: "UTC" })).toEqual([
      { course: "c", day: "2026-11-21" },
      { course: "c", day: "2026-11-22" },
    ]);
    // In Auckland (UTC+13) the answer at 11:30 UTC falls on the 22nd; the opening on the 21st is no study.
    expect(await r.studyDays({ from: at(-DAY), to: at(DAY / 2), tz: "Pacific/Auckland" })).toEqual([{ course: "c", day: "2026-11-22" }]);
    // The window is half-open: [from, to).
    expect(await r.studyDays({ from: at(DAY), to: at(2 * DAY), tz: "UTC" })).toEqual([{ course: "c", day: "2026-11-22" }]);
  });

  // The learner's chosen time zone (flyingrobots/school#181): appended, never edited; the newest wins.
  t("no time zone is chosen at first; each choice is kept, the newest wins, and null goes back to automatic", async (r) => {
    expect(await r.timeZone()).toBeNull();
    await r.chooseTimeZone("Pacific/Auckland", at(0));
    expect(await r.timeZone()).toBe("Pacific/Auckland");
    await r.chooseTimeZone("America/Los_Angeles", at(1000));
    expect(await r.timeZone()).toBe("America/Los_Angeles");
    await r.chooseTimeZone(null, at(2000));
    expect(await r.timeZone()).toBeNull();
  });

  t("the latest feedback is the newest succeeded grading, with where its explanation was written; none before one", async (r) => {
    expect(await r.latestFeedback()).toBeNull();
    const page = lesson("l1", [explain]);
    const e = await r.openEncounter({ course: "c", lesson: "l1", aidTracking: null, page, now: at(0) });
    const first = uuid(), second = uuid();
    await r.saveExplanation({ submissionId: first, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, at(1000));
    await r.recordGrading(failed(first, "the bridge could not be reached"), at(2000));
    expect(await r.latestFeedback()).toBeNull();
    await r.recordGrading(succeeded(first), at(3000));
    await r.saveExplanation({ submissionId: second, encounterId: e.id, blockId: "e1", text: "Because, again.", ms: 1 }, at(4000));
    await r.recordGrading(succeeded(second), at(5000));
    expect(await r.latestFeedback()).toEqual({
      submissionId: second, course: "c", lesson: "l1", blockId: "e1", model: "m", findings: succeeded(second).findings!, at: at(5000),
    });
    // A failed retry of an earlier submission does not hide the newest success.
    await r.recordGrading(failed(first, "the bridge could not be reached"), at(6000));
    expect((await r.latestFeedback())?.submissionId).toBe(second);
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
  // ---- Decision notes (RFC 2 §3 and §5; flyingrobots/school#31) --------------------------------

  const note = (o: Partial<DecisionNoteInput> & Pick<DecisionNoteInput, "evidence">): DecisionNoteInput => ({
    noteId: uuid(), choice: { course: "c", lesson: "l1", blockId: "q1" }, encounterId: null,
    rule: "due-review/wrong-first-try", reason: "The model answer helped you find this one. It's back so you can answer it from memory.", ...o,
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

  // ---- Due review (RFC 2 §5; flyingrobots/school#32) -------------------------------------------
  // The selector reads answers, first tries, exposures and the time each block was last answered,
  // all by seq, and returns the blocks due with the rule that chose each and the rows it cites.

  /** A case of the selector or of opening a lesson with review. */
  const dr = (title: string, fn: (r: LearningRecord) => Promise<void>) =>
    test(`${name}: due review: ${title}`, async () => fn(await make()));
  const DELAY = 20 * 60 * 60 * 1000;
  const due = (r: LearningRecord, blocks: string[], now: string, limit = 10) =>
    r.dueReview({ course: "c", blocks, now, delayMs: DELAY, limit });
  const answer = (r: LearningRecord, encounterId: string, blockId: string, choiceId: "right" | "wrong", now: string) =>
    r.submit({ submissionId: uuid(), encounterId, blockId, choiceId, ms: 1 }, now);
  /** The seqs of an encounter's rows of one kind for one block, oldest first. */
  const rowsOf = async (r: LearningRecord, encounterId: string, kind: string, blockId: string | null) =>
    (await r.encounterEvidence(encounterId)).filter((x) => x.kind === kind && x.blockId === blockId).map((x) => x.seq);

  dr("an item answered wrong first returns after its delay, citing the wrong answer, the help shown and the correction", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1"), quiz("q2")]));
    await answer(r, e.id, "q1", "wrong", at(1));
    await r.recordExposure(exposure(e.id, "q1", "feedback"), at(2));
    await answer(r, e.id, "q1", "right", at(3));
    await answer(r, e.id, "q2", "right", at(4)); // right first try, nothing shown before it: not due
    const [wrong, right] = await rowsOf(r, e.id, "answer", "q1");
    const [shown] = await rowsOf(r, e.id, "exposure", "q1");
    expect(await due(r, ["q1", "q2"], at(4 + DELAY - 2))).toEqual([]); // q1 was last seen less than the delay ago
    const items = await due(r, ["q1", "q2"], at(3 + DELAY));
    expect(items).toEqual([{
      blockId: "q1", rule: "due-review/wrong-first-try", answeredAt: at(1), corrected: true, shown: ["feedback"],
      lastSeen: at(3), evidence: [wrong!, shown!, right!],
    }]);
    // Reading is all it does: asking again gives the same answer.
    expect(await due(r, ["q1", "q2"], at(3 + DELAY))).toEqual(items);
  });

  dr("an item never put right returns, citing every answer in that encounter", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1")]));
    await answer(r, e.id, "q1", "wrong", at(1));
    await answer(r, e.id, "q1", "wrong", at(2));
    expect(await due(r, ["q1"], at(2 + DELAY))).toEqual([{
      blockId: "q1", rule: "due-review/wrong-first-try", answeredAt: at(1), corrected: false, shown: [],
      lastSeen: at(2), evidence: await rowsOf(r, e.id, "answer", "q1"),
    }]);
  });

  dr("an item answered right only after an exposure returns as aided, citing the exposure and the answer", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1")]));
    await r.recordExposure(exposure(e.id, "q1", "hint"), at(1));
    await answer(r, e.id, "q1", "right", at(2));
    await r.recordExposure(exposure(e.id, "q1", "feedback"), at(3)); // after the answer: no part of the reason
    const [hint] = await rowsOf(r, e.id, "exposure", "q1");
    expect(await due(r, ["q1"], at(2 + DELAY))).toEqual([{
      blockId: "q1", rule: "due-review/aided-first-try", answeredAt: at(2), corrected: false, shown: ["hint"],
      lastSeen: at(2), evidence: [hint!, ...await rowsOf(r, e.id, "answer", "q1")],
    }]);
  });

  dr("unknown aid: a right first try School was not watching returns, citing its untracked encounter, and never clears an item", async (r) => {
    const old = await r.openEncounter({ course: "c", lesson: "l1", page: lesson("l1", [quiz("q1"), quiz("q2")]), now: at(0), aidTracking: null });
    await answer(r, old.id, "q1", "right", at(1));
    const [opened] = await rowsOf(r, old.id, "encounter", null);
    expect(await due(r, ["q1"], at(1 + DELAY))).toEqual([{
      blockId: "q1", rule: "due-review/unknown-aid", answeredAt: at(1), corrected: false, shown: [],
      lastSeen: at(1), evidence: [opened!, ...await rowsOf(r, old.id, "answer", "q1")],
    }]);
    // q2 was answered wrong while School watched; a right first try a delay later, unwatched, does not clear it.
    const e = await r.openEncounter({ course: "c", lesson: "l2", page: lesson("l2", [quiz("q2")]), now: at(2), aidTracking: 1 });
    await answer(r, e.id, "q2", "wrong", at(3));
    const late = await r.openEncounter({ course: "c", lesson: "l2", page: lesson("l2", [quiz("q2")]), now: at(3 + DELAY), aidTracking: null });
    await answer(r, late.id, "q2", "right", at(4 + DELAY));
    const [item] = await due(r, ["q2"], at(4 + 2 * DELAY));
    expect(item).toMatchObject({ blockId: "q2", rule: "due-review/unknown-aid", answeredAt: at(4 + DELAY) });
  });

  dr("no items due: an empty record, right first tries, items seen within the delay, and blocks not asked about", async (r) => {
    expect(await due(r, ["q1", "q2"], at(0))).toEqual([]);
    expect(await due(r, [], at(0))).toEqual([]);
    const e = await tracked(r, lesson("l1", [quiz("q1"), quiz("q2"), quiz("q3")]));
    await answer(r, e.id, "q1", "right", at(1));
    await answer(r, e.id, "q2", "wrong", at(2));
    expect(await due(r, ["q1", "q2"], at(1 + DELAY))).toEqual([]); // q2 was seen 1 ms less than the delay ago
    expect(await due(r, ["q1", "q3"], at(10 * DELAY))).toEqual([]); // q2 is due, but was not asked about
    // Another course's record is not this course's.
    expect(await r.dueReview({ course: "other", blocks: ["q2"], now: at(10 * DELAY), delayMs: DELAY, limit: 10 })).toEqual([]);
  });

  dr("a right first try with no recorded aid clears an item only once the delay has passed since it was last wrong", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const first = await tracked(r, page);
    await answer(r, first.id, "q1", "wrong", at(1));
    // Within the delay, a new encounter of an edited lesson answers it right first try: memory of a minute ago, not a review.
    const soon = await tracked(r, lesson("l1", [quiz("q1")], "edited"), at(60_000));
    await answer(r, soon.id, "q1", "right", at(60_001));
    expect((await due(r, ["q1"], at(60_001 + DELAY))).map((x) => [x.blockId, x.rule, x.lastSeen])).toEqual([["q1", "due-review/wrong-first-try", at(60_001)]]);
    // A delay after it was last wrong, right first try with nothing shown: cleared.
    const later = await tracked(r, page, at(1 + DELAY + 60_000));
    await answer(r, later.id, "q1", "right", at(1 + DELAY + 60_001));
    expect(await due(r, ["q1"], at(10 * DELAY))).toEqual([]);
    // Wrong again in a later encounter: due again.
    const again = await tracked(r, page, at(20 * DELAY));
    await answer(r, again.id, "q1", "wrong", at(20 * DELAY + 1));
    expect((await due(r, ["q1"], at(30 * DELAY))).map((x) => x.answeredAt)).toEqual([at(20 * DELAY + 1)]);
  });

  dr("order is the record's, by seq, never by `at`: first try, prior help, last seen and the order of items", async (r) => {
    const e = await tracked(r, lesson("l1", [quiz("q1"), quiz("q2"), quiz("q3")]));
    // Sent in this order, with clocks that disagree: an outbox flush, or a clock stepped back.
    await answer(r, e.id, "q2", "wrong", at(5000));
    await answer(r, e.id, "q1", "wrong", at(1000));
    await r.recordExposure(exposure(e.id, "q3", "hint"), at(9000)); // before q3's answer by seq, after it by `at`
    await answer(r, e.id, "q3", "right", at(2000));
    await answer(r, e.id, "q1", "right", at(900)); // q1's last answer by seq, earliest by `at`
    const items = await due(r, ["q1", "q2", "q3"], at(5000 + DELAY));
    expect(items.map((x) => [x.blockId, x.rule])).toEqual([
      ["q2", "due-review/wrong-first-try"], ["q1", "due-review/wrong-first-try"], ["q3", "due-review/aided-first-try"],
    ]);
    expect(items.map((x) => x.lastSeen)).toEqual([at(5000), at(900), at(2000)]);
  });

  dr("items rank by rule, wrong first tries, then aided, then unknown aid, oldest first within a rule, bounded by the limit", async (r) => {
    const untracked = await r.openEncounter({ course: "c", lesson: "l0", page: lesson("l0", [quiz("u1")]), now: at(0), aidTracking: null });
    await answer(r, untracked.id, "u1", "right", at(1));
    const e = await tracked(r, lesson("l1", [quiz("a1"), quiz("w1"), quiz("w2")]), at(2));
    await r.recordExposure(exposure(e.id, "a1", "hint"), at(3));
    await answer(r, e.id, "a1", "right", at(4));
    await answer(r, e.id, "w1", "wrong", at(5));
    await answer(r, e.id, "w2", "wrong", at(6));
    const all = ["u1", "a1", "w1", "w2"];
    expect((await due(r, all, at(6 + DELAY))).map((x) => x.blockId)).toEqual(["w1", "w2", "a1", "u1"]);
    expect((await due(r, all, at(6 + DELAY), 2)).map((x) => x.blockId)).toEqual(["w1", "w2"]);
    expect(await due(r, all, at(6 + DELAY), 0)).toEqual([]);
  });

  // Opening a lesson with review: the review is snapshotted with the lesson, and its notes with the encounter.
  const reviewSection = (blocks: Block[]): Block => ({ type: "section", id: "school:review", title: "Review", children: blocks });
  const withReview = (page: Block, blocks: Block[]): Block =>
    page.type === "page" ? { ...page, children: [reviewSection(blocks), ...page.children] } : page;

  dr("opening a lesson with review snapshots the review and stores one note per item for the encounter", async (r) => {
    const first = await tracked(r, lesson("l1", [quiz("q1")]));
    await answer(r, first.id, "q1", "wrong", at(1));
    await answer(r, first.id, "q1", "right", at(2));
    const [item] = await due(r, ["q1"], at(2 + DELAY));
    const l2 = lesson("l2", [quiz("q9")]);
    const shown = withReview(l2, [quiz("q1")]);
    const reason = "It's back so you can answer it from memory.";
    const opened = await r.openLessonEncounter({
      course: "c", lesson: "l2", lessonPage: l2, page: shown, now: at(2 + DELAY), aidTracking: 1,
      notes: [{ blockId: "q1", rule: item!.rule, reason, evidence: item!.evidence }],
    });
    expect(opened.encounter.resumed).toBe(false);
    expect(opened.page).toEqual(shown);
    const notes = await r.encounterDecisionNotes(opened.encounter.id);
    expect(notes).toEqual([{
      id: expect.any(String), seq: expect.any(Number), choice: { course: "c", lesson: "l2", blockId: "q1" },
      encounterId: opened.encounter.id, rule: "due-review/wrong-first-try", reason, evidence: item!.evidence, at: at(2 + DELAY),
    }]);
    // The review block is the encounter's: it is answered there, and reads back with it.
    expect(await answer(r, opened.encounter.id, "q1", "right", at(3 + DELAY))).toEqual({ status: "stored", correct: true, firstTry: true });
    expect(await r.encounterAnswers(opened.encounter.id)).toEqual([{ blockId: "q1", choiceId: "right", correct: true }]);
  });

  dr("a reload inside the resume window shows the same review, whatever the selector says now", async (r) => {
    const first = await tracked(r, lesson("l1", [quiz("q1")]));
    await answer(r, first.id, "q1", "wrong", at(1));
    const [item] = await due(r, ["q1"], at(1 + DELAY));
    const l2 = lesson("l2", [quiz("q9")]);
    const shown = withReview(l2, [quiz("q1")]);
    const open = (page: Block, notes: { blockId: string; rule: string; reason: string; evidence: number[] }[], now: string, lessonPage = l2) =>
      r.openLessonEncounter({ course: "c", lesson: "l2", lessonPage, page, now, aidTracking: 1, notes });
    const opened = await open(shown, [{ blockId: "q1", rule: item!.rule, reason: "Back.", evidence: item!.evidence }], at(1 + DELAY));
    await answer(r, opened.encounter.id, "q1", "right", at(2 + DELAY));
    // Now nothing is due (q1 was just seen), so the page asked for has no review; the encounter still resumes, as it was.
    const reload = await open(l2, [], at(3 + DELAY));
    expect(reload).toEqual({ encounter: { ...opened.encounter, resumed: true }, page: shown });
    expect(await r.encounterDecisionNotes(opened.encounter.id)).toHaveLength(1);
    // So does a reload offered other review: its notes are not stored.
    const other = await open(withReview(l2, [quiz("q8")]), [{ blockId: "q8", rule: item!.rule, reason: "Other.", evidence: item!.evidence }], at(4 + DELAY));
    expect(other).toEqual({ encounter: { ...opened.encounter, resumed: true }, page: shown });
    expect(await r.encounterDecisionNotes(opened.encounter.id)).toHaveLength(1);
    // An edited lesson is a new encounter, and so is a reload past the window.
    const edited = lesson("l2", [quiz("q9")], "edited");
    expect((await open(edited, [], at(5 + DELAY), edited)).encounter.resumed).toBe(false);
    const past = await open(l2, [], at(5 + DELAY + 2 * RESUME_WINDOW_MS));
    expect(past.encounter.resumed).toBe(false);
    expect(past.page).toEqual(l2);
  });

  dr("an encounter opened without review resumes when the lesson is opened with review machinery and nothing due", async (r) => {
    const page = lesson("l1", [quiz("q1")]);
    const e = await tracked(r, page);
    const opened = await r.openLessonEncounter({ course: "c", lesson: "l1", lessonPage: page, page, now: at(1), aidTracking: 1, notes: [] });
    expect(opened).toEqual({ encounter: { ...e, resumed: true }, page });
    // The capture version still decides, as for any encounter.
    expect((await r.openLessonEncounter({ course: "c", lesson: "l1", lessonPage: page, page, now: at(2), aidTracking: null, notes: [] })).encounter.resumed).toBe(false);
  });

  dr("opening with a note the record refuses opens nothing: the encounter and its notes are one write", async (r) => {
    const l2 = lesson("l2", [quiz("q9")]);
    const shown = withReview(l2, [quiz("q1")]);
    await expect(r.openLessonEncounter({
      course: "c", lesson: "l2", lessonPage: l2, page: shown, now: at(1), aidTracking: 1,
      notes: [{ blockId: "q1", rule: "due-review/wrong-first-try", reason: "Back.", evidence: [1_000_000_000] }],
    })).rejects.toThrow();
    // Nothing was opened, so the next open is a new encounter, not a resumed one.
    expect((await r.openLessonEncounter({ course: "c", lesson: "l2", lessonPage: l2, page: l2, now: at(2), aidTracking: 1, notes: [] })).encounter.resumed).toBe(false);
    expect(await r.lastStudied()).toEqual({ course: "c", lesson: "l2", at: at(2) });
  });

  // ---- Mastery (RFC 5 §4.1, §4.2; flyingrobots/school#217) ------------------------------------
  // The measure reads each quiz's episodes as due review does, by seq, and returns its stability
  // and its strength at the time asked. Oracle: RFC 5 Table 4.1, Table 4.2 and the worked example
  // of §4.3; a strength is compared to 4 decimal places, a stability exactly while it is a whole
  // number of milliseconds.

  /** A case of the mastery measure. */
  const mm = (title: string, fn: (r: LearningRecord) => Promise<void>) =>
    test(`${name}: mastery: ${title}`, async () => fn(await make()));
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const measure = (r: LearningRecord, blocks: string[], now: string) => r.mastery({ course: "c", blocks, now, delayMs: DELAY });
  const held = async (r: LearningRecord, now: string, blockId = "q1") => {
    const [m] = await measure(r, [blockId], now);
    if (m === undefined) throw new Error(`no row for ${blockId}`);
    return m;
  };
  type FirstTry = "clean" | "aided" | "unknown" | "wrong";
  /**
   * One episode: a new encounter of a lesson of its own holding `blockId`, answered once at `t`:
   * right with nothing shown, right after a hint, right while aid is not tracked, or wrong.
   * Returns the first try's seq.
   */
  const episode = async (r: LearningRecord, kind: FirstTry, t: number, blockId = "q1", course = "c") => {
    const id = `l-${uuid()}`;
    const e = await r.openEncounter({ course, lesson: id, page: lesson(id, [quiz(blockId)]), now: at(t), aidTracking: kind === "unknown" ? null : 1 });
    if (kind === "aided") await r.recordExposure(exposure(e.id, blockId, "hint"), at(t));
    await answer(r, e.id, blockId, kind === "wrong" ? "wrong" : "right", at(t));
    const [first] = await rowsOf(r, e.id, "answer", blockId);
    return { encounterId: e.id, first: first! };
  };

  mm("a clean answer has strength 1 at once, 0.7071 twelve hours later and 0.5 at one day, with a stability of one day", async (r) => {
    const { first } = await episode(r, "clean", 0);
    expect(await held(r, at(0))).toEqual({ blockId: "q1", strength: 1, stabilityMs: DAY, refreshedAt: at(0), settled: true, evidence: [first] });
    expect((await held(r, at(12 * HOUR))).strength).toBeCloseTo(Math.SQRT1_2, 4); // 0.5^(1/2)
    expect((await held(r, at(DAY))).strength).toBeCloseTo(0.5, 4);
    expect((await held(r, at(2 * DAY))).strength).toBeCloseTo(0.25, 4);
  });

  mm("RFC 5 Table 4.3: answered cleanly each time it fades, stability grows by 2.5 at each answer", async (r) => {
    const first = await episode(r, "clean", 0);
    expect(await held(r, at(0))).toMatchObject({ strength: 1, stabilityMs: DAY });
    const later = [[1, 2.5], [3.5, 6.25], [9.75, 15.625], [25.375, 39.0625], [64.4375, 97.65625]] as const;
    const firsts = [first.first];
    for (const [day, stability] of later) {
      expect({ day, strength: (await held(r, at(day * DAY))).strength! }).toEqual({ day, strength: expect.closeTo(0.5, 4) }); // just before: one stability has passed
      firsts.push((await episode(r, "clean", day * DAY)).first);
      expect({ day, ...await held(r, at(day * DAY)) }).toMatchObject({ day, strength: 1, stabilityMs: stability * DAY, refreshedAt: at(day * DAY), settled: true });
    }
    expect((await held(r, at(64.4375 * DAY))).evidence).toEqual(firsts);
  });

  mm("a clean answer exactly the delay after the last answer grows stability; one 1 ms sooner only restarts the clock", async (r) => {
    const q1 = await episode(r, "clean", 0, "q1");
    const q2 = await episode(r, "clean", 0, "q2");
    const q2Soon = await episode(r, "clean", DELAY - 1, "q2");
    const q1Spaced = await episode(r, "clean", DELAY, "q1");
    expect(await measure(r, ["q1", "q2"], at(DELAY))).toEqual([
      { blockId: "q1", strength: 1, stabilityMs: 2.5 * DAY, refreshedAt: at(DELAY), settled: true, evidence: [q1.first, q1Spaced.first] },
      { blockId: "q2", strength: expect.closeTo(0.5 ** (1 / DAY), 4), stabilityMs: DAY, refreshedAt: at(DELAY - 1), settled: true, evidence: [q2.first, q2Soon.first] },
    ]);
  });

  mm("unknown aid restarts the clock and keeps stability, though it comes after the delay, and the quiz has not settled", async (r) => {
    const a = await episode(r, "clean", 0);
    const b = await episode(r, "clean", DAY);
    const unknown = await episode(r, "unknown", 2 * DAY);
    expect(await held(r, at(2 * DAY))).toEqual({
      blockId: "q1", strength: 1, stabilityMs: 2.5 * DAY, refreshedAt: at(2 * DAY), settled: false, evidence: [a.first, b.first, unknown.first],
    });
    expect((await held(r, at(4.5 * DAY))).strength).toBeCloseTo(0.5, 4);
  });

  mm("an aided first try restarts the clock and returns stability to one day; a clean answer a delay later grows it again", async (r) => {
    await episode(r, "clean", 0);
    await episode(r, "clean", DAY);
    const aided = await episode(r, "aided", 2 * DAY);
    expect(await held(r, at(2 * DAY))).toEqual({ blockId: "q1", strength: 1, stabilityMs: DAY, refreshedAt: at(2 * DAY), settled: false, evidence: [aided.first] });
    expect((await held(r, at(3 * DAY))).strength).toBeCloseTo(0.5, 4);
    const clean = await episode(r, "clean", 3 * DAY);
    expect(await held(r, at(3 * DAY))).toEqual({
      blockId: "q1", strength: 1, stabilityMs: 2.5 * DAY, refreshedAt: at(3 * DAY), settled: true, evidence: [aided.first, clean.first],
    });
  });

  mm("a wrong first try gives strength 0 until the next right first try, though it was put right in the same encounter", async (r) => {
    await episode(r, "clean", 0);
    const before = await episode(r, "clean", DAY);
    const wrong = await episode(r, "wrong", 2 * DAY);
    await answer(r, wrong.encounterId, "q1", "right", at(2 * DAY + 1000)); // after the first try: the episode's, it moves nothing
    const zero = { blockId: "q1", strength: 0, stabilityMs: DAY, refreshedAt: at(DAY), settled: false, evidence: [before.first, wrong.first] };
    expect(await held(r, at(2 * DAY + HOUR))).toEqual(zero);
    expect(await held(r, at(30 * DAY))).toEqual(zero);
    const next = await episode(r, "clean", 2 * DAY + 2 * HOUR); // within the delay: the clock restarts, stability stays one day
    expect(await held(r, at(2 * DAY + 2 * HOUR))).toEqual({
      blockId: "q1", strength: 1, stabilityMs: DAY, refreshedAt: at(2 * DAY + 2 * HOUR), settled: false, evidence: [wrong.first, next.first],
    });
  });

  mm("a quiz never answered is null; rows follow the order asked, each block once; another course's answers are not this one's", async (r) => {
    const q1 = await episode(r, "clean", 0, "q1");
    await episode(r, "clean", 0, "q2", "other");
    const never = (blockId: string) => ({ blockId, strength: null, stabilityMs: null, refreshedAt: null, settled: false, evidence: [] });
    expect(await measure(r, ["q2", "q1", "q2", "q3"], at(DAY))).toEqual([
      never("q2"),
      { blockId: "q1", strength: expect.closeTo(0.5, 4), stabilityMs: DAY, refreshedAt: at(0), settled: true, evidence: [q1.first] },
      never("q3"),
    ]);
    expect(await measure(r, [], at(DAY))).toEqual([]);
  });

  mm("order is the record's, by seq, never by `at`: the latest first try, the refresh and the delay are read in seq order", async (r) => {
    // Sent in this order, with clocks that disagree: an outbox flush, or a clock stepped back.
    await episode(r, "clean", DAY, "q1");
    const q1Latest = await episode(r, "clean", 0, "q1"); // latest by seq, earliest by `at`: not a delay after the one before
    await episode(r, "wrong", DAY, "q2");
    await episode(r, "clean", 0, "q2"); // right after the wrong one by seq: strength comes back
    await episode(r, "clean", DAY, "q3");
    await episode(r, "wrong", 0, "q3"); // wrong after the right one by seq: strength 0
    const [q1, q2, q3] = await measure(r, ["q1", "q2", "q3"], at(12 * HOUR));
    expect(q1).toMatchObject({ strength: expect.closeTo(Math.SQRT1_2, 4), stabilityMs: DAY, refreshedAt: at(0) });
    expect(q1!.evidence.at(-1)).toBe(q1Latest.first);
    expect(q2).toMatchObject({ strength: expect.closeTo(Math.SQRT1_2, 4), stabilityMs: DAY, refreshedAt: at(0), settled: false });
    expect(q3).toMatchObject({ strength: 0, stabilityMs: DAY, refreshedAt: at(DAY), settled: false });
  });

  mm("strength is 1 at a time before the refresh, and reaches 0, not an error, ten years after it", async (r) => {
    await episode(r, "clean", DAY);
    expect((await held(r, at(0))).strength).toBe(1);
    expect((await held(r, at(3650 * DAY))).strength).toBeCloseTo(0, 10);
  });

  // Generated: a year of random first tries for one quiz, each measured at a random time after it,
  // against a model that moves step by step as RFC 5 Table 4.2 says. Oracle: Table 4.2; the record
  // computes Table 4.1's closed form, which RFC 5 states is the same measure.
  mm("under a year of random first tries, strength stays in [0, 1], stability never falls on a spaced clean answer, and both follow Table 4.2", async (r) => {
    const seed = FUZZ_SEED;
    const random = seeded(seed);
    const replay = `replay: SCHOOL_TEST_SEED=${seed} bun test server/adapters/postgres.test.ts -t "mastery: under a year"`;
    const kinds = ["clean", "clean", "clean", "aided", "unknown", "wrong"] as const;
    const seen = { spaced: 0, soon: 0, aided: 0, unknown: 0, wrong: 0 };
    let model = { stabilityMs: DAY, refreshedAt: 0, zero: false };
    let last: number | null = null;
    let previous: number | null = null;
    for (let t = 0, step = 0; t < 365 * DAY; t += Math.floor(random() * 3 * DAY), step++) {
      const kind = kinds[Math.floor(random() * kinds.length)]!;
      const spaced = last === null || t - last >= DELAY;
      // Table 4.2, one row per kind of first try; the first answer starts at one day.
      if (last === null) model = { stabilityMs: DAY, refreshedAt: t, zero: kind === "wrong" };
      else if (kind === "wrong") model = { ...model, stabilityMs: DAY, zero: true };
      else if (kind === "aided") model = { stabilityMs: DAY, refreshedAt: t, zero: false };
      else if (kind === "unknown" || !spaced) model = { ...model, refreshedAt: t, zero: false };
      else model = { stabilityMs: model.stabilityMs * 2.5, refreshedAt: t, zero: false };
      seen[kind === "clean" ? (spaced ? "spaced" : "soon") : kind]++;
      await episode(r, kind, t);
      last = t;
      const probe = t + Math.floor(random() * 2 * DAY);
      const m = await held(r, at(probe));
      const strength = model.zero ? 0 : 0.5 ** ((probe - model.refreshedAt) / model.stabilityMs);
      expect({ step, kind, inRange: m.strength! >= 0 && m.strength! <= 1 }, replay).toEqual({ step, kind, inRange: true });
      expect({ step, kind, strength: m.strength }, replay).toEqual({ step, kind, strength: expect.closeTo(strength, 4) });
      expect({ step, kind, stability: m.stabilityMs! / model.stabilityMs }, replay).toEqual({ step, kind, stability: expect.closeTo(1, 12) });
      if (kind === "clean" && spaced && previous !== null) expect({ step, grew: m.stabilityMs! >= previous }, replay).toEqual({ step, grew: true });
      previous = m.stabilityMs;
    }
    // Witnesses: the fixed seed reaches every kind of first try.
    for (const [kind, n] of Object.entries(seen)) expect(`${kind}: ${n > 0}`, replay).toBe(`${kind}: true`);
  });

  // ---- Installed courses (RFC 7 §7; flyingrobots/school#232) ----------------------------------

  t("installs: nothing is installed at first", async (r) => {
    expect(await r.installedCourses()).toEqual([]);
  });

  t("installs: an install from a repository is recorded and read back as its name's current install, untrusted", async (r) => {
    const i = gitInstall();
    expect(await r.installCourse(i, at(0))).toEqual({ status: "installed" });
    expect(await r.installedCourses()).toEqual([current(i, at(0))]);
  });

  t("installs: an install from a bundle keeps the bundle's SHA-256 and no URL", async (r) => {
    const i = bundleInstall();
    expect(await r.installCourse(i, at(0))).toEqual({ status: "installed" });
    expect(await r.installedCourses()).toEqual([current(i, at(0))]);
  });

  t("installs: a resent install is a duplicate, and its id with another install is a conflict; the first stands", async (r) => {
    const i = gitInstall();
    await r.installCourse(i, at(0));
    expect(await r.installCourse(i, at(1000))).toEqual({ status: "duplicate" });
    expect(await r.installCourse({ ...i, commit: hex(40, "f") }, at(2000))).toEqual({ status: "conflict" });
    expect(await r.installCourse({ ...i, course: "other" }, at(3000))).toEqual({ status: "conflict" });
    expect(await r.installedCourses()).toEqual([current(i, at(0))]);
  });

  t("installs: a later install under the same name is an update and becomes current; the earlier is not listed", async (r) => {
    const first = gitInstall();
    const second = gitInstall({ commit: hex(40, "b") });
    await r.installCourse(first, at(0));
    expect(await r.installCourse(second, at(1000))).toEqual({ status: "updated" });
    expect(await r.installedCourses()).toEqual([current(second, at(1000))]);
  });

  t("installs: each name has its own current install, listed by name", async (r) => {
    const bells = gitInstall();
    const aion = bundleInstall({ course: "aion", title: "Aion" });
    await r.installCourse(bells, at(0));
    await r.installCourse(aion, at(1000));
    expect(await r.installedCourses()).toEqual([current(aion, at(1000)), current(bells, at(0))]);
  });

  t("installs: a trust choice is kept per install, and the latest wins", async (r) => {
    const i = gitInstall();
    await r.installCourse(i, at(0));
    expect(await r.chooseCourseTrust(i.id, true, at(1000))).toEqual({ status: "stored" });
    expect(await r.installedCourses()).toEqual([current(i, at(0), true)]);
    expect(await r.chooseCourseTrust(i.id, false, at(2000))).toEqual({ status: "stored" });
    expect(await r.installedCourses()).toEqual([current(i, at(0), false)]);
  });

  t("installs: a trust choice for no install is rejected", async (r) => {
    expect(await r.chooseCourseTrust(uuid(), true, at(0))).toEqual({ status: "rejected" });
  });

  t("installs: an update starts untrusted, whatever the learner chose for the install it replaces", async (r) => {
    const first = gitInstall();
    const second = gitInstall({ commit: hex(40, "b") });
    await r.installCourse(first, at(0));
    await r.chooseCourseTrust(first.id, true, at(1000));
    await r.installCourse(second, at(2000));
    expect(await r.installedCourses()).toEqual([current(second, at(2000))]);
  });

  t("installs: a removal ends the name's current install, and leaves its progress as it was", async (r) => {
    const i = gitInstall();
    await r.installCourse(i, at(0));
    const e = await r.openEncounter({ course: "bells", lesson: "l1", aidTracking: null, page: lesson("l1", [quiz("q1")]), now: at(1000) });
    await r.submit({ submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(2000));
    expect(await r.removeInstalledCourse("bells", at(3000))).toEqual({ status: "removed" });
    expect(await r.installedCourses()).toEqual([]);
    expect(await r.lessonProgress("bells")).toEqual({ l1: ["q1"] });
  });

  t("installs: removing a name with no current install is refused, never installed or already removed", async (r) => {
    expect(await r.removeInstalledCourse("bells", at(0))).toEqual({ status: "not-installed" });
    await r.installCourse(gitInstall(), at(1000));
    await r.removeInstalledCourse("bells", at(2000));
    expect(await r.removeInstalledCourse("bells", at(3000))).toEqual({ status: "not-installed" });
  });

  t("installs: a name installed, removed and installed again is current with its new install, untrusted", async (r) => {
    const first = gitInstall();
    const again = gitInstall({ commit: hex(40, "b") });
    await r.installCourse(first, at(0));
    await r.chooseCourseTrust(first.id, true, at(1000));
    await r.removeInstalledCourse("bells", at(2000));
    expect(await r.installCourse(again, at(3000))).toEqual({ status: "installed" });
    expect(await r.installedCourses()).toEqual([current(again, at(3000))]);
  });

  // The model trims a title; a record that kept it padded would hold a row the model then refuses to read.
  t("installs: a padded title is stored trimmed, and the install still lists and resends as a duplicate", async (r) => {
    for (const [k, padded] of ["  Bells  ", "\tBells\n", "\u00a0Bells\u00a0"].entries()) {
      const course = `padded-${k}`;
      const i = gitInstall({ course, title: padded });
      expect(await r.installCourse(i, at(0))).toEqual({ status: "installed" });
      expect(await r.installCourse(i, at(1000))).toEqual({ status: "duplicate" });
      expect((await r.installedCourses()).find((x) => x.course === course)).toEqual(current({ ...i, title: "Bells" }, at(0)));
    }
  });

  t("installs: a malformed install is refused and stores nothing", async (r) => {
    for (const bad of [
      gitInstall({ course: "Not A Name" }), gitInstall({ course: "api" }), gitInstall({ url: "http://example.com/c.git" }),
      gitInstall({ commit: hex(39, "a") }), gitInstall({ commit: hex(40, "A") }), gitInstall({ contentSha256: hex(63, "c") }),
      gitInstall({ title: "" }), gitInstall({ title: "\t" }), gitInstall({ title: "\u00a0" }), gitInstall({ title: " \n " }), gitInstall({ format: 0 }), bundleInstall({ bundleSha256: hex(64, "g") }),
      { ...gitInstall(), bundleSha256: hex(64, "b") } as unknown as CourseInstall,
      { ...bundleInstall(), url: "https://example.com/c.git" } as unknown as CourseInstall,
      { ...gitInstall(), source: "authored" } as unknown as CourseInstall,
    ]) await expect(r.installCourse(bad, at(0)), JSON.stringify(bad)).rejects.toThrow();
    expect(await r.installedCourses()).toEqual([]);
  });

  // Generated: random install, update, remove and trust sequences over three names, against a model
  // that holds each name's current install. Oracle: RFC 7 §7, a name's current install is its latest
  // install with no later removal, trusted by its own latest trust choice.
  t("installs: under any sequence of installs, removals and trust choices, each name has at most one current install, the model's", async (r) => {
    const seed = FUZZ_SEED;
    const random = seeded(seed);
    const replay = `replay: SCHOOL_TEST_SEED=${seed} bun test server/adapters/postgres.test.ts -t "installs: under any sequence"`;
    const names = ["bells", "aion", "c-3"] as const;
    const model = new Map<string, InstalledCourse>();
    const ids: string[] = [];
    const kinds = { install: 0, update: 0, remove: 0, refused: 0, trust: 0 };
    for (let step = 0; step < 60; step++) {
      const name = names[Math.floor(random() * names.length)]!;
      const now = at(step * 1000);
      const roll = random();
      if (roll < 0.45) {
        const i = random() < 0.5
          ? gitInstall({ course: name, commit: Math.floor(random() * 2 ** 32).toString(16).padStart(40, "0") })
          : bundleInstall({ course: name, bundleSha256: Math.floor(random() * 2 ** 32).toString(16).padStart(64, "0") });
        const expected = model.has(name) ? "updated" : "installed";
        kinds[expected === "updated" ? "update" : "install"]++;
        expect({ step, ...(await r.installCourse(i, now)) }, replay).toEqual({ step, status: expected });
        model.set(name, current(i, now));
        ids.push(i.id);
      } else if (roll < 0.75) {
        const expected = model.has(name) ? "removed" : "not-installed";
        kinds[expected === "removed" ? "remove" : "refused"]++;
        expect({ step, ...(await r.removeInstalledCourse(name, now)) }, replay).toEqual({ step, status: expected });
        model.delete(name);
      } else if (ids.length > 0) {
        const id = ids[Math.floor(random() * ids.length)]!;
        const trusted = random() < 0.5;
        kinds.trust++;
        expect({ step, ...(await r.chooseCourseTrust(id, trusted, now)) }, replay).toEqual({ step, status: "stored" });
        for (const [n, c] of model) if (c.id === id) model.set(n, { ...c, trusted });
      }
      const listed = await r.installedCourses();
      expect(new Set(listed.map((c) => c.course)).size, replay).toBe(listed.length);
      expect({ step, listed }, replay).toEqual({ step, listed: [...model.values()].sort((a, b) => (a.course < b.course ? -1 : 1)) });
    }
    // Witnesses: the fixed seed reaches every kind of step.
    for (const [kind, n] of Object.entries(kinds)) expect(`${kind}: ${n > 0}`, replay).toBe(`${kind}: true`);
  });
}
