// School's use cases (RFC 3, §4). Each takes values already parsed at the edge, talks only to
// ports, and returns plain data for the driving adapter to serialise.
import type { Aid, AidTracking, Block, Contradiction, DecisionChoice, DecisionNote, DecisionNoteInput, DecisionNoteResult, DueItem, Encounter, RecordedExposureKind, ReviewNote, ReviewReason, EvidenceRow, Exposure, ExposureResult, ExplanationState, ExplanationSubmission, Grading, GradingRecord, LastStudied, LatestFeedback, LessonProgress, MasteryRollup, Recorded, SaveResult, Source, Submission, SubmitResult, ViewEvent } from "./model.ts";
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

/**
 * A lesson opened for study. `page` is what its encounter snapshotted: the lesson as written, with a
 * Review section at its top when School brought items back. `review` is each review item's reason.
 */
export type OpenedLesson = { encounter: Encounter; page: Block; answers: Recorded[]; explanations: ExplanationState[]; review: ReviewReason[] };

// ---- Due review (RFC 2 §5; flyingrobots/school#32) --------------------------------------------

/**
 * How long since a block was last answered before it may come back: a day, less a few hours, so an
 * item from one day's study returns the next day even when the learner sits down a little earlier.
 */
export const REVIEW_DELAY_MS = 20 * 60 * 60 * 1000;
/** At most this many items come back in one lesson. */
export const REVIEW_LIMIT = 3;
/** The id of the section School adds at the top of a lesson for its review items. Authored ids may not start `school:` (server/blocks.ts). */
export const REVIEW_SECTION_ID = "school:review";

const helpWords: Record<RecordedExposureKind, string> = {
  feedback: "the explanation", "model-answer": "the model answer", hint: "a hint", reference: "a reference",
  "ai-help": "asking about the lesson",
};
const listed = (words: string[]) => words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/**
 * Why an item came back, in words, from the facts the selector names (RFC 2 §5: "every review item
 * says why it came back"). The day is the answer's in the server's time zone (`TZ`).
 */
export function reviewReason(item: DueItem, tz?: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: tz }).format(new Date(item.answeredAt));
  const help = listed(item.shown.map((k) => helpWords[k]));
  // School's voice: say what helped, never what was wrong (docs/topics/voice/README.md).
  const back = "It's back so you can answer it from memory.";
  switch (item.rule) {
    case "due-review/wrong-first-try":
      if (!item.corrected) return `On ${day}, this one hadn't settled yet. It's back for a fresh look.`;
      return item.shown.length > 0
        ? `On ${day}, ${help} helped you find this one. ${back}`
        : `On ${day}, you found this one on a second go. ${back}`;
    case "due-review/aided-first-try":
      return `On ${day}, ${help} helped you find this one. ${back}`;
    case "due-review/unknown-aid":
      return `On ${day}, you found this one while School wasn't noting the help it showed. ${back}`;
  }
}

const childrenOf = (b: Block): Block[] => (b.type === "page" || b.type === "section" ? b.children : []);
/** Every quiz id in a block and everything under it. */
function quizIdsIn(b: Block, into = new Set<string>()): Set<string> {
  if (b.type === "quiz") into.add(b.id);
  for (const c of childrenOf(b)) quizIdsIn(c, into);
  return into;
}

export interface School {
  /**
   * Open or resume the learner's encounter with this page, with what is already answered in it.
   * `aidTracking` is the capture version the client declares it records exposures under, or null.
   * `reviewable` is the course's blocks as written now: the quizzes among them that are not in this
   * lesson may come back for review (RFC 2 §5), at the top of it, each with a decision note. A
   * reload inside the resume window shows the review the encounter opened with.
   */
  /** `tz`: the zone each review reason names its day in; the server's when absent. */
  openLesson(course: string, page: Block, aidTracking: AidTracking, reviewable?: readonly Block[], tz?: string): Promise<OpenedLesson>;
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
  /** The newest succeeded grading, with the prompt its explanation answered; null before any (flyingrobots/school#165). */
  latestFeedback(): Promise<(LatestFeedback & { prompt: string | null }) | null>;
  /** The time zone the learner chose in Settings, or null for automatic (flyingrobots/school#181). */
  timeZone(): Promise<string | null>;
  /** Choose a time zone, or null to go back to automatic; recorded at the clock's now. */
  chooseTimeZone(zone: string | null): Promise<void>;
  /** The quizzes among `blocks` due for review now, each with its reason in words. */
  /** `tz`: the zone the reason names its day in; the server's when absent. */
  dueNow(course: string, blocks: readonly string[], tz?: string): Promise<{ item: DueItem; reason: string }[]>;
  /**
   * For each course, the local days in time zone `tz` it was studied in the last `days` days, and,
   * for each of the next `days` days, how many of its quizzes become due for review that day.
   */
  activity(courses: readonly { name: string; blocks: readonly string[] }[], days: number, tz: string):
    Promise<{ today: string; courses: { course: string; studied: string[]; due: { day: string; items: number }[] }[] }>;
  /**
   * How each group of the course's quizzes is holding now (RFC 5 §4.5): one row per key of
   * `groups`, read at the clock's now with the delay due review uses, so it agrees with the review
   * a lesson opens with. A group with no quizzes counts zero in every state.
   */
  masteryNow(course: string, groups: Readonly<Record<string, readonly string[]>>): Promise<MasteryRollup[]>;
}

