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
 * its snapshot. `unsupported`: this record cannot store exposures at all (the SQLite adapter).
 */
export const ExposureResult = z.object({ status: z.enum(["stored", "duplicate", "conflict", "rejected", "unsupported"]) });
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
