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

/**
 * Help a model wrote for the learner about a lesson, shown in one encounter (RFC 6 §5.1): one
 * exposure for the whole encounter, with no block, recorded by the server and never by the page.
 */
export const LessonHelpKind = z.enum(["ai-help"]);
export type LessonHelpKind = z.infer<typeof LessonHelpKind>;

/** Help for a whole encounter. `exposureId` names it once, as an exposure's does. */
export const LessonHelp = z.object({ exposureId: uuid, encounterId: uuid, kind: LessonHelpKind });
export type LessonHelp = z.infer<typeof LessonHelp>;

/** Every kind of exposure the record holds: the page's, and the server's help for a whole encounter. */
export const RecordedExposureKind = z.enum([...ExposureKind.options, ...LessonHelpKind.options]);
export type RecordedExposureKind = z.infer<typeof RecordedExposureKind>;

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
 * that encounter; or right while School was not recording help, so its aid is unknown. Or, ranked
 * after those three, it had settled and its mastery has faded below one half (RFC 5 §4.6).
 */
export const ReviewRule = z.enum(["due-review/wrong-first-try", "due-review/aided-first-try", "due-review/unknown-aid", "due-review/faded"]);
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
  shown: z.array(RecordedExposureKind),
  lastSeen: timestamp,
  evidence: z.array(Seq).min(1).max(100),
});
export type DueItem = z.infer<typeof DueItem>;

/** A decision note for a block put in a lesson for review: stored for the encounter that shows it. */
export type ReviewNote = { blockId: string; rule: string; reason: string; evidence: number[] };

/** A review item as the lesson page shows it: the block, the rule that chose it, and its reason in words. */
export const ReviewReason = z.object({ blockId: z.string(), rule: z.string(), reason: z.string() });
export type ReviewReason = z.infer<typeof ReviewReason>;

// ---- Mastery (RFC 5 §4.1, §4.2; flyingrobots/school#217) ---------------------------------------

/**
 * What to ask the measure: which of the course's quiz blocks, at what time, and how long after a
 * block was last answered a clean first try must come to count as a review that lengthens it.
 */
export const MasteryQuery = z.object({
  course: z.string().min(1).max(200),
  blocks: z.array(blockId).max(10_000),
  now: timestamp,
  delayMs: ms,
});
export type MasteryQuery = z.infer<typeof MasteryQuery>;

/**
 * How well one quiz is held at the query's time (RFC 5 Table 4.1). `stabilityMs` is its half-life;
 * `strength`, from 0 to 1, is how far through that half-life it is since `refreshedAt`, the time of
 * its latest right first try, and 0 while its latest first try is wrong. Strength is not a
 * probability of recall. `settled` is due review's clearing rule; `evidence` the first tries the
 * value rests on, by seq. A quiz never answered has null strength, stability and refresh time, has
 * not settled, and cites nothing.
 */
export const Mastery = z.object({
  blockId: z.string(),
  strength: z.number().min(0).max(1).nullable(),
  stabilityMs: z.number().positive().nullable(),
  refreshedAt: timestamp.nullable(),
  settled: z.boolean(),
  evidence: z.array(Seq).max(100),
});
export type Mastery = z.infer<typeof Mastery>;

/**
 * What to ask the rollup (RFC 5 §4.5): the course, groups from a key (a lesson, or the whole
 * course) to quiz block ids, and the time and delay as for the measure. A block may sit in more than
 * one group, and counts in each.
 */
export const MasteryRollupQuery = z.object({
  course: z.string().min(1).max(200),
  groups: z.record(z.string().min(1).max(200), z.array(blockId).max(10_000)),
  now: timestamp,
  delayMs: ms,
});
export type MasteryRollupQuery = z.infer<typeof MasteryRollupQuery>;

/**
 * How one group of quizzes is held at the query's time (RFC 5 Table 4.5). `quizzes` is the number
 * of distinct blocks in the group, and the four counts partition them: never answered, answered but
 * not settled, settled with strength one half or more, settled with strength below one half.
 * `strength` is the mean strength over the group, a quiz not started counting 0, and null for an
 * empty group; it is for ranking, never for display.
 */