export function createSchool(ports: { record: LearningRecord; grader: Grader; clock: Clock }): School {
  const { record, grader, clock } = ports;
  const explanationNow = async (id: string) => (await record.explanation(id))?.state ?? null;
  return {
    async openLesson(course, page, aidTracking, reviewable = [], tz) {
      if (page.type !== "page") throw new TypeError("a lesson is a page block");
      const now = clock.now();
      const own = quizIdsIn(page);
      const candidates = new Map(reviewable.flatMap((b) => (b.type === "quiz" && !own.has(b.id) ? [[b.id, b] as const] : [])));
      const due = candidates.size > 0
        ? await record.dueReview({ course, blocks: [...candidates.keys()], now, delayMs: REVIEW_DELAY_MS, limit: REVIEW_LIMIT })
        : [];
      const items = due.filter((d) => candidates.has(d.blockId));
      const shown: Block = items.length === 0 ? page : {
        ...page,
        children: [{ type: "section", id: REVIEW_SECTION_ID, title: "Review", children: items.map((d) => candidates.get(d.blockId)!) }, ...page.children],
      };
      const notes: ReviewNote[] = items.map((d) => ({ blockId: d.blockId, rule: d.rule, reason: reviewReason(d, tz), evidence: d.evidence }));
      const opened = await record.openLessonEncounter({ course, lesson: page.id, lessonPage: page, page: shown, notes, now, aidTracking });
      const { encounter } = opened;
      const [answers, explanations, noted] = await Promise.all([
        record.encounterAnswers(encounter.id), record.encounterExplanations(encounter.id),
        record.encounterDecisionNotes(encounter.id),
      ]);
      const review = noted.flatMap((n) => (n.rule.startsWith("due-review/") && n.choice.blockId !== null
        ? [{ blockId: n.choice.blockId, rule: n.rule, reason: n.reason }] : []));
      return { encounter, page: opened.page, answers, explanations, review };
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
    timeZone: () => record.timeZone(),
    chooseTimeZone: (zone) => record.chooseTimeZone(zone, clock.now()),
    async latestFeedback() {
      const f = await record.latestFeedback();
      if (f === null) return null;
      const saved = await record.explanation(f.submissionId);
      return { ...f, prompt: saved?.block.type === "explain" ? saved.block.prompt : null };
    },
    async dueNow(course, blocks, tz) {
      if (blocks.length === 0) return [];
      const due = await record.dueReview({ course, blocks: [...blocks], now: clock.now(), delayMs: REVIEW_DELAY_MS, limit: REVIEW_LIMIT });
      return due.map((item) => ({ item, reason: reviewReason(item, tz) }));
    },
    async activity(courses, days, tz) {
      const now = Date.parse(clock.now());
      const DAY = 24 * 60 * 60 * 1000;
      const local = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
      const studied = await record.studyDays({ from: new Date(now - days * DAY).toISOString(), to: new Date(now + 1).toISOString(), tz });
      // Every quiz that will be due, not only the few one lesson shows.
      const dueBy = async (course: string, blocks: readonly string[], at: number) => blocks.length === 0 ? new Set<string>() : new Set(
        (await record.dueReview({ course, blocks: [...blocks], now: new Date(at).toISOString(), delayMs: REVIEW_DELAY_MS, limit: 10_000 })).map((d) => d.blockId));
      return {
        today: local(now),
        courses: await Promise.all(courses.map(async (c) => {
          const seen = await dueBy(c.name, c.blocks, now);
          const due: { day: string; items: number }[] = [];
          for (let k = 1; k <= days; k++) {
            const by = await dueBy(c.name, c.blocks, now + k * DAY);
            const fresh = [...by].filter((id) => !seen.has(id));
            for (const id of fresh) seen.add(id);
            if (fresh.length > 0) due.push({ day: local(now + k * DAY), items: fresh.length });
          }
          return { course: c.name, studied: studied.filter((d) => d.course === c.name).map((d) => d.day), due };
        })),
      };
    },
    masteryNow: async () => { throw new Error("not implemented"); },
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
