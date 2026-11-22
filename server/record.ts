// The learning record (RFC 1, "The learning record contract"; ADR 9).
//
// The learner must never lose progress, and School's SQLite database is the only place it is
// kept. So the rules live in the database: an answer's correctness and whether it was a first
// try are derived by the INSERT itself, from the stored snapshot of what the learner was shown,
// and triggers make every table of progress append-only (migrate.ts, RULES). This module only
// hands the database its inputs. Nothing the browser says about correctness is trusted.
import type { Database } from "bun:sqlite";
import type { Block } from "./blocks.ts";

/**
 * How long after its last activity an encounter resumes rather than a new one starting. A reload,
 * a dropped connection or a phone tab coming back to the foreground all fall inside it, so they
 * do not reset first try. Coming back after a gap longer than this is a new encounter, and its
 * first answers are first tries again: that is spaced retrieval, which is the point.
 */
export const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/** JSON with object keys sorted at every depth, so equal content always hashes equally. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export type Encounter = { id: string; hash: string; resumed: boolean };

/**
 * The encounter a web page is served in. Stores the resolved page as a snapshot (once per
 * distinct content), then resumes the latest encounter of this lesson with this exact content
 * whose last activity is inside the resume window, or opens a new one. Atomic.
 */
export function openEncounter(db: Database, o: { course: string; lesson: string; page: Block; now: string }): Encounter {
  const content = canonical(o.page);
  const hash = sha256(content);
  const cutoff = new Date(Date.parse(o.now) - RESUME_WINDOW_MS).toISOString();
  return db.transaction((): Encounter => {
    db.query("INSERT INTO snapshots (hash, content, at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING").run(hash, content, o.now);
    const open = db.query<{ id: string }, [string, string, string, string]>(`
      SELECT e.id FROM encounters e
      WHERE e.course = ?1 AND e.lesson = ?2 AND e.view = 'web' AND e.snapshot_hash = ?3
        AND max(e.at, coalesce((SELECT max(a.at) FROM answers a WHERE a.encounter_id = e.id), e.at)) >= ?4
      ORDER BY e.at DESC LIMIT 1`).get(o.course, o.lesson, hash, cutoff);
    if (open !== null) return { id: open.id, hash, resumed: true };
    const id = crypto.randomUUID();
    db.query("INSERT INTO encounters (id, course, lesson, view, snapshot_hash, at) VALUES (?, ?, ?, 'web', ?, ?)")
      .run(id, o.course, o.lesson, hash, o.now);
    return { id, hash, resumed: false };
  }).immediate();
}

export type Submission = { submissionId: string; encounterId: string; blockId: string; choiceId: string; ms: number };

export type SubmitResult =
  | { status: "stored" | "duplicate"; correct: boolean; firstTry: boolean }
  | { status: "conflict" } // that submission id already names a different answer
  | { status: "rejected" }; // no such encounter, or that block and choice are not in its snapshot

type Row = { encounter_id: string; block_id: string; choice_id: string; correct: number; first_try: number };

/**
 * One statement does the work. It finds the quiz and choice inside the encounter's snapshot,
 * takes `correct` and the displayed wording from there, and sets `first_try` when the
 * encounter holds no earlier answer to that block. If the snapshot has no such choice, the
 * SELECT yields no row and nothing is inserted. A resent submission id hits the unique index
 * and inserts nothing.
 */
const INSERT = `
WITH e AS (SELECT id, course, lesson, snapshot_hash FROM encounters WHERE id = $encounter),
     q AS (SELECT t.value AS quiz FROM e JOIN snapshots s ON s.hash = e.snapshot_hash, json_tree(s.content) t
           WHERE t.type = 'object' AND json_extract(t.value, '$.type') = 'quiz' AND json_extract(t.value, '$.id') = $block
           LIMIT 1),
     c AS (SELECT json_extract(ch.value, '$.text') AS text, json_extract(ch.value, '$.correct') AS correct
           FROM q, json_each(q.quiz, '$.choices') ch WHERE json_extract(ch.value, '$.id') = $choice)
INSERT INTO answers (origin, course, block_id, lesson, choice, correct, first_try, ms, at, encounter_id, choice_id, submission_id)
SELECT 'block', e.course, $block, e.lesson, c.text, c.correct,
       NOT EXISTS (SELECT 1 FROM answers a WHERE a.encounter_id = e.id AND a.block_id = $block),
       $ms, $at, e.id, $choice, $submission
FROM e, c
WHERE true
ON CONFLICT (submission_id) DO NOTHING`;

export function submit(db: Database, s: Submission, now: string): SubmitResult {
  return db.transaction((): SubmitResult => {
    const existing = () => db.query<Row, [string]>(
      "SELECT encounter_id, block_id, choice_id, correct, first_try FROM answers WHERE submission_id = ?").get(s.submissionId);
    const before = existing();
    if (before === null) {
      db.query(INSERT).run({ encounter: s.encounterId, block: s.blockId, choice: s.choiceId, ms: s.ms, at: now, submission: s.submissionId });
    }
    const row = existing();
    if (row === null) return { status: "rejected" };
    if (row.encounter_id !== s.encounterId || row.block_id !== s.blockId || row.choice_id !== s.choiceId) return { status: "conflict" };
    return { status: before === null ? "stored" : "duplicate", correct: row.correct === 1, firstTry: row.first_try === 1 };
  }).immediate();
}

export type Recorded = { blockId: string; choiceId: string; correct: boolean };

/** What the learner has already answered in this encounter, oldest first, so a reload can show it. */
export function encounterAnswers(db: Database, encounterId: string): Recorded[] {
  return db.query<{ block_id: string; choice_id: string; correct: number }, [string]>(
    "SELECT block_id, choice_id, correct FROM answers WHERE encounter_id = ? ORDER BY id").all(encounterId)
    .map((r) => ({ blockId: r.block_id, choiceId: r.choice_id, correct: r.correct === 1 }));
}

/** For each lesson of a course, the quizzes ever answered correctly there. */
export function lessonProgress(db: Database, course: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const rows = db.query<{ lesson: string; block_id: string }, [string]>(`
    SELECT DISTINCT lesson, block_id FROM answers
    WHERE course = ? AND origin = 'block' AND correct = 1`).all(course);
  for (const r of rows) out.set(r.lesson, (out.get(r.lesson) ?? new Set()).add(r.block_id));
  return out;
}
