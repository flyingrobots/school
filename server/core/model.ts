// School's data model, as Zod schemas and the types inferred from them (RFC 3, §4 and §5).
// Every value that crosses a port or arrives over HTTP is parsed by one of these. Until
// Wesley's Zod emitter exists, they are written by hand to match the declared shapes.
import { z } from "zod";

export type NestNode = { label: string; atoms: string[]; edge?: string; children: NestNode[] };
export const NestNode: z.ZodType<NestNode> = z.lazy(() =>
  z.object({ label: z.string(), atoms: z.array(z.string()), edge: z.string().optional(), children: z.array(NestNode) }));

/** A quiz choice. `id` is stable for the choice's meaning, so a recorded answer survives rewording or reordering. */
export const Choice = z.object({ id: z.string(), text: z.string(), correct: z.boolean() });
export type Choice = z.infer<typeof Choice>;

/** Material an explanation is graded against. `id` is what a grader's quote cites. */
export const Source = z.object({ id: z.string(), title: z.string(), text: z.string() });
export type Source = z.infer<typeof Source>;

export type Block =
  | { type: "page"; id: string; title: string; subtitle: string; children: Block[] }
  | { type: "section"; id: string; title: string; children: Block[] }
  | { type: "prose"; id: string; html: string }
  | { type: "card"; id: string; html: string }
  | { type: "quote"; id: string; html: string }
  | { type: "aside"; id: string; html: string }
  | { type: "quiz"; id: string; q: string; choices: Choice[]; why: string }
  | { type: "explain"; id: string; prompt: string; model: string; sources: Source[] }
  | { type: "nest"; id: string; root: NestNode };
export const Block: z.ZodType<Block> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), id: z.string(), title: z.string(), subtitle: z.string(), children: z.array(Block) }),
  z.object({ type: z.literal("section"), id: z.string(), title: z.string(), children: z.array(Block) }),
  ...(["prose", "card", "quote", "aside"] as const).map((type) => z.object({ type: z.literal(type), id: z.string(), html: z.string() })),
  z.object({ type: z.literal("quiz"), id: z.string(), q: z.string(), choices: z.array(Choice), why: z.string() }),
  z.object({ type: z.literal("explain"), id: z.string(), prompt: z.string(), model: z.string(), sources: z.array(Source) }),
  z.object({ type: z.literal("nest"), id: z.string(), root: NestNode }),
]));
export type ExplainBlock = Extract<Block, { type: "explain" }>;

// Any hex-shaped UUID, as the server has always accepted; z.uuid() would also demand RFC version bits.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform((s) => s.toLowerCase());
const blockId = z.string().min(1).max(200);
const ms = z.int().nonnegative();
const timestamp = z.iso.datetime();

// What the learner did. Correctness and first try are the record's to decide, never the client's.
export const Submission = z.object({ submissionId: uuid, encounterId: uuid, blockId, choiceId: z.string().min(1).max(200), ms });
export type Submission = z.infer<typeof Submission>;

export const ExplanationSubmission = z.object({
  submissionId: uuid, encounterId: uuid, blockId, ms,
  text: z.string().trim().min(1).max(10_000),
});
export type ExplanationSubmission = z.infer<typeof ExplanationSubmission>;

export const ViewEvent = z.object({ course: z.string().min(1).max(200), lesson: z.string().min(1).max(200) });
export type ViewEvent = z.infer<typeof ViewEvent>;

export const GradeRequest = z.object({ submissionId: uuid });

/** A submission id as a path segment, for GET /api/aid/:submissionId. */
export const AidRequest = z.object({ submissionId: uuid });

/**
 * The versions of aid capture this server knows (RFC 2 §3). A client that records every exposure it
 * shows says which version it follows when it opens a lesson; an encounter opened without one has
 * aid tracking NULL, and its aid is unknown. 1: feedback, model answers, hints and references.
 */
export const AID_CAPTURE_VERSIONS = [1] as const;
export const AidTracking = z.literal(AID_CAPTURE_VERSIONS).nullable();
export type AidTracking = z.infer<typeof AidTracking>;

/** The lesson API's `aid` query value: a known capture version, written as a plain decimal. */
export const AidQuery = z.string().regex(/^[1-9][0-9]{0,8}$/).transform(Number).pipe(z.literal(AID_CAPTURE_VERSIONS));

/** Help shown to the learner for one block (RFC 2 §3). */
export const ExposureKind = z.enum(["hint", "model-answer", "feedback", "reference"]);
export type ExposureKind = z.infer<typeof ExposureKind>;

