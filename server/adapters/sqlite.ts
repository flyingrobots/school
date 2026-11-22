// The SQLite adapter of the LearningRecord port: today's record.ts and explain.ts, unchanged,
// behind the port. It is deleted with them when the record moves to Postgres (flyingrobots/school#22).
import type { Database } from "bun:sqlite";
import type { LearningRecord } from "../core/ports.ts";
import { encounterExplanations, explanationState, recordGrading, saveExplanation } from "../explain.ts";
import { encounterAnswers, lessonProgress, openEncounter, submit } from "../record.ts";

export function sqliteRecord(db: Database): LearningRecord {
  const insertView = db.prepare("INSERT INTO views (course, lesson, at) VALUES ($course, $lesson, $at)");
  return {
    openEncounter: async (o) => openEncounter(db, o),
    submit: async (s, now) => submit(db, s, now),
    encounterAnswers: async (id) => encounterAnswers(db, id),
    lessonProgress: async (course) =>
      Object.fromEntries([...lessonProgress(db, course)].map(([lesson, ids]) => [lesson, [...ids].sort()])),
    saveExplanation: async (s, now) => saveExplanation(db, s, now),
    explanation: async (id) => explanationState(db, id),
    recordGrading: async (g, now) => recordGrading(db, g, now),
    encounterExplanations: async (id) => encounterExplanations(db, id),
    recordView: async (v, now) => void insertView.run({ course: v.course, lesson: v.lesson, at: now }),
  };
}
