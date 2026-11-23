// One learner's history, told as a story and replayed through the LearningRecord port
// (flyingrobots/school#27). The contract suite proves each rule on its own; this replays them
// together, and checks two things at every step: the facts as the port reports them, and what
// the lesson page would show for them. It speaks only through the port, so every adapter that
// registers it (Postgres on PGlite, and a real Postgres through Bun.SQL in CI) must tell the
// same story. The story grows as the record does.
import { expect, test } from "bun:test";
import type { Aid, Block, DueItem, ExplainBlock, ExplanationState, ExposureKind, GradingRecord, Recorded } from "../core/model.ts";
import type { Grader, LearningRecord } from "../core/ports.ts";
import { REVIEW_DELAY_MS, REVIEW_LIMIT, createSchool } from "../core/school.ts";

// The lesson: two quizzes and one explain block.
const closest: Block = {
  type: "quiz", id: "closest", q: "Which planet is closest to the sun?", why: "Mercury orbits at about 0.39 AU.",
  choices: [{ id: "venus", text: "Venus", correct: false }, { id: "mercury", text: "Mercury", correct: true }],
};
const moons: Block = {
  type: "quiz", id: "moons", q: "Which planet has no moons?", why: "Venus has none; Mars has two.",
  choices: [{ id: "mars", text: "Mars", correct: false }, { id: "venus", text: "Venus", correct: true }],
};
const seasons: ExplainBlock = {
  type: "explain", id: "seasons", prompt: "Why does Earth have seasons?",
  model: "Earth's axis is tilted, so each hemisphere takes the sun more directly for half the year.",
  sources: [{ id: "tilt", title: "Axial tilt", text: "Earth's axis is tilted about 23.4 degrees to its orbit." }],
};
const page: Block = { type: "page", id: "orbits", title: "Orbits", subtitle: "", children: [closest, moons, seasons] };
// The next lesson, where the review appears.
const rings: Block = {
  type: "quiz", id: "rings", q: "Which planet has the brightest rings?", why: "Saturn's rings are mostly ice.",
  choices: [{ id: "saturn", text: "Saturn", correct: true }, { id: "jupiter", text: "Jupiter", correct: false }],
};
const planets: Block = { type: "page", id: "planets", title: "Planets", subtitle: "", children: [rings] };
/** The review never grades anything. */
const noGrader: Grader = { adapter: "none", model: "", rubricVersion: "-", promptVersion: "-", grade: async () => { throw new Error("no grading in this story"); } };
const COURSE = "astronomy";

const T0 = Date.parse("2026-11-21T09:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const DAY = 24 * 3600;

const grading = (submissionId: string): Omit<GradingRecord, "status" | "findings" | "error"> => ({
  submissionId, rubricVersion: "rubric-v1", promptVersion: "prompt-v1", adapter: "test", model: "m", sources: seasons.sources, raw: null,
});

/**
 * What the lesson page shows for each block, from what a reload hands it. These are the page's
 * own rules, restated: a quiz shows its latest recorded answer, settled once that answer is
 * right (web/src/components/quiz.tsx, `initial`); an explain block shows its latest explanation,
 * saved, graded or not graded by its latest grading (web/src/components/explain.tsx,
 * `explainStateOf`). The labels are the badges the page puts on each.
 */
export function pageShows(answers: readonly Recorded[], explanations: readonly ExplanationState[]): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const a of answers) shown[a.blockId] = a.correct ? `Answered (${a.choiceId})` : `Not quite (${a.choiceId})`;
  for (const x of explanations) {
    const g = x.grading;
    shown[x.blockId] = g === null ? `Saved: ${x.text}` : g.status === "succeeded" ? `Graded: ${g.findings.summary}` : `Not graded: ${g.error}`;
  }
  return shown;
}

/**
 * How a submission's aid reads, in RFC 2's words (§3). The lesson page does not show aid yet
 * (flyingrobots/school#51); these are the names any view of it must use. "No recorded aid" is the
 * most School can know, and is never called "unaided".
 */
export function aidReads(aid: Aid | null): string {
  if (aid === null) throw new Error("aid of a submission the record does not hold");
  return { aided: "Aided", "no-recorded-aid": "No recorded aid", unknown: "Unknown aid" }[aid];
}