/** An exposure the page reports having shown. `exposureId` is the client's, so a resend is stored once. */
export const Exposure = z.object({ exposureId: uuid, encounterId: uuid, blockId, kind: ExposureKind });
export type Exposure = z.infer<typeof Exposure>;

/**
 * `rejected`: no such encounter, it is not tracked, or the block is not a quiz or explain block in
 * its snapshot.
 */
export const ExposureResult = z.object({ status: z.enum(["stored", "duplicate", "conflict", "rejected"]) });
export type ExposureResult = z.infer<typeof ExposureResult>;

/** Whether a submission was aided: derived from exposures by the record's order, never stored (RFC 2 §3). */
export const Aid = z.enum(["aided", "no-recorded-aid", "unknown"]);
export type Aid = z.infer<typeof Aid>;

export const Encounter = z.object({ id: z.string(), hash: z.string(), resumed: z.boolean() });
export type Encounter = z.infer<typeof Encounter>;

export const SubmitResult = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["stored", "duplicate"]), correct: z.boolean(), firstTry: z.boolean() }),
  z.object({ status: z.literal("conflict") }), // that submission id already names a different answer
  z.object({ status: z.literal("rejected") }), // no such encounter, or that block and choice are not in its snapshot
]);
export type SubmitResult = z.infer<typeof SubmitResult>;

export const SaveResult = z.object({ status: z.enum(["stored", "duplicate", "conflict", "rejected"]) });
export type SaveResult = z.infer<typeof SaveResult>;

export const Recorded = z.object({ blockId: z.string(), choiceId: z.string(), correct: z.boolean() });
export type Recorded = z.infer<typeof Recorded>;

/** For each lesson of a course, the quizzes ever answered correctly there. */
export const LessonProgress = z.record(z.string(), z.array(z.string()));
export type LessonProgress = z.infer<typeof LessonProgress>;

/** Where the learner left off: the course and lesson of their latest activity, and its time. */
export const LastStudied = z.object({ course: z.string(), lesson: z.string(), at: z.string() });
export type LastStudied = z.infer<typeof LastStudied>;

/** A local day the learner studied a course (flyingrobots/school#165). `day` is YYYY-MM-DD. */
export const StudyDay = z.object({ course: z.string(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export type StudyDay = z.infer<typeof StudyDay>;

export const Verdict = z.enum(["meets", "partly", "misses"]);
export const Criterion = z.object({ verdict: Verdict, note: z.string() });
export const Contradiction = z.object({ source_id: z.string(), quote: z.string(), note: z.string() });
export type Contradiction = z.infer<typeof Contradiction>;
export const Findings = z.object({
  insufficient_evidence: z.boolean(),
  fidelity: Criterion,
  completeness: Criterion,
  accessibility: Criterion,
  contradictions: z.array(Contradiction),
  summary: z.string(),
});
export type Findings = z.infer<typeof Findings>;

/** The newest succeeded grading, with where its explanation was written (flyingrobots/school#165). */
export const LatestFeedback = z.object({
  submissionId: z.string(), course: z.string(), lesson: z.string(), blockId: z.string(),
  model: z.string().nullable(), findings: Findings, at: z.string(),
});
export type LatestFeedback = z.infer<typeof LatestFeedback>;
export const CheckedFindings = Findings.extend({ contradictions: z.array(Contradiction.extend({ quote_verified: z.boolean() })) });
export type CheckedFindings = z.infer<typeof CheckedFindings>;

export type GradingInput = { prompt: string; modelAnswer: string; sources: readonly Source[]; explanation: string };

export type Outcome =
  | { status: "succeeded"; findings: Findings; raw: string; model: string }
  | { status: "failed"; error: string; raw?: string; model?: string };

const gradingBase = { id: z.int(), model: z.string().nullable(), supersedes: z.int().nullable(), at: timestamp };
export const Grading = z.discriminatedUnion("status", [
  z.object({ ...gradingBase, status: z.literal("succeeded"), findings: CheckedFindings }),
  z.object({ ...gradingBase, status: z.literal("failed"), error: z.string() }),
]);
export type Grading = z.infer<typeof Grading>;

/** One grading attempt to store: what was judged, by what, and the result. */
export const GradingRecord = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), findings: CheckedFindings, error: z.null() }),
  z.object({ status: z.literal("failed"), findings: z.null(), error: z.string() }),
]).and(z.object({
  submissionId: z.string(),
  rubricVersion: z.string(),
  promptVersion: z.string(),
  adapter: z.string(),
  model: z.string().nullable(),
  sources: z.array(Source),
  raw: z.string().nullable(),
}));
export type GradingRecord = z.infer<typeof GradingRecord>;

