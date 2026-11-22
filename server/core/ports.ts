// The ports: what School's core needs from the world, defined by the core (RFC 3, §4).
// Adapters implement them; the core never imports an adapter.
import type {
  Block, Encounter, ExplanationState, ExplanationSubmission, Grading, GradingInput, GradingRecord,
  LessonProgress, Outcome, Recorded, SaveResult, SavedExplanation, Submission, SubmitResult, ViewEvent,
} from "./model.ts";

/**
 * The learner's record. Every rule that keeps progress from being lost lives behind this port:
 * correctness and first try are derived from the stored snapshot, and nothing is ever updated
 * or deleted. Each method is atomic.
 */
export interface LearningRecord {
  /** Store the page as a snapshot, then resume this lesson's encounter inside the resume window or open a new one. */
  openEncounter(o: { course: string; lesson: string; page: Block; now: string }): Promise<Encounter>;
  submit(s: Submission, now: string): Promise<SubmitResult>;
  /** What the learner has already answered in this encounter, oldest first. */
  encounterAnswers(encounterId: string): Promise<Recorded[]>;
  lessonProgress(course: string): Promise<LessonProgress>;
  saveExplanation(s: ExplanationSubmission, now: string): Promise<SaveResult>;
  /** A saved explanation, its block from the snapshot and its latest grading; null if there is none. */
  explanation(submissionId: string): Promise<SavedExplanation | null>;
  /** Store one grading attempt, superseding the submission's latest; returns it as stored. */
  recordGrading(g: GradingRecord, now: string): Promise<Grading>;
  /** The latest explanation per block in this encounter, each with its latest grading. */
  encounterExplanations(encounterId: string): Promise<ExplanationState[]>;
  recordView(v: ViewEvent, now: string): Promise<void>;
}

/** Turns an explanation into findings, or an honest failure. Never throws for a grading failure. */
export interface Grader {
  readonly adapter: string;
  readonly model: string;
  /** Recorded with every attempt, so a verdict can be traced to what produced it. */
  readonly rubricVersion: string;
  readonly promptVersion: string;
  grade(input: GradingInput): Promise<Outcome>;
}

export interface Clock {
  now(): string;
}
