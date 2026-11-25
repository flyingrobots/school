// The ports: what School's core needs from the world, defined by the core (RFC 3, §4).
// Adapters implement them; the core never imports an adapter.
import type {
  Aid, AidTracking, Block, DecisionChoice, DueItem, DueReviewQuery, ReviewNote, DecisionNote, DecisionNoteInput, DecisionNoteResult, Encounter, EvidenceRow, ExplanationState, ExplanationSubmission, Exposure, ExposureResult, Grading, GradingInput,
  GradingRecord, LastStudied, LatestFeedback, LessonProgress, Outcome, Recorded, SaveResult, SavedExplanation, StudyDay, Submission, SubmitResult, ViewEvent,
} from "./model.ts";

/**
 * The learner's record. Every rule that keeps progress from being lost lives behind this port:
 * correctness and first try are derived from the stored snapshot, and nothing is ever updated
 * or deleted. Each method is atomic.
 */
export interface LearningRecord {
  /**
   * Store the page as a snapshot, then resume this lesson's encounter inside the resume window or open a new one.
   * `aidTracking` is the aid capture version the client follows, or null when it records no exposures; it has
   * no default. An encounter resumes only under the same value, so a change of capture starts a new one.
   */
  openEncounter(o: { course: string; lesson: string; page: Block; now: string; aidTracking: AidTracking }): Promise<Encounter>;
  /**
   * Open or resume an encounter with a lesson that may carry review (RFC 2 §5). `lessonPage` is the
   * lesson as written; `page` is what is shown, the lesson with any review added. The encounter is
   * found by the lesson as written: one inside the resume window, under the same `aidTracking`,
   * resumes, and `page` and `notes` are ignored; `page` in the result is then its snapshot, so a
   * reload shows the review it opened with. Otherwise `page` is snapshotted, a new encounter opened,
   * and each note stored as a decision note for its block of this lesson and this encounter, all in
   * one write: a note the record would refuse throws, and nothing is opened.
   */
  openLessonEncounter(o: {
    course: string; lesson: string; lessonPage: Block; page: Block; notes: ReviewNote[]; now: string; aidTracking: AidTracking;
  }): Promise<{ encounter: Encounter; page: Block }>;
  submit(s: Submission, now: string): Promise<SubmitResult>;
  /** What the learner has already answered in this encounter, oldest first. */
  encounterAnswers(encounterId: string): Promise<Recorded[]>;
  lessonProgress(course: string): Promise<LessonProgress>;
  /**
   * Where the learner left off: the course and lesson of the latest encounter opened, answer or
   * explanation stored, or view recorded, by the record's order, with its time; null when there is
   * none. A refused submission is not activity, and neither is resuming an encounter, which stores nothing.
   */
  lastStudied(): Promise<LastStudied | null>;
  /** Each course's local days, in time zone `tz`, with any activity in [from, to) (flyingrobots/school#165). */
  studyDays(q: { from: string; to: string; tz: string }): Promise<StudyDay[]>;
  /** The newest succeeded grading and where its explanation was written; null before any. */
  latestFeedback(): Promise<LatestFeedback | null>;
  /** The time zone the learner chose in Settings, or null for automatic (flyingrobots/school#181). */
  timeZone(): Promise<string | null>;
  /** Append a choice of time zone; null goes back to automatic. */
  chooseTimeZone(zone: string | null, now: string): Promise<void>;
  saveExplanation(s: ExplanationSubmission, now: string): Promise<SaveResult>;
  /** A saved explanation, its block from the snapshot and its latest grading; null if there is none. */
  explanation(submissionId: string): Promise<SavedExplanation | null>;
  /** Store one grading attempt, superseding the submission's latest; returns it as stored. */
  recordGrading(g: GradingRecord, now: string): Promise<Grading>;
  /** The latest explanation per block in this encounter, each with its latest grading. */
  encounterExplanations(encounterId: string): Promise<ExplanationState[]>;
  recordView(v: ViewEvent, now: string): Promise<void>;
  /** Store help shown for a block, once per exposure id. */
  recordExposure(e: Exposure, now: string): Promise<ExposureResult>;
  /** A quiz answer's or explanation's aid, derived by the record's order; null if there is no such submission. */
  aid(submissionId: string): Promise<Aid | null>;
  /** Every row this encounter holds that a decision note may cite, by seq, oldest first; empty if there is no such encounter. */
  encounterEvidence(encounterId: string): Promise<EvidenceRow[]>;
  /**
   * Store a decision note once per note id (RFC 2 §3, §5). Refused, and nothing stored, if a cited
   * row does not exist or is not evidence of the choice's course; see DecisionNoteResult.
   */
  recordDecisionNote(n: DecisionNoteInput, now: string): Promise<DecisionNoteResult>;
  /** The notes for exactly this choice (a course's notes do not include its lessons'), oldest first. */
  decisionNotes(choice: DecisionChoice): Promise<DecisionNote[]>;
  /** The notes recorded for this encounter, oldest first. */
  encounterDecisionNotes(encounterId: string): Promise<DecisionNote[]>;
  /**
   * The blocks due for review among `q.blocks`, ranked, at most `q.limit` (RFC 2 §5): reads only.
   * The rule is in server/db/migrations/0006_due_review.sql, due_review, and is the record's.
   */
  dueReview(q: DueReviewQuery): Promise<DueItem[]>;
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