export const MasteryRollup = z.object({
  key: z.string(),
  quizzes: z.int().nonnegative(),
  notStarted: z.int().nonnegative(),
  settling: z.int().nonnegative(),
  holding: z.int().nonnegative(),
  faded: z.int().nonnegative(),
  strength: z.number().min(0).max(1).nullable(),
});
export type MasteryRollup = z.infer<typeof MasteryRollup>;

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
 * One install to record: a course fetched from a git repository at a commit, read from an uploaded
 * git bundle, or authored in School from an accepted draft (RFC 9 §5.5). `url` is set exactly for
 * `git`, and `bundleSha256` exactly for `bundle`. An `authored` install names the draft commit as
 * its `commit`, the install the draft was based on as `parentInstallId`, and the draft as `draftId`.
 */
export const CourseInstall = z.discriminatedUnion("source", [
  z.object({ ...installFields, source: z.literal("git"), url: z.string().regex(/^https:\/\/\S+$/), bundleSha256: z.null() }),
  z.object({ ...installFields, source: z.literal("bundle"), url: z.null(), bundleSha256: sha256 }),
  z.object({ ...installFields, source: z.literal("authored"), url: z.null(), bundleSha256: z.null(), parentInstallId: uuid, draftId: uuid }),
]);
export type CourseInstall = z.infer<typeof CourseInstall>;

/**
 * `installed`: the name had no current install. `updated`: it had one, and this one replaces it.
 * `duplicate`: this id already holds this same install. `conflict`: it holds another; the first stands.
 * For an `authored` install only, nothing stored: `stale`, its parent is no longer the name's current
 * install; `rejected`, its draft is not an undecided `ready` draft of a request on that parent under
 * this name, or another install already names it.
 */
export const InstallResult = z.object({ status: z.enum(["installed", "updated", "duplicate", "conflict", "stale", "rejected"]) });
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
  CourseInstall.options[2].extend({ at: timestamp, trusted: z.boolean() }),
]);
export type InstalledCourse = z.infer<typeof InstalledCourse>;

// ---- Authoring (RFC 9 §5.5; flyingrobots/school#258) ---------------------------------------------

/** The most characters (Unicode code points, as Postgres counts them) an authoring request's text may hold. */
export const AUTHORING_TEXT_MAX = 20_000;

/**
 * One authoring request to record, before the bridge is asked: what the author asked of `course`,
 * on which install (`baseInstallId`, which must be the course's current install), with which skill
 * (the SHA-256 of its manifest, RFC 9 §5.3) and which School.
 */
export const AuthoringRequest = z.object({
  /** The caller's, so a resend is stored once. */
  id: uuid,
  course: CourseName,
  baseInstallId: uuid,
  text: z.string().min(1).refine((t) => [...t].length <= AUTHORING_TEXT_MAX, { message: `is longer than ${AUTHORING_TEXT_MAX} characters` }),
  skillSha256: sha256,
  schoolVersion: z.string().min(1).max(200),
});
export type AuthoringRequest = z.infer<typeof AuthoringRequest>;

/**
 * `stored`. `duplicate`: this id already holds this same request. `conflict`: it holds another; the
 * first stands. `refused`: the base is not the course's current install; nothing was stored.
 */
export const AuthoringResult = z.object({ status: z.enum(["stored", "duplicate", "conflict", "refused"]) });
export type AuthoringResult = z.infer<typeof AuthoringResult>;

const tokens = z.int().nonnegative().nullable();
const draftFields = {
  /** The caller's, so a resend is stored once. It also names the draft's folder in the course store. */
  id: uuid,
  requestId: uuid,
  /** 1, or 2 for the one repair round after a refused first draft (RFC 9 Table 5.1). */
  round: z.union([z.literal(1), z.literal(2)]),
  /** Token counts the agent reported, or null when it reported none. */
  inputTokens: tokens,
  outputTokens: tokens,
};
const agent = z.string().min(1);
/**
 * One round of a request, recorded once it ends. A `ready` or `refused` draft was built: it names
 * the agent, the draft commit and its content digest, and a `refused` one keeps the check's message.
 * A `failed` one was not built (the agent failed or ran out of time), and may name no agent.
 */
