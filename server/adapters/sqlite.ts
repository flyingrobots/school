// The SQLite adapter of the LearningRecord port: today's record.ts and explain.ts, unchanged,
// behind the port. It is deleted with them when the record moves to Postgres (flyingrobots/school#22, #49).
//
// It records no exposures: SQLite has no exposures table and no aid_tracking, and it is not getting
// them before it is deleted. So it says so (recordsExposures: false), ignores the capture version an
// open asks for (every encounter it opens is untracked), refuses every exposure as unsupported, and
// reports the aid of every submission it holds as unknown, never as "no recorded aid".
import type { Database } from "bun:sqlite";
import type { LearningRecord } from "../core/ports.ts";
import { encounterExplanations, explanationState, recordGrading, saveExplanation } from "../explain.ts";
import { encounterAnswers, lessonProgress, openEncounter, submit } from "../record.ts";

export function sqliteRecord(db: Database): LearningRecord {
  const insertView = db.prepare("INSERT INTO views (course, lesson, at) VALUES ($course, $lesson, $at)");
  const submissionExists = db.prepare<{ n: number }, { id: string }>(
    "SELECT (SELECT count(*) FROM answers WHERE submission_id = $id) + (SELECT count(*) FROM explanations WHERE submission_id = $id) AS n");
  return {
    openEncounter: async ({ course, lesson, page, now }) => openEncounter(db, { course, lesson, page, now }),
    submit: async (s, now) => submit(db, s, now),
    encounterAnswers: async (id) => encounterAnswers(db, id),
    lessonProgress: async (course) =>
      Object.fromEntries([...lessonProgress(db, course)].map(([lesson, ids]) => [lesson, [...ids].sort()])),
    saveExplanation: async (s, now) => saveExplanation(db, s, now),
    explanation: async (id) => explanationState(db, id),
    recordGrading: async (g, now) => recordGrading(db, g, now),
    encounterExplanations: async (id) => encounterExplanations(db, id),
    recordView: async (v, now) => void insertView.run({ course: v.course, lesson: v.lesson, at: now }),
    recordsExposures: false,
    recordExposure: async () => ({ status: "unsupported" }),
    aid: async (id) => (submissionExists.get({ id })!.n > 0 ? "unknown" : null),
    // Nor decision notes (flyingrobots/school#31): their cases run only on a record that stores exposures.
    encounterEvidence: async () => { throw new Error("the SQLite record keeps no decision notes"); },
    recordDecisionNote: async () => { throw new Error("the SQLite record keeps no decision notes"); },
    decisionNotes: async () => { throw new Error("the SQLite record keeps no decision notes"); },
    encounterDecisionNotes: async () => { throw new Error("the SQLite record keeps no decision notes"); },
  };
}
