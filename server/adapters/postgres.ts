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
  CourseInstall, Aid, Block, DecisionNote, InstallResult, InstalledCourse, RemovalResult, TrustResult, DecisionNoteResult, DueItem, Encounter, EvidenceKind, EvidenceRow, ExplanationState, ExposureResult, Grading,
  Findings, LastStudied, LatestFeedback, LessonProgress, Mastery, Recorded, SaveResult, Seq, StudyDay, SubmitResult, type ExplainBlock,
} from "../core/model.ts";
import type { LearningRecord } from "../core/ports.ts";
import type { Sql } from "./sql.ts";

/**
 * The page as JSON with object keys sorted at every depth, so equal content always hashes equally.
 * `school.open_encounter` stores this text as the snapshot and hashes it (SHA-256), and the
 * `snapshots_hash` check holds the hash to it. It lived in server/record.ts, as the comments in
 * 0001_init.sql still say, until SQLite was deleted (flyingrobots/school#49); an applied migration
 * is never edited, so those comments keep the old name.
 */
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
const OpenedLesson = Opened.extend({ content: Block });
const Due = z.object({ item: DueItem });
const Held = z.object({ item: Mastery });
const Studied = z.object({ course: z.string(), lesson: z.string(), at: time });
const InstalledRow = z.object({
  id: z.string(), course: z.string(), source: z.string(), url: z.string().nullable(), bundle_sha256: z.string().nullable(), commit: z.string(),
  content_sha256: z.string(), title: z.string(), format: z.number().nullable(), at: time, trusted: z.boolean(),
});
const FeedbackRow = z.object({
  submission_id: z.string(), course: z.string(), lesson: z.string(), block_id: z.string(),
  model: z.string().nullable(), findings: Findings, at: time,
});

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

    // The notes go as a value for their jsonb parameter. The function finds the encounter by the
    // lesson as written, so the review it was opened with comes back on a reload.
    openLessonEncounter: async (o) => {
      const r = OpenedLesson.parse(await one("open_lesson_encounter", o.course, o.lesson, canonical(o.lessonPage), canonical(o.page),
        o.now, o.aidTracking, o.notes));
      return { encounter: Encounter.parse({ id: r.id, hash: r.hash, resumed: r.resumed }), page: r.content };
    },

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

    studyDays: async (q) => (await rows("study_days", q.from, q.to, q.tz)).map((row) => StudyDay.parse(row)),

    latestFeedback: async () => {
      const r = await rows("latest_feedback");
      if (r.length > 1) throw new Error(`school.latest_feedback returned ${r.length} rows, not at most one`);
      if (r.length === 0) return null;
      const f = FeedbackRow.parse(r[0]);
      return LatestFeedback.parse({ submissionId: f.submission_id, course: f.course, lesson: f.lesson, blockId: f.block_id, model: f.model, findings: f.findings, at: f.at });
    },

    timeZone: async () => {
      const z = await value("time_zone");
      if (z !== null && typeof z !== "string") throw new Error("school.time_zone returned neither text nor null");
      return z;
    },

    chooseTimeZone: async (zone, now) => {
      await value("choose_time_zone", zone, now);
    },

    // Parsed first, as installedCourses reads every row back through the same model: a title the
    // model trims is stored trimmed, and one it refuses never reaches the table.
    installCourse: async (input, now) => {
      const i = CourseInstall.parse(input);
      return InstallResult.parse({ status: await value("install_course",
        i.id, i.course, i.source, i.url, i.bundleSha256, i.commit, i.contentSha256, i.title, i.format, now) });
    },

    removeInstalledCourse: async (course, now) => RemovalResult.parse({ status: await value("remove_installed_course", course, now) }),

    chooseCourseTrust: async (installId, trusted, now) =>
      TrustResult.parse({ status: await value("choose_course_trust", installId, trusted, now) }),

    installedCourses: async () =>
      (await rows("installed_courses")).map((row) => {
        const c = InstalledRow.parse(row);
        return InstalledCourse.parse({ id: c.id, course: c.course, source: c.source, url: c.url, bundleSha256: c.bundle_sha256, commit: c.commit,
          contentSha256: c.content_sha256, title: c.title, format: c.format, at: c.at, trusted: c.trusted });
      }),

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

    recordExposure: async (e, now) =>
      ExposureResult.parse({ status: await value("record_exposure", e.exposureId, e.encounterId, e.blockId, e.kind, now) }),
    recordLessonHelp: async (h, now) =>
      ExposureResult.parse({ status: await value("record_lesson_help", h.exposureId, h.encounterId, h.kind, now) }),

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

    // blocks goes as a value for its jsonb parameter, like a note's evidence.
    dueReview: async (q) =>
      (await rows("due_review", q.course, q.blocks, q.now, q.delayMs, q.limit)).map((row) => Due.parse(row).item),

    // blocks goes as a value for its jsonb parameter, as for due review.
    mastery: async (q) =>
      (await rows("mastery", q.course, q.blocks, q.now, q.delayMs)).map((row) => Held.parse(row).item),
  };
}