export const ExplanationState = z.object({
  submissionId: z.string(), blockId: z.string(), text: z.string(), at: timestamp, grading: Grading.nullable(),
});
export type ExplanationState = z.infer<typeof ExplanationState>;

/** A saved explanation with the explain block it answers, as its encounter's snapshot holds it. */
export type SavedExplanation = { state: ExplanationState; block: ExplainBlock };

// ---- Decision notes (RFC 2 §3 and §5; flyingrobots/school#31) ---------------------------------

/** A row of the record, by its place in the record's one shared order (RFC 3 §3.4). */
export const Seq = z.int().positive();

/** What kind of row of an encounter's evidence a seq names. */
export const EvidenceKind = z.enum(["encounter", "answer", "explanation", "grading", "exposure"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** One row an encounter holds, which a decision note may cite. `blockId` is null for the encounter itself. */
export const EvidenceRow = z.object({ seq: Seq, kind: EvidenceKind, blockId: z.string().nullable() });
export type EvidenceRow = z.infer<typeof EvidenceRow>;

/**
 * What School chose: a course, a lesson in it, or a block in that lesson. A block is always chosen
 * within a lesson, so `blockId` names a lesson's block, never a bare one.
 */
export const DecisionChoice = z.object({
  course: z.string().min(1).max(200),
  lesson: z.string().min(1).max(200).nullable(),
  blockId: blockId.nullable(),
}).refine((c) => c.blockId === null || c.lesson !== null, { message: "a block is chosen within a lesson", path: ["lesson"] });
export type DecisionChoice = z.infer<typeof DecisionChoice>;

/** The rule that made a decision: `<selector>/<rule>`, lowercase words joined by hyphens, e.g. `due-review/wrong-first-try`. */
export const RuleId = z.string().max(100).regex(/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)+$/);

/**
 * A decision note to store: why School chose something, naming the rows that justify it (RFC 2 §3:
 * decisions are notes that name their evidence). `noteId` is the caller's, so a resend is stored
 * once. `evidence` is at least one distinct seq, each a row of the record in the choice's course.
 * `encounterId`, when given, is the encounter the choice was made for, in the same course and lesson.
 */
export const DecisionNoteInput = z.object({
  noteId: uuid,
  choice: DecisionChoice,
  encounterId: uuid.nullable(),
  rule: RuleId,
  reason: z.string().trim().min(1).max(2000),
  evidence: z.array(Seq).min(1).max(100).refine((s) => new Set(s).size === s.length, { message: "evidence names each row once" }),
});
export type DecisionNoteInput = z.infer<typeof DecisionNoteInput>;

/** A decision note as stored: never updated, and its evidence rows always precede it. */
export const DecisionNote = z.object({
  id: z.string(),
  seq: Seq,
  choice: z.object({ course: z.string(), lesson: z.string().nullable(), blockId: z.string().nullable() }),
  encounterId: z.string().nullable(),
  rule: z.string(),
  reason: z.string(),
  evidence: z.array(Seq),
  at: timestamp,
});
export type DecisionNote = z.infer<typeof DecisionNote>;

/**
 * `rejected`: a cited row does not exist, is not evidence (a snapshot or another note), or is
 * evidence of another course than the choice's; or the encounter named is not of the choice's
 * course and lesson, or does not hold its block. `conflict`: the note id already names another note.
 */
export const DecisionNoteResult = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["stored", "duplicate"]), note: DecisionNote }),
  z.object({ status: z.enum(["conflict", "rejected"]) }),
]);
export type DecisionNoteResult = z.infer<typeof DecisionNoteResult>;

// ---- Due review (RFC 2 §5; flyingrobots/school#32) --------------------------------------------

/**
 * Why a block came back: its latest weak first try was wrong; right, but after help shown for it in
 * that encounter; or right while School was not recording help, so its aid is unknown.
 */
export const ReviewRule = z.enum(["due-review/wrong-first-try", "due-review/aided-first-try", "due-review/unknown-aid"]);
export type ReviewRule = z.infer<typeof ReviewRule>;

/**
 * What to ask the selector: which of the course's quiz blocks could be shown, now, how long since a
 * block was last answered before it may return, and at most how many to return.
 */
