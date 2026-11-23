// Migration 0004 on PGlite: decision notes, append-only and checked against the evidence they cite
// (RFC 2 §3 and §5; flyingrobots/school#31). Behaviour through the port is the contract's
// (server/contract/learning-record.ts); these are the SQL-level facts the port cannot see.
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "./migrate.ts";

const SLOW = 30_000;

const at = (ms = 0) => new Date(Date.parse("2001-02-03T04:05:06.789Z") + ms).toISOString();
const uuid = () => crypto.randomUUID();
const PAGE = JSON.stringify({ type: "page", id: "l1", title: "l1", subtitle: "", children: [
  { type: "quiz", id: "q1", q: "?", why: ".", choices: [{ id: "a", text: "A", correct: true }] },
] });

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}

type Recorded = { status: string; note: { seq: number; evidence: number[] } | null };
/** record_decision_note as school_app, for a block choice c/l1/q1 with no encounter. */
const record = (db: PGlite, evidence: unknown, o: { course?: string; id?: string } = {}) => as(db, "school_app", async () =>
  (await db.query<Recorded>("SELECT * FROM school.record_decision_note($1, $2, 'l1', 'q1', NULL, 'due-review/wrong-first-try', 'Because.', $3, $4)",
    [o.id ?? uuid(), o.course ?? "c", evidence, at(9)])).rows[0]!);

/** A migrated database with an encounter of course c and a view of course c and of course other; their seqs. */
async function seeded(): Promise<{ db: PGlite; encounter: string; seq: { snapshot: number; encounter: number; view: number; otherView: number } }> {
  const db = new PGlite();
  await migrate(db);
  const encounter = await as(db, "school_app", async () => {
    const id = (await db.query<{ id: string }>("SELECT * FROM school.open_encounter('c', 'l1', $1, $2, 1)", [PAGE, at()])).rows[0]!.id;
    await db.query("SELECT school.record_view('c', 'l1', $1)", [at(1)]);
    await db.query("SELECT school.record_view('other', 'l1', $1)", [at(2)]);
    return id;
  });
  const seq = await as(db, "school_owner", async () => ({
    snapshot: (await db.query<{ s: number }>("SELECT seq::int AS s FROM school.snapshots")).rows[0]!.s,
    encounter: (await db.query<{ s: number }>("SELECT seq::int AS s FROM school.encounters")).rows[0]!.s,
    view: (await db.query<{ s: number }>("SELECT seq::int AS s FROM school.views WHERE course = 'c'")).rows[0]!.s,
    otherView: (await db.query<{ s: number }>("SELECT seq::int AS s FROM school.views WHERE course = 'other'")).rows[0]!.s,
  }));
  return { db, encounter, seq };
}

test("a view of the choice's course is evidence; another course's view and a snapshot are not", async () => {
  const { db, seq } = await seeded();
  expect((await record(db, [seq.view])).status).toBe("stored");
  expect((await record(db, [seq.otherView])).status).toBe("rejected");
  expect((await record(db, [seq.otherView], { course: "other" })).status).toBe("stored");
  expect((await record(db, [seq.snapshot])).status).toBe("rejected");
}, SLOW);

test("evidence that is not a non-empty array of distinct positive integers is refused, and stores nothing", async () => {
  const { db, seq } = await seeded();
  for (const bad of [[], {}, seq.encounter, [String(seq.encounter)], [seq.encounter + 0.5], [0], [-1], [null], [seq.encounter, seq.encounter], null]) {
    expect(`${JSON.stringify(bad)}: ${(await record(db, bad)).status}`).toBe(`${JSON.stringify(bad)}: rejected`);
  }
  expect(await as(db, "school_owner", async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM school.decision_notes")).rows[0]!.n)).toBe(0);
}, SLOW);

test("the table itself refuses a note with no evidence, evidence after it, or a block outside a lesson, even from the owner", async () => {
  const { db, seq } = await seeded();
  const insert = (lesson: string | null, block: string | null, evidence: string) => as(db, "school_owner", () => db.query(
    `INSERT INTO school.decision_notes (note_id, course, lesson, block_id, rule, reason, evidence, at)
     VALUES ($1, 'c', $2, $3, 'due-review/wrong-first-try', 'Because.', ${evidence}, $4)`, [uuid(), lesson, block, at(9)]));
  await expect(insert("l1", "q1", "'{}'::bigint[]")).rejects.toThrow("decision_notes_evidence");
  await expect(insert("l1", "q1", `ARRAY[${seq.encounter}, NULL]::bigint[]`)).rejects.toThrow("decision_notes_evidence");
  await expect(insert("l1", "q1", "ARRAY[1000000000]::bigint[]")).rejects.toThrow("decision_notes_evidence_precedes");
  await expect(insert(null, "q1", `ARRAY[${seq.encounter}]::bigint[]`)).rejects.toThrow("decision_notes_block_in_lesson");
  await insert("l1", "q1", `ARRAY[${seq.encounter}]::bigint[]`);
}, SLOW);

test("a rule id is <selector>/<rule> in lowercase words; anything else is refused by the table", async () => {
  const { db, seq } = await seeded();
  for (const rule of ["due-review", "Due-Review/x", "due review/x", "due-review/", "/x", "a/b c", "x".repeat(99) + "/y"]) {
    const msg = await as(db, "school_app", () => db.query(
      "SELECT * FROM school.record_decision_note($1, 'c', 'l1', 'q1', NULL, $2, 'Because.', $3, $4)", [uuid(), rule, [seq.encounter], at(9)])
      .then(() => "stored", (e: Error) => e.message));
    expect(`${rule}: ${msg}`).toContain("decision_notes_rule");
  }
}, SLOW);

test("an empty or blank reason is refused by the table", async () => {
  const { db, seq } = await seeded();
  for (const reason of ["", "   "]) {
    await expect(as(db, "school_app", () => db.query(
      "SELECT * FROM school.record_decision_note($1, 'c', 'l1', 'q1', NULL, 'due-review/x', $2, $3, $4)", [uuid(), reason, [seq.encounter], at(9)])))
      .rejects.toThrow("decision_notes_reason");
  }
}, SLOW);

test("a note id is unique in the table itself, not only in the function", async () => {
  const { db, seq } = await seeded();
  const id = uuid();
  expect((await record(db, [seq.encounter], { id })).status).toBe("stored");
  await expect(as(db, "school_owner", () => db.query(
    `INSERT INTO school.decision_notes (note_id, course, rule, reason, evidence, at) VALUES ($1, 'c', 'due-review/x', 'Because.', ARRAY[${seq.encounter}]::bigint[], $2)`,
    [id, at(10)]))).rejects.toThrow("decision_notes_note_id");
}, SLOW);