/** Register the story for one adapter. `make` returns a fresh, empty record. */
export function learnerHistory(name: string, make: () => Promise<LearningRecord>): void {
  test(`${name}: learner history replays, and each step reads as it happened`, async () => {
    const r = await make();
    const aidOf = async (submissionId: string) => aidReads(await r.aid(submissionId));
    const reload = async (e: { id: string }) => pageShows(await r.encounterAnswers(e.id), await r.encounterExplanations(e.id));
    /** The page reports help it has shown, and the record stores it. */
    const shown = async (encounterId: string, blockId: string, kind: ExposureKind, now: string) =>
      expect(await r.recordExposure({ exposureId: crypto.randomUUID(), encounterId, blockId, kind }, now))
        .toEqual({ status: "stored" });

    // Day one, 20 November, 09:00. The learner opens "Orbits" on an old client that records no
    // help it shows, so the encounter is opened with aid tracking off.
    const old = await r.openEncounter({ course: COURSE, lesson: "orbits", page, now: at(-DAY), aidTracking: null });
    expect(old.resumed).toBe(false);

    // 09:01. They answer the closest planet right, first try. Whether they had help, School cannot
    // say: unknown aid, on every adapter.
    const early = crypto.randomUUID();
    expect(await r.submit({ submissionId: early, encounterId: old.id, blockId: "closest", choiceId: "mercury", ms: 3000 }, at(-DAY + 60)))
      .toEqual({ status: "stored", correct: true, firstTry: true });
    expect(await aidOf(early)).toBe("Unknown aid");
    expect(await reload(old)).toEqual({ closest: "Answered (mercury)" });

    // Day two, 21 November, 09:00. A day later, well past the resume window, they come back on a
    // client that records the help it shows: a new, tracked encounter, and nothing answered in it.
    const e = await r.openEncounter({ course: COURSE, lesson: "orbits", page, now: at(0), aidTracking: 1 });
    expect(e.resumed).toBe(false);
    expect(e.id).not.toBe(old.id);
    expect(await reload(e)).toEqual({});

    // 09:01. This time they guess Venus for the closest planet. Wrong, and their first try in this
    // encounter. Nothing was shown for the quiz before it: no recorded aid.
    const venus = crypto.randomUUID();
    expect(await r.submit({ submissionId: venus, encounterId: e.id, blockId: "closest", choiceId: "venus", ms: 4000 }, at(60)))
      .toEqual({ status: "stored", correct: false, firstTry: true });
    expect(await aidOf(venus)).toBe(aidReads("no-recorded-aid"));
    expect(await reload(e)).toEqual({ closest: "Not quite (venus)" });

    // The page tells them "Not quite": that is feedback, and the page reports it as shown.
    await shown(e.id, "closest", "feedback", at(61));

    // 09:02. They try Mercury. Right, but no longer a first try, and aided: it came after feedback.
    const mercury = crypto.randomUUID();
    expect(await r.submit({ submissionId: mercury, encounterId: e.id, blockId: "closest", choiceId: "mercury", ms: 3000 }, at(120)))
      .toEqual({ status: "stored", correct: true, firstTry: false });
    expect(await aidOf(mercury)).toBe(aidReads("aided"));
    expect(await aidOf(venus)).toBe(aidReads("no-recorded-aid")); // later help never reclassifies earlier work
    expect(await reload(e)).toEqual({ closest: "Answered (mercury)" });

    // 09:05. The connection drops. They answer the moons quiz twice, Mars then Venus, and both sit
    // in the outbox with no verdict shown. 09:10: it reconnects and flushes them in one go, so both
    // arrive with the same time. Order still comes out as they were sent: Mars is the first try,
    // Venus is not, and neither had help.
    const mars = crypto.randomUUID();
    const venusMoons = { submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "moons", choiceId: "venus", ms: 2000 };
    expect(await r.submit({ submissionId: mars, encounterId: e.id, blockId: "moons", choiceId: "mars", ms: 5000 }, at(600)))
      .toEqual({ status: "stored", correct: false, firstTry: true });
    expect(await r.submit(venusMoons, at(600))).toEqual({ status: "stored", correct: true, firstTry: false });
    expect(await aidOf(mars)).toBe(aidReads("no-recorded-aid"));
    expect(await aidOf(venusMoons.submissionId)).toBe(aidReads("no-recorded-aid"));

    // 09:10. The outbox never heard back about Venus, so it sends the same submission again. The
    // record recognises the id, stores nothing, and gives the same verdict it gave the first time.
    expect(await r.submit(venusMoons, at(601))).toEqual({ status: "duplicate", correct: true, firstTry: false });
    expect(await r.encounterAnswers(e.id)).toEqual([
      { blockId: "closest", choiceId: "venus", correct: false },
      { blockId: "closest", choiceId: "mercury", correct: true },
      { blockId: "moons", choiceId: "mars", correct: false },
      { blockId: "moons", choiceId: "venus", correct: true },
    ]);
    expect(await reload(e)).toEqual({ closest: "Answered (mercury)", moons: "Answered (venus)" });

    // 09:15. They explain the seasons. It is saved before anything grades it, with no recorded aid.
    const draft = { submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "seasons", text: "Earth is closer in summer.", ms: 60_000 };
    expect(await r.saveExplanation(draft, at(900))).toEqual({ status: "stored" });
    expect(await aidOf(draft.submissionId)).toBe(aidReads("no-recorded-aid"));
    expect((await reload(e)).seasons).toBe("Saved: Earth is closer in summer.");

    // Once it is saved, the page reveals the model answer beside it, and reports the reveal.
    await shown(e.id, "seasons", "model-answer", at(901));

    // 09:20. Having read the model answer, they write a better explanation. The revision is a new
    // submission and it is aided; the draft is kept, still with no recorded aid, and the page shows
    // the revision.
    const revised = { submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "seasons", text: "The tilt of Earth's axis.", ms: 30_000 };
    expect(await r.saveExplanation(revised, at(1200))).toEqual({ status: "stored" });
    expect(await aidOf(revised.submissionId)).toBe(aidReads("aided"));
    expect(await aidOf(draft.submissionId)).toBe(aidReads("no-recorded-aid"));
    expect((await r.explanation(draft.submissionId))?.state).toEqual({
      submissionId: draft.submissionId, blockId: "seasons", text: draft.text, at: at(900), grading: null,
    });
    expect((await reload(e)).seasons).toBe("Saved: The tilt of Earth's axis.");

    // 09:21. They ask for a grading, and the bridge is down. The attempt is stored as a failure,
    // not as a verdict on the explanation, and the page offers a retry.
    const failed = await r.recordGrading({ ...grading(revised.submissionId), status: "failed", findings: null, error: "the bridge could not be reached" }, at(1260));
    expect(failed).toMatchObject({ status: "failed", error: "the bridge could not be reached", supersedes: null, at: at(1260) });
    expect((await reload(e)).seasons).toBe("Not graded: the bridge could not be reached");

    // 09:25. The retry succeeds. It supersedes the failure, which is still there to be traced.
    const findings = {
      insufficient_evidence: false, summary: "Names the tilt; could say why it matters.", contradictions: [],
      fidelity: { verdict: "meets" as const, note: "" }, completeness: { verdict: "partly" as const, note: "" }, accessibility: { verdict: "meets" as const, note: "" },
    };
    const graded = await r.recordGrading({ ...grading(revised.submissionId), status: "succeeded", findings, error: null }, at(1500));
    expect(graded).toMatchObject({ status: "succeeded", supersedes: failed.id, at: at(1500) });
    expect((await r.explanation(revised.submissionId))?.state.grading).toEqual(graded);

    // 11:00. They come back and reload. Inside the resume window, so it is the same encounter, and
    // the page shows everything they did, each block as it ended.
    const back = await r.openEncounter({ course: COURSE, lesson: "orbits", page, now: at(2 * 3600), aidTracking: 1 });
    expect(back).toEqual({ id: e.id, hash: e.hash, resumed: true });
    expect(await r.encounterExplanations(back.id)).toEqual([
      { submissionId: revised.submissionId, blockId: "seasons", text: revised.text, at: at(1200), grading: graded },
    ]);
    expect(await reload(back)).toEqual({
      closest: "Answered (mercury)",
      moons: "Answered (venus)",
      seasons: "Graded: Names the tilt; could say why it matters.",
    });
    // Day one's encounter is untouched, and its answer still has unknown aid.
    expect(await reload(old)).toEqual({ closest: "Answered (mercury)" });
    expect(await aidOf(early)).toBe("Unknown aid");
    expect(await r.lessonProgress(COURSE)).toEqual({ orbits: ["closest", "moons"] });

    // Delayed review (RFC 2 §5, flyingrobots/school#32), from the record's order and its exposures.
    const rows = await r.encounterEvidence(e.id);
    const seq = (kind: string, blockId: string, nth = 0) => rows.filter((x) => x.kind === kind && x.blockId === blockId)[nth]!.seq;
    const asked = { course: COURSE, blocks: ["closest", "moons", "seasons", "rings"], delayMs: REVIEW_DELAY_MS, limit: REVIEW_LIMIT };

    // Still 11:00 on day two. Nothing is due: both quizzes were last answered two hours ago.
    expect(await r.dueReview({ ...asked, now: at(2 * 3600) })).toEqual([]);

    // Day three, 22 November, 09:00. Both are due, each because its first answer yesterday was
    // wrong. The closest planet's note names the wrong answer, the feedback shown after it and the
    // correction; the moons' names Mars and the second try. Day one's right answer, whose aid is
    // unknown, is older than yesterday's wrong one, so it decides nothing. The explanation is not
    // a quiz, and this selector reads quiz answers only.
    const closestDue: DueItem = {
      blockId: "closest", rule: "due-review/wrong-first-try", answeredAt: at(60), corrected: true, shown: ["feedback"],
      lastSeen: at(120), evidence: [seq("answer", "closest"), seq("exposure", "closest"), seq("answer", "closest", 1)],
    };
    const moonsDue: DueItem = {
      blockId: "moons", rule: "due-review/wrong-first-try", answeredAt: at(600), corrected: true, shown: [],
      lastSeen: at(600), evidence: [seq("answer", "moons"), seq("answer", "moons", 1)],
    };
    expect(await r.dueReview({ ...asked, now: at(DAY) })).toEqual([closestDue, moonsDue]);

    // They open the next lesson, "Planets". School puts the two at the top of it, in a Review
    // section, each with its reason, and snapshots them with the lesson.
    let now = at(DAY);
    const school = createSchool({ record: r, grader: noGrader, clock: { now: () => now } });
    const reviewed = await school.openLesson(COURSE, planets, 1, [closest, moons, seasons, rings]);
    expect(reviewed.encounter.resumed).toBe(false);
    expect(reviewed.page).toEqual({ ...(planets as Extract<Block, { type: "page" }>), children: [{ type: "section", id: "school:review", title: "Review", children: [closest, moons] }, rings] });
    expect(reviewed.review).toEqual([
      { blockId: "closest", rule: "due-review/wrong-first-try", reason: "Back because your first answer on 21 November was wrong, and the right one came after the explanation was shown." },
      { blockId: "moons", rule: "due-review/wrong-first-try", reason: "Back because your first answer on 21 November was wrong; you put it right on a later try." },
    ]);
    // One note per item, for this encounter, citing exactly the rows the selector named.
    expect((await r.encounterDecisionNotes(reviewed.encounter.id)).map((n) => [n.choice, n.rule, n.evidence])).toEqual([
      [{ course: COURSE, lesson: "planets", blockId: "closest" }, closestDue.rule, closestDue.evidence],
      [{ course: COURSE, lesson: "planets", blockId: "moons" }, moonsDue.rule, moonsDue.evidence],
    ]);

    // 09:01. The closest planet, right first try, nothing shown before it: the strongest evidence
    // School can hold, a day after it was last wrong.
    now = at(DAY + 60);
    const recalled = crypto.randomUUID();
    expect(await r.submit({ submissionId: recalled, encounterId: reviewed.encounter.id, blockId: "closest", choiceId: "mercury", ms: 2000 }, now))
      .toEqual({ status: "stored", correct: true, firstTry: true });
    expect(await aidOf(recalled)).toBe("No recorded aid");

    // 09:30. A reload is the same encounter, with the same review and the same reasons, though the
    // closest planet would not be chosen now.
    now = at(DAY + 1800);
    const again = await school.openLesson(COURSE, planets, 1, [closest, moons, seasons, rings]);
    expect(again).toEqual({ ...reviewed, encounter: { ...reviewed.encounter, resumed: true }, answers: [{ blockId: "closest", choiceId: "mercury", correct: true }] });
    expect(await r.encounterDecisionNotes(reviewed.encounter.id)).toHaveLength(2);

    // Day four. The closest planet is cleared; the moons, shown yesterday but not answered, is still due.
    expect((await r.dueReview({ ...asked, now: at(2 * DAY + 60) })).map((x) => x.blockId)).toEqual(["moons"]);
  });
}
