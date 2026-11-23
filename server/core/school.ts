// School's use cases (RFC 3, §4). Each takes values already parsed at the edge, talks only to
// ports, and returns plain data for the driving adapter to serialise.
import type { Aid, AidTracking, Block, Contradiction, DecisionChoice, DecisionNote, DecisionNoteInput, DecisionNoteResult, Encounter, EvidenceRow, Exposure, ExposureResult, ExplanationState, ExplanationSubmission, Grading, GradingRecord, LastStudied, LessonProgress, Recorded, SaveResult, Source, Submission, SubmitResult, ViewEvent } from "./model.ts";
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
  /** Where the learner left off, or null before they have studied anything. */
  lastStudied(): Promise<LastStudied | null>;
  recordView(v: ViewEvent): Promise<void>;
  recordExposure(e: Exposure): Promise<ExposureResult>;
  submissionAid(submissionId: string): Promise<Aid | null>;
  /** The rows of an encounter a decision note may cite (RFC 2 §3), oldest first. */
  encounterEvidence(encounterId: string): Promise<EvidenceRow[]>;
  /** Record why School chose something, citing its evidence; refused if a cited row is not evidence of the choice's course. */
  recordDecisionNote(n: DecisionNoteInput): Promise<DecisionNoteResult>;
  decisionNotes(choice: DecisionChoice): Promise<DecisionNote[]>;
  encounterDecisionNotes(encounterId: string): Promise<DecisionNote[]>;
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
    lastStudied: () => record.lastStudied(),
    recordView: (v) => record.recordView(v, clock.now()),
    recordExposure: (e) => record.recordExposure(e, clock.now()),
    submissionAid: (id) => record.aid(id),
    encounterEvidence: (id) => record.encounterEvidence(id),
    recordDecisionNote: (n) => record.recordDecisionNote(n, clock.now()),
    decisionNotes: (c) => record.decisionNotes(c),
    encounterDecisionNotes: (id) => record.encounterDecisionNotes(id),
  };
}

/** A lesson as the course serves it, reduced to what choosing the next step needs: its quizzes in document order. */
export type LessonOutline = { id: string; title: string; subtitle: string; quizzes: { id: string; q: string }[] };
/** A course whose lessons can be read, with the quizzes ever answered correctly in each lesson. */
export type CourseOutline = { name: string; lessons: LessonOutline[]; progress: LessonProgress };

/** A lesson to study, with its place in its course and its progress as counts the page puts in words. */
export type ResumeLesson = {
  id: string; title: string; subtitle: string;
  /** 1-based place in the course, and how many lessons the course has. */
  position: number; of: number;
  quizzes: number; answeredCorrectly: number;
};

/**
 * What to study now (flyingrobots/school#39). `continue` the lesson the learner left off in, with the
 * question of its first quiz not yet answered correctly; `next`, once that lesson is finished; `start`,
 * before anything is studied or when the last lesson's course is no longer served; `finished`, when
 * every quiz in the course is answered correctly; `nothing`, when no course has a lesson.
 * `lastStudied` is the time of the learner's latest activity, or null before any.
 */
export type Resume =
  | { kind: "continue" | "next" | "start"; course: string; lesson: ResumeLesson; question: string | null; lastStudied: string | null }
  | { kind: "finished"; course: string; lastStudied: string }
  | { kind: "nothing" };

/**
 * The rule behind Resume. A lesson is finished when every one of its quizzes is answered correctly;
 * a reading lesson, with no quizzes, is finished once it is the one the learner was last in.
 * After a finished lesson comes the next one in the course that is not finished, where a reading
 * lesson ahead counts as not finished; past the end it wraps to the first lesson with a quiz still
 * to answer correctly.
 */
export function resumeFrom(last: LastStudied | null, courses: readonly CourseOutline[]): Resume {
  const toAnswer = (c: CourseOutline, l: LessonOutline) => l.quizzes.filter((q) => !c.progress[l.id]?.includes(q.id));
  const unfinished = (c: CourseOutline, l: LessonOutline) => l.quizzes.length === 0 || toAnswer(c, l).length > 0;
  const step = (kind: "continue" | "next" | "start", c: CourseOutline, i: number): Resume => {
    const l = c.lessons[i]!;
    const left = toAnswer(c, l);
    return {
      kind, course: c.name, lastStudied: last?.at ?? null, question: kind === "continue" ? left[0]!.q : null,
      lesson: { id: l.id, title: l.title, subtitle: l.subtitle, position: i + 1, of: c.lessons.length,
        quizzes: l.quizzes.length, answeredCorrectly: l.quizzes.length - left.length },
    };
  };

  const course = last === null ? undefined : courses.find((c) => c.name === last.course && c.lessons.length > 0);
  if (last !== null && course !== undefined) {
    const i = course.lessons.findIndex((l) => l.id === last.lesson);
    if (i >= 0 && toAnswer(course, course.lessons[i]!).length > 0) return step("continue", course, i);
    const ahead = i < 0 ? -1 : course.lessons.findIndex((l, j) => j > i && unfinished(course, l));
    if (ahead >= 0) return step("next", course, ahead);
    const wrapped = course.lessons.findIndex((l) => toAnswer(course, l).length > 0);
    if (wrapped >= 0) return step("next", course, wrapped);
    return { kind: "finished", course: course.name, lastStudied: last.at };
  }
  const first = courses.find((c) => c.lessons.length > 0);
  return first === undefined ? { kind: "nothing" } : step("start", first, 0);
}
