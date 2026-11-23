// The Postgres adapter of the LearningRecord port (RFC 3, §4; flyingrobots/school#46).
//
// It holds no SQL that reads or writes a table: every method is one call of a function from
// the migrations (server/db/migrations/), `SELECT * FROM school.<function>(...)`,
// which school_app, the role it connects as, may EXECUTE and nothing more. The rules (correctness
// from the snapshot, first try, resume, append-only) are the functions'; this module hands them
// their inputs and parses every value that comes back with the core's Zod schemas, so a driver
// returning the wrong shape fails here, loudly.
//
// Time: `at` is the caller's (the Clock's), passed as an ISO string. Times come back as
// timestamptz columns, which a driver parses to a Date, or inside jsonb as school.iso text; both
// end as the model's ISO form, 2026-11-21T10:00:00.000Z.
import { z } from "zod";
import {
  Aid, Block, DecisionNote, DecisionNoteResult, Encounter, EvidenceKind, EvidenceRow, ExplanationState, ExposureResult, Grading,
  LessonProgress, Recorded, SaveResult, Seq, SubmitResult, type ExplainBlock,
} from "../core/model.ts";
import type { LearningRecord } from "../core/ports.ts";
import { canonical } from "../record.ts";
import type { Sql } from "./sql.ts";

/** A timestamptz column, as the model's ISO string. Microseconds cannot arise: every `at` stored came in as milliseconds. */
const time = z.date().transform((d) => d.toISOString());

const Opened = z.object({ id: z.string(), hash: z.string(), resumed: z.boolean() });
const Submitted = z.object({ status: z.string(), correct: z.boolean().nullable(), first_try: z.boolean().nullable() });
const Answer = z.object({ block_id: z.string(), choice_id: z.string(), correct: z.boolean() });
const Explained = z.object({ submission_id: z.string(), block_id: z.string(), text: z.string(), at: time, grading: Grading.nullable() });
const ExplanationRow = Explained.extend({ block: Block });
/** A bigint column: PGlite may return a number or a bigint, Bun.SQL a string. All end as the model's Seq. */
const bigint = z.union([z.number(), z.bigint(), z.string().regex(/^[0-9]+$/)]).transform(Number).pipe(Seq);
const Evidence = z.object({ seq: bigint, kind: EvidenceKind, block_id: z.string().nullable() });
const Noted = z.object({ status: z.string(), note: DecisionNote.nullable() });
const NoteRow = z.object({ note: DecisionNote });

/** `SELECT * FROM school.fn($1, ..., $n)`: the only statement shape this adapter issues. */
const call = (fn: string, args: readonly unknown[]) =>
  `SELECT * FROM school.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`;

export function postgresRecord(sql: Sql): LearningRecord {
  const rows = async (fn: string, ...args: unknown[]) => sql.query(call(fn, args), args);
  const one = async (fn: string, ...args: unknown[]) => {
    const r = await rows(fn, ...args);
    if (r.length !== 1) throw new Error(`school.${fn} returned ${r.length} rows, not exactly one row`);
    return r[0]!;
  };
  /** A scalar function's value: its one row's one column, named after the function. */
  const value = async (fn: string, ...args: unknown[]) => (await one(fn, ...args))[fn];

  const state = (x: z.infer<typeof Explained>) => ExplanationState.parse({
    submissionId: x.submission_id, blockId: x.block_id, text: x.text, at: x.at, grading: x.grading,
  });

  return {
    // aid_tracking is the caller's: the capture version its client declared, or NULL (not observed).
    openEncounter: async (o) =>
      Encounter.parse(Opened.parse(await one("open_encounter", o.course, o.lesson, canonical(o.page), o.now, o.aidTracking))),

    submit: async (s, now) => {
      const r = Submitted.parse(await one("submit", s.submissionId, s.encounterId, s.blockId, s.choiceId, s.ms, now));
      return SubmitResult.parse(r.status === "stored" || r.status === "duplicate"
        ? { status: r.status, correct: r.correct, firstTry: r.first_try }
        : { status: r.status });
    },

    encounterAnswers: async (encounterId) =>
      (await rows("encounter_answers", encounterId)).map((row) => {
        const a = Answer.parse(row);
        return Recorded.parse({ blockId: a.block_id, choiceId: a.choice_id, correct: a.correct });
      }),

    lessonProgress: async (course) => LessonProgress.parse(await value("lesson_progress", course)),

    saveExplanation: async (s, now) =>
      SaveResult.parse({ status: await value("save_explanation", s.submissionId, s.encounterId, s.blockId, s.text, s.ms, now) }),

    explanation: async (submissionId) => {
      const r = await rows("explanation", submissionId);
      if (r.length === 0) return null;
      if (r.length > 1) throw new Error(`school.explanation returned ${r.length} rows for one submission`);
      const x = ExplanationRow.parse(r[0]);
      if (x.block.type !== "explain") throw new Error(`explanation ${submissionId} answers a ${x.block.type} block, not an explain block`);
      return { state: state(x), block: x.block satisfies ExplainBlock };
    },

    // The jsonb arguments go as values, not JSON text: a driver serialises a value for a jsonb
    // parameter, and Bun.SQL sends a string as a JSON string, so "[]" would arrive as the string
    // "[]", not an array. PGlite and Bun.SQL agree on values (server/adapters/bunsql.test.ts).
    recordGrading: async (g, now) => Grading.parse(await value("record_grading",
      g.submissionId, g.status, g.rubricVersion, g.promptVersion, g.adapter, g.model, g.sources,
      g.raw, g.findings, g.error, now)),

    encounterExplanations: async (encounterId) =>
      (await rows("encounter_explanations", encounterId)).map((row) => state(Explained.parse(row))),

    recordView: async (v, now) => void await one("record_view", v.course, v.lesson, now),

    recordsExposures: true,

    recordExposure: async (e, now) =>
      ExposureResult.parse({ status: await value("record_exposure", e.exposureId, e.encounterId, e.blockId, e.kind, now) }),

    aid: async (submissionId) => {
      const r = await rows("submission_aid", submissionId);
      if (r.length === 0) return null;
      if (r.length > 1) throw new Error(`school.submission_aid returned ${r.length} rows: an answer and an explanation share submission ${submissionId}`);
      return Aid.parse(r[0]!.aid);
    },

    encounterEvidence: async (encounterId) =>
      (await rows("encounter_evidence", encounterId)).map((row) => {
        const x = Evidence.parse(row);
        return EvidenceRow.parse({ seq: x.seq, kind: x.kind, blockId: x.block_id });
      }),

    // evidence goes as a value for its jsonb parameter, like a grading's sources.
    recordDecisionNote: async (n, now) => {
      const r = Noted.parse(await one("record_decision_note", n.noteId, n.choice.course, n.choice.lesson, n.choice.blockId,
        n.encounterId, n.rule, n.reason, n.evidence, now));
      return DecisionNoteResult.parse(r.status === "stored" || r.status === "duplicate" ? { status: r.status, note: r.note } : { status: r.status });
    },

    decisionNotes: async (c) =>
      (await rows("choice_decision_notes", c.course, c.lesson, c.blockId)).map((row) => NoteRow.parse(row).note),

    encounterDecisionNotes: async (encounterId) =>
      (await rows("encounter_decision_notes", encounterId)).map((row) => NoteRow.parse(row).note),
  };
}
