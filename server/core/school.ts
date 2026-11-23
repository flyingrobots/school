// School's use cases (RFC 3, §4). Each takes values already parsed at the edge, talks only to
// ports, and returns plain data for the driving adapter to serialise.
import type { Aid, AidTracking, Block, Contradiction, Encounter, Exposure, ExposureResult, ExplanationState, ExplanationSubmission, Grading, GradingRecord, LessonProgress, Recorded, SaveResult, Source, Submission, SubmitResult, ViewEvent } from "./model.ts";
import type { Clock, Grader, LearningRecord } from "./ports.ts";

const squash = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Whether each quoted passage really appears in the source it names. This proves the words
 * exist there; it does not prove they support the criticism, and the page does not claim so.
 */
export function checkQuotes(contradictions: readonly Contradiction[], sources: readonly Source[], modelAnswer: string): (Contradiction & { quote_verified: boolean })[] {
  const text = new Map(sources.map((s) => [s.id, squash(s.text)]));
  text.set("model", squash(modelAnswer));
  return contradictions.map((c) => {
    const src = text.get(c.source_id);
    const q = squash(c.quote);
    return { ...c, quote_verified: src !== undefined && q.length > 0 && src.includes(q) };
  });
}

export type OpenedLesson = { encounter: Encounter; answers: Recorded[]; explanations: ExplanationState[] };

export interface School {
  /**
   * Open or resume the learner's encounter with this page, with what is already answered in it.
   * `aidTracking` is the capture version the client declares it records exposures under, or null.
   */
  openLesson(course: string, page: Block, aidTracking: AidTracking): Promise<OpenedLesson>;
  submitAnswer(s: Submission): Promise<SubmitResult>;
  saveExplanation(s: ExplanationSubmission): Promise<{ result: SaveResult; explanation: ExplanationState | null }>;
  /** One grading attempt, stored whatever its outcome; null when there is no such explanation. */
  gradeExplanation(submissionId: string): Promise<{ grading: Grading; explanation: ExplanationState | null } | null>;
  lessonProgress(course: string): Promise<LessonProgress>;
  recordView(v: ViewEvent): Promise<void>;
  recordExposure(e: Exposure): Promise<ExposureResult>;
  submissionAid(submissionId: string): Promise<Aid | null>;
}

export function createSchool(ports: { record: LearningRecord; grader: Grader; clock: Clock }): School {
  const { record, grader, clock } = ports;
  const explanationNow = async (id: string) => (await record.explanation(id))?.state ?? null;
  return {
    async openLesson(course, page, aidTracking) {
      if (page.type !== "page") throw new TypeError("a lesson is a page block");
      const encounter = await record.openEncounter({ course, lesson: page.id, page, now: clock.now(), aidTracking });
      const [answers, explanations] = await Promise.all([record.encounterAnswers(encounter.id), record.encounterExplanations(encounter.id)]);
      return { encounter, answers, explanations };
    },
    submitAnswer: (s) => record.submit(s, clock.now()),
    async saveExplanation(s) {
      // Saved and committed before any grading is attempted (RFC 1 proposal 4, lifecycle step 1).
      const result = await record.saveExplanation(s, clock.now());
      return { result, explanation: result.status === "stored" || result.status === "duplicate" ? await explanationNow(s.submissionId) : null };
    },
    async gradeExplanation(submissionId) {
      const saved = await record.explanation(submissionId);
      if (saved === null) return null;
      const { block, state } = saved;
      const now = clock.now();
      // Judged against the block in the encounter's snapshot, so a later edit to the lesson cannot change it.
      const outcome = await grader.grade({ prompt: block.prompt, modelAnswer: block.model, sources: block.sources, explanation: state.text });
      const result: Pick<GradingRecord, "status" | "findings" | "error"> = outcome.status === "succeeded"
        ? { status: "succeeded", error: null, findings: { ...outcome.findings, contradictions: checkQuotes(outcome.findings.contradictions, block.sources, block.model) } }
        : { status: "failed", findings: null, error: outcome.error };
      const grading = await record.recordGrading({
        ...result, submissionId, rubricVersion: grader.rubricVersion, promptVersion: grader.promptVersion,
        adapter: grader.adapter, model: outcome.model ?? (grader.model || null), sources: block.sources, raw: outcome.raw ?? null,
      } as GradingRecord, now);
      return { grading, explanation: await explanationNow(submissionId) };
    },
    lessonProgress: (course) => record.lessonProgress(course),
    recordView: (v) => record.recordView(v, clock.now()),
    recordExposure: (e) => record.recordExposure(e, clock.now()),
    submissionAid: (id) => record.aid(id),
  };
}
