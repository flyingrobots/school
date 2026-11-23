// The Postgres adapter of the LearningRecord port (RFC 3, §4; flyingrobots/school#46).
//
// It holds no SQL that reads or writes a table: every method is one call of a function from
// migration 0001 (server/db/migrations/0001_init.sql), `SELECT * FROM school.<function>(...)`,
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
  Aid, Block, Encounter, ExplanationState, ExposureResult, Grading, LastStudied, LessonProgress, Recorded, SaveResult, SubmitResult,
  type ExplainBlock,
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
const Studied = z.object({ course: z.string(), lesson: z.string(), at: time });

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

    lastStudied: async () => {
      const r = await rows("last_studied");
      if (r.length > 1) throw new Error(`school.last_studied returned ${r.length} rows, not at most one`);
      return r.length === 0 ? null : LastStudied.parse(Studied.parse(r[0]));
    },

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

    recordGrading: async (g, now) => Grading.parse(await value("record_grading",
      g.submissionId, g.status, g.rubricVersion, g.promptVersion, g.adapter, g.model, JSON.stringify(g.sources),
      g.raw, g.findings === null ? null : JSON.stringify(g.findings), g.error, now)),

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
  };
}
