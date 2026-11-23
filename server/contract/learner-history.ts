// One learner's history, told as a story and replayed through the LearningRecord port
// (flyingrobots/school#27). The contract suite proves each rule on its own; this replays them
// together, and checks two things at every step: the facts as the port reports them, and what
// the lesson page would show for them. It speaks only through the port, so every adapter that
// registers it (SQLite and Postgres on PGlite today; real Postgres with flyingrobots/school#23)
// must tell the same story. It grows as the record does: steps the port cannot express yet are
// `test.todo`, each naming the issue that adds them.
import { expect, test } from "bun:test";
import type { Block, ExplainBlock, ExplanationState, GradingRecord, Recorded } from "../core/model.ts";
import type { LearningRecord } from "../core/ports.ts";

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
const COURSE = "astronomy";

const T0 = Date.parse("2026-11-21T09:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

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

/** Register the story for one adapter. `make` returns a fresh, empty record. */
export function learnerHistory(name: string, make: () => Promise<LearningRecord>): void {
  const pending = (step: string, issue: string) => test.todo(`${name}: learner history, pending ${issue}: ${step}`);

  test(`${name}: learner history replays, and the page shows each step as it happened`, async () => {
    const r = await make();
    const reload = async (e: { id: string }) => pageShows(await r.encounterAnswers(e.id), await r.encounterExplanations(e.id));

    // 09:00. The learner opens "Orbits" for the first time: a new encounter, nothing answered.
    const e = await r.openEncounter({ course: COURSE, lesson: "orbits", page, now: at(0) });
    expect(e.resumed).toBe(false);
    expect(await reload(e)).toEqual({});

    // 09:01. They guess Venus for the closest planet. Wrong, and it was their first try.
    const venus = crypto.randomUUID();
    expect(await r.submit({ submissionId: venus, encounterId: e.id, blockId: "closest", choiceId: "venus", ms: 4000 }, at(60)))
      .toEqual({ status: "stored", correct: false, firstTry: true });
    expect(await reload(e)).toEqual({ closest: "Not quite (venus)" });

    // 09:02. They try Mercury. Right, but no longer a first try: the record remembers the miss.
    expect(await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "closest", choiceId: "mercury", ms: 3000 }, at(120)))
      .toEqual({ status: "stored", correct: true, firstTry: false });
    expect(await reload(e)).toEqual({ closest: "Answered (mercury)" });

    // 09:05. The connection drops. They answer the moons quiz twice, Mars then Venus, and both sit
    // in the outbox. 09:10: it reconnects and flushes them in one go, so both arrive with the same
    // time. Order still comes out as they were sent: Mars is the first try, Venus is not.
    const mars = crypto.randomUUID();
    const venusMoons = { submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "moons", choiceId: "venus", ms: 2000 };
    expect(await r.submit({ submissionId: mars, encounterId: e.id, blockId: "moons", choiceId: "mars", ms: 5000 }, at(600)))
      .toEqual({ status: "stored", correct: false, firstTry: true });
    expect(await r.submit(venusMoons, at(600))).toEqual({ status: "stored", correct: true, firstTry: false });

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

    // 09:15. They explain the seasons. It is saved before anything grades it, and the page now
    // shows the model answer beside it.
    const draft = { submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "seasons", text: "Earth is closer in summer.", ms: 60_000 };
    expect(await r.saveExplanation(draft, at(900))).toEqual({ status: "stored" });
    expect((await reload(e)).seasons).toBe("Saved: Earth is closer in summer.");

    // 09:20. Having read the model answer, they write a better explanation. The revision is a new
    // submission; the draft is kept, and the page shows the revision.
    const revised = { submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "seasons", text: "The tilt of Earth's axis.", ms: 30_000 };
    expect(await r.saveExplanation(revised, at(1200))).toEqual({ status: "stored" });
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
    const back = await r.openEncounter({ course: COURSE, lesson: "orbits", page, now: at(2 * 3600) });
    expect(back).toEqual({ id: e.id, hash: e.hash, resumed: true });
    expect(await r.encounterExplanations(back.id)).toEqual([
      { submissionId: revised.submissionId, blockId: "seasons", text: revised.text, at: at(1200), grading: graded },
    ]);
    expect(await reload(back)).toEqual({
      closest: "Answered (mercury)",
      moons: "Answered (venus)",
      seasons: "Graded: Names the tilt; could say why it matters.",
    });
    expect(await r.lessonProgress(COURSE)).toEqual({ orbits: ["closest", "moons"] });
  });

  // The record cannot say these yet. Each becomes a step of the story above when its issue lands.
  pending("an answer in an encounter with aid tracking off is stored as unknown aid, and shown so", "flyingrobots/school#29");
  pending("a tracked answer given with no help shown is stored with no recorded aid, and shown so", "flyingrobots/school#29");
  pending("showing the model answer is recorded as an exposure, so the revised explanation after it is aided, and shown so", "flyingrobots/school#29");
}