export const AuthoringDraft = z.discriminatedUnion("status", [
  z.object({ ...draftFields, status: z.literal("ready"), agent, commit: commitHash, contentSha256: sha256, checkMessage: z.null() }),
  z.object({ ...draftFields, status: z.literal("refused"), agent, commit: commitHash, contentSha256: sha256, checkMessage: z.string().min(1) }),
  z.object({ ...draftFields, status: z.literal("failed"), agent: agent.nullable(), commit: z.null(), contentSha256: z.null(), checkMessage: z.null() }),
]);
export type AuthoringDraft = z.infer<typeof AuthoringDraft>;

/**
 * `stored`. `duplicate`: this id already holds this same draft. `conflict`: it holds another; the
 * first stands. `rejected`, nothing stored: no request has that id, or the round is not the
 * request's next one (round 1 when it has none; round 2 only after a `refused` round 1).
 */
export const DraftResult = z.object({ status: z.enum(["stored", "duplicate", "conflict", "rejected"]) });
export type DraftResult = z.infer<typeof DraftResult>;

/**
 * The author's decision on a draft, once per draft. `accepted` names the `authored` install the
 * draft became, and keeps the draft's patch (`git format-patch` of the draft commit) so the
 * install can be rebuilt from the record (RFC 9 §5.4).
 */
export const AuthoringDecision = z.discriminatedUnion("decision", [
  z.object({ id: uuid, draftId: uuid, decision: z.literal("accepted"), installId: uuid, patch: z.string().min(1) }),
  z.object({ id: uuid, draftId: uuid, decision: z.literal("discarded"), installId: z.null(), patch: z.null() }),
]);
export type AuthoringDecision = z.infer<typeof AuthoringDecision>;

/**
 * `stored`. `duplicate`: this id already holds this same decision. `conflict`: it holds another; the
 * first stands. Nothing stored for the rest: `already-decided`, the draft has a decision;
 * `not-ready`, an accept of a draft that is not `ready`; `stale`, an accept whose install is no
 * longer the course's current one; `rejected`, no draft has that id, or an accept's install is not
 * this draft's `authored` install.
 */
export const DecisionResult = z.object({ status: z.enum(["stored", "duplicate", "conflict", "already-decided", "not-ready", "stale", "rejected"]) });
export type DecisionResult = z.infer<typeof DecisionResult>;

/** A decision as recorded. */
export const RecordedDecision = z.discriminatedUnion("decision", [
  AuthoringDecision.options[0].omit({ draftId: true }).extend({ at: timestamp }),
  AuthoringDecision.options[1].omit({ draftId: true }).extend({ at: timestamp }),
]);
export type RecordedDecision = z.infer<typeof RecordedDecision>;

/** A draft as recorded, with its decision, or null while it has none. */
export const RecordedDraft = z.discriminatedUnion("status", [
  AuthoringDraft.options[0].omit({ requestId: true }).extend({ at: timestamp, decision: RecordedDecision.nullable() }),
  AuthoringDraft.options[1].omit({ requestId: true }).extend({ at: timestamp, decision: RecordedDecision.nullable() }),
  AuthoringDraft.options[2].omit({ requestId: true }).extend({ at: timestamp, decision: RecordedDecision.nullable() }),
]);
export type RecordedDraft = z.infer<typeof RecordedDraft>;

/** A request as recorded, with its drafts in the record's order. */
export const RecordedRequest = AuthoringRequest.extend({ at: timestamp, drafts: z.array(RecordedDraft) });
export type RecordedRequest = z.infer<typeof RecordedRequest>;

/**
 * What the record already holds under a course name (RFC 7 §5.2, flyingrobots/school#237): its
 * encounters, the quiz answers and explanations given in them, and its recorded views. A name with
 * all four zero has no progress; any other is progress an install under that name would continue.
 */
export const CourseProgress = z.object({
  encounters: z.int().nonnegative(), answers: z.int().nonnegative(), explanations: z.int().nonnegative(), views: z.int().nonnegative(),
});
export type CourseProgress = z.infer<typeof CourseProgress>;
