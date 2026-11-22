// Explanations and their gradings (RFC 1 proposal 4; flyingrobots/school#10).
//
// The lifecycle: an explanation is saved first, as a submission, before anything is sent to a
// model. Grading is a separate, manual step; each attempt is stored whether it succeeds or
// fails, a failure is never an educational verdict, and a retry adds a row that names the one
// it supersedes. What the grader judged against comes from the encounter's snapshot, so a later
// edit to the lesson cannot change what an explanation was graded on.
import type { Database } from "bun:sqlite";
import type { Block, Source } from "./blocks.ts";
import { PROMPT_VERSION, RUBRIC_VERSION, checkQuotes, type CheckedFindings, type GradingInput, type Outcome } from "./grade.ts";

export type ExplanationSubmission = { submissionId: string; encounterId: string; blockId: string; text: string; ms: number };
export type SaveResult = { status: "stored" | "duplicate" | "conflict" | "rejected" };

type ExplainBlock = Extract<Block, { type: "explain" }>;

/** The explain block with this id inside a stored snapshot, or null. */
function findExplain(content: string, blockId: string): ExplainBlock | null {
  const walk = (b: Block): ExplainBlock | null => {
    if (b.type === "explain" && b.id === blockId) return b;
    if (b.type === "page" || b.type === "section") for (const c of b.children) { const f = walk(c); if (f) return f; }
    return null;
  };
  return walk(JSON.parse(content) as Block);
}

function encounterBlock(db: Database, encounterId: string, blockId: string) {
  const e = db.query<{ course: string; lesson: string; content: string }, [string]>(
    "SELECT e.course, e.lesson, s.content FROM encounters e JOIN snapshots s ON s.hash = e.snapshot_hash WHERE e.id = ?").get(encounterId);
  if (e === null) return null;
  const block = findExplain(e.content, blockId);
  return block === null ? null : { course: e.course, lesson: e.lesson, block };
}

export function saveExplanation(db: Database, s: ExplanationSubmission, now: string): SaveResult {
  return db.transaction((): SaveResult => {
    const prior = db.query<{ encounter_id: string; block_id: string; text: string }, [string]>(
      "SELECT encounter_id, block_id, text FROM explanations WHERE submission_id = ?").get(s.submissionId);
    if (prior !== null) {
      const same = prior.encounter_id === s.encounterId && prior.block_id === s.blockId && prior.text === s.text;
      return { status: same ? "duplicate" : "conflict" };
    }
    const where = encounterBlock(db, s.encounterId, s.blockId);
    if (where === null) return { status: "rejected" };
    db.query(`INSERT INTO explanations (submission_id, encounter_id, block_id, course, lesson, text, ms, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(s.submissionId, s.encounterId, s.blockId, where.course, where.lesson, s.text, s.ms, now);
    return { status: "stored" };
  }).immediate();
}

export type Grading =
  | { id: number; status: "succeeded"; findings: CheckedFindings; model: string | null; supersedes: number | null; at: string }
  | { id: number; status: "failed"; error: string; model: string | null; supersedes: number | null; at: string };

/** A grader: anything that turns an input into an outcome. `null` means none is configured. */
export type Grader = { adapter: string; model: string; grade: (input: GradingInput) => Promise<Outcome> } | null;

type GradingRow = { id: number; status: "succeeded" | "failed"; findings: string | null; error: string | null; model: string | null; supersedes: number | null; at: string };
const toGrading = (r: GradingRow): Grading => r.status === "succeeded"
  ? { id: r.id, status: "succeeded", findings: JSON.parse(r.findings!), model: r.model, supersedes: r.supersedes, at: r.at }
  : { id: r.id, status: "failed", error: r.error!, model: r.model, supersedes: r.supersedes, at: r.at };

/**
 * Run one grading attempt for a saved explanation and store it. Returns null, without calling
 * the grader, when there is no such explanation.
 */
export async function gradeExplanation(db: Database, submissionId: string, grader: Grader, now: string): Promise<Grading | null> {
  const x = db.query<{ encounter_id: string; block_id: string; text: string }, [string]>(
    "SELECT encounter_id, block_id, text FROM explanations WHERE submission_id = ?").get(submissionId);
  if (x === null) return null;
  const where = encounterBlock(db, x.encounter_id, x.block_id)!;
  const sources: Source[] = where.block.sources;
  const input: GradingInput = { prompt: where.block.prompt, modelAnswer: where.block.model, sources, explanation: x.text };

  // The network call happens outside any transaction: a slow grader must not hold the database.
  const outcome: Outcome = grader === null
    ? { status: "failed", error: "no bridge is configured (set SCHOOL_BRIDGE_URL and SCHOOL_BRIDGE_TOKEN)" }
    : await grader.grade(input);

  return db.transaction((): Grading => {
    const prev = db.query<{ id: number }, [string]>("SELECT max(id) AS id FROM gradings WHERE submission_id = ?").get(submissionId)?.id ?? null;
    const findings = outcome.status === "succeeded"
      ? JSON.stringify({ ...outcome.findings, contradictions: checkQuotes(outcome.findings.contradictions, sources, where.block.model) })
      : null;
    const row = db.query<GradingRow, (string | number | null)[]>(`INSERT INTO gradings
      (submission_id, status, rubric_version, prompt_version, adapter, model, sources, raw_response, findings, error, supersedes, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, status, findings, error, model, supersedes, at`).get(
      submissionId, outcome.status, RUBRIC_VERSION, PROMPT_VERSION, grader?.adapter ?? "none",
      outcome.model ?? (grader?.model || null), JSON.stringify(sources), outcome.raw ?? null, findings,
      outcome.status === "failed" ? outcome.error : null, prev, now)!;
    return toGrading(row);
  }).immediate();
}

export type ExplanationState = { submissionId: string; blockId: string; text: string; at: string; grading: Grading | null };

/** The latest explanation per block in this encounter, each with its latest grading, so a reload can show them. */
export function encounterExplanations(db: Database, encounterId: string): ExplanationState[] {
  const rows = db.query<{ submission_id: string; block_id: string; text: string; at: string }, [string]>(`
    SELECT submission_id, block_id, text, at FROM explanations x
    WHERE encounter_id = ? AND at = (SELECT max(at) FROM explanations y WHERE y.encounter_id = x.encounter_id AND y.block_id = x.block_id)
    ORDER BY at`).all(encounterId);
  return rows.map((r) => ({ submissionId: r.submission_id, blockId: r.block_id, text: r.text, at: r.at, grading: latestGrading(db, r.submission_id) }));
}

export function latestGrading(db: Database, submissionId: string): Grading | null {
  const r = db.query<GradingRow, [string]>(
    "SELECT id, status, findings, error, model, supersedes, at FROM gradings WHERE submission_id = ? ORDER BY id DESC LIMIT 1").get(submissionId);
  return r === null ? null : toGrading(r);
}

/** One saved explanation with its block, for re-rendering it after a save or a grading. */
export function explanationState(db: Database, submissionId: string): { state: ExplanationState; block: ExplainBlock } | null {
  const x = db.query<{ encounter_id: string; block_id: string; text: string; at: string }, [string]>(
    "SELECT encounter_id, block_id, text, at FROM explanations WHERE submission_id = ?").get(submissionId);
  if (x === null) return null;
  const where = encounterBlock(db, x.encounter_id, x.block_id);
  if (where === null) return null;
  return { block: where.block, state: { submissionId, blockId: x.block_id, text: x.text, at: x.at, grading: latestGrading(db, submissionId) } };
}