export const DueReviewQuery = z.object({
  course: z.string().min(1).max(200),
  blocks: z.array(blockId).max(10_000),
  now: timestamp,
  delayMs: ms,
  limit: z.int().nonnegative().max(100),
});
export type DueReviewQuery = z.infer<typeof DueReviewQuery>;

/**
 * A block due for review, with the facts its reason is told from. `answeredAt` is the time of the
 * first try that decided it; `corrected`, for a wrong first try, whether a later answer in that
 * encounter was right; `shown`, the kinds of help among the evidence, each once, in the record's
 * order; `lastSeen`, the time of the block's latest answer; `evidence`, the rows a note cites, by seq.
 */
export const DueItem = z.object({
  blockId: z.string(),
  rule: ReviewRule,
  answeredAt: timestamp,
  corrected: z.boolean(),
  shown: z.array(ExposureKind),
  lastSeen: timestamp,
  evidence: z.array(Seq).min(1).max(100),
});
export type DueItem = z.infer<typeof DueItem>;

/** A decision note for a block put in a lesson for review: stored for the encounter that shows it. */
export type ReviewNote = { blockId: string; rule: string; reason: string; evidence: number[] };

/** A review item as the lesson page shows it: the block, the rule that chose it, and its reason in words. */
export const ReviewReason = z.object({ blockId: z.string(), rule: z.string(), reason: z.string() });
export type ReviewReason = z.infer<typeof ReviewReason>;

// ---- Installed courses (RFC 7 §7; flyingrobots/school#232) -------------------------------------

/**
 * A course's name, its progress key: a lowercase letter or digit, then lowercase letters, digits and
 * hyphens, and not one of the names School's own routes use. The same rule as NAME and RESERVED in
 * server/config.ts, which the core may not import; server/db/course-installs.test.ts holds the two,
 * and the record's CHECK, to agreement.
 */
export const COURSE_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const RESERVED_COURSE_NAMES = ["assets", "courses", "lessons", "reference", "api"] as const;
export const CourseName = z.string().regex(COURSE_NAME)
  .refine((n) => !(RESERVED_COURSE_NAMES as readonly string[]).includes(n), { message: "is reserved and cannot name a course" });

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A git commit's full hash: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
const commitHash = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
const installFields = {
  /** The caller's, so a resend is stored once. It also names the install's folder in the course store. */
  id: uuid,
  course: CourseName,
  commit: commitHash,
  /** SHA-256 of the installed files' manifest: one line per file, `<sha256 of the file> <path>`, sorted by path. */
  contentSha256: sha256,
  title: z.string().trim().min(1),
  /** The course format version its course.json declares (flyingrobots/school#209), or null when it declares none. */
  format: z.int().positive().nullable(),
};

/**
 * One install to record: a course fetched from a git repository at a commit, or read from an
 * uploaded git bundle. `url` is set exactly for `git`, and `bundleSha256` exactly for `bundle`.
 */
export const CourseInstall = z.discriminatedUnion("source", [
  z.object({ ...installFields, source: z.literal("git"), url: z.string().regex(/^https:\/\/\S+$/), bundleSha256: z.null() }),
  z.object({ ...installFields, source: z.literal("bundle"), url: z.null(), bundleSha256: sha256 }),
]);
export type CourseInstall = z.infer<typeof CourseInstall>;

/**
 * `installed`: the name had no current install. `updated`: it had one, and this one replaces it.
 * `duplicate`: this id already holds this same install. `conflict`: it holds another; the first stands.
 */
export const InstallResult = z.object({ status: z.enum(["installed", "updated", "duplicate", "conflict"]) });
export type InstallResult = z.infer<typeof InstallResult>;

/** `removed`: the course had a current install and now has none. `not-installed`: it had none; nothing was stored. */
export const RemovalResult = z.object({ status: z.enum(["removed", "not-installed"]) });
export type RemovalResult = z.infer<typeof RemovalResult>;

/** `stored`: the trust choice was appended. `rejected`: no install has that id; nothing was stored. */
export const TrustResult = z.object({ status: z.enum(["stored", "rejected"]) });
export type TrustResult = z.infer<typeof TrustResult>;

/**
 * A name's current install: its latest install with no later removal, when it was installed, and
 * whether the learner trusts it, by the latest trust choice for this install (none means untrusted).
 */
export const InstalledCourse = z.discriminatedUnion("source", [
  CourseInstall.options[0].extend({ at: timestamp, trusted: z.boolean() }),
  CourseInstall.options[1].extend({ at: timestamp, trusted: z.boolean() }),
]);
export type InstalledCourse = z.infer<typeof InstalledCourse>;
