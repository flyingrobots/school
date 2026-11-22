// The learning record contract (RFC 1; flyingrobots/school#2). The learner must never lose
// progress, and School's SQLite database is the only place progress is kept. These tests
// drive the database the way the server does, then try to break it.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "./blocks.ts";
import { SCHEMA_VERSION, migrate, shape } from "./migrate.ts";
import { RESUME_WINDOW_MS, canonical, encounterAnswers, lessonProgress, openEncounter, submit } from "./record.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "school-record-"));
  dirs.push(dir);
  const db = new Database(join(dir, "progress.db"), { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

const quiz = (id: string): Block => ({
  type: "quiz", id, q: "Which?", why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});
const lesson = (id: string, children: Block[], subtitle = ""): Block => ({ type: "page", id, title: id, subtitle, children });

const T0 = Date.parse("2026-11-21T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const uuid = () => crypto.randomUUID();
const count = (db: Database, table: string) => db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;

test("acceptance, same encounter: wrong, then right, then the phone resends the right answer", () => {
  const db = freshDb();
  const page = lesson("l1", [quiz("q1")]);
  const e = openEncounter(db, { course: "c", lesson: "l1", page, now: at(0) });

  const first = submit(db, { submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1000 }, at(1000));
  const rightId = uuid();
  const second = submit(db, { submissionId: rightId, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 2000 }, at(2000));
  const resent = submit(db, { submissionId: rightId, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 2000 }, at(3000));

  expect(first).toMatchObject({ status: "stored", correct: false, firstTry: true });
  expect(second).toMatchObject({ status: "stored", correct: true, firstTry: false });
  expect(resent).toMatchObject({ status: "duplicate", correct: true, firstTry: false });

  const rows = db.query<Record<string, unknown>, []>(
    `SELECT a.*, e.snapshot_hash FROM answers a JOIN encounters e ON e.id = a.encounter_id ORDER BY a.id`).all();
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.first_try)).toEqual([1, 0]);
  for (const r of rows) {
    for (const k of ["encounter_id", "snapshot_hash", "block_id", "choice_id", "submission_id"]) expect(r[k]).toBeTruthy();
  }
  // The displayed wording is kept beside the id, so the row reads on its own.
  expect(rows.map((r) => r.choice)).toEqual(["Wrong one", "Right one"]);
});

test("correctness comes from the snapshot, not from the client", () => {
  const db = freshDb();
  const e = openEncounter(db, { course: "c", lesson: "l1", page: lesson("l1", [quiz("q1")]), now: at(0) });
  const forged = { submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 5, correct: true };
  expect(submit(db, forged, at(1))).toMatchObject({ status: "stored", correct: false });
});

test("a reload within the resume window resumes the encounter, so first try does not reset", () => {
  const db = freshDb();
  const page = lesson("l1", [quiz("q1")]);
  const e1 = openEncounter(db, { course: "c", lesson: "l1", page, now: at(0) });
  submit(db, { submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1000));

  const e2 = openEncounter(db, { course: "c", lesson: "l1", page, now: at(60_000) });
  expect(e2).toMatchObject({ id: e1.id, resumed: true });
  const after = submit(db, { submissionId: uuid(), encounterId: e2.id, blockId: "q1", choiceId: "right", ms: 1 }, at(61_000));
  expect(after).toMatchObject({ firstTry: false });

  // And the page can show what was already answered.
  expect(encounterAnswers(db, e2.id).map((a) => a.choiceId)).toEqual(["wrong", "right"]);
});

test("the resume window runs from the last activity, and past it a new encounter starts", () => {
  const db = freshDb();
  const page = lesson("l1", [quiz("q1")]);
  const e1 = openEncounter(db, { course: "c", lesson: "l1", page, now: at(0) });
  submit(db, { submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(RESUME_WINDOW_MS - 1000));

  // Still inside the window measured from that answer, though past it measured from the serve.
  expect(openEncounter(db, { course: "c", lesson: "l1", page, now: at(RESUME_WINDOW_MS + 1000) }).id).toBe(e1.id);

  const later = openEncounter(db, { course: "c", lesson: "l1", page, now: at(3 * RESUME_WINDOW_MS) });
  expect(later.id).not.toBe(e1.id);
  expect(later.resumed).toBe(false);
  // A new encounter is a fresh first try: spaced retrieval is the point.
  expect(submit(db, { submissionId: uuid(), encounterId: later.id, blockId: "q1", choiceId: "right", ms: 1 }, at(3 * RESUME_WINDOW_MS + 1)))
    .toMatchObject({ firstTry: true });
});

test("an edited lesson gets a new snapshot and a new encounter; the old answers keep the old one", () => {
  const db = freshDb();
  const e1 = openEncounter(db, { course: "c", lesson: "l1", page: lesson("l1", [quiz("q1")]), now: at(0) });
  submit(db, { submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1));
  const e2 = openEncounter(db, { course: "c", lesson: "l1", page: lesson("l1", [quiz("q1")], "edited"), now: at(2) });
  expect(e2.hash).not.toBe(e1.hash);
  expect(e2.id).not.toBe(e1.id);
  expect(count(db, "snapshots")).toBe(2);
  expect(db.query<{ h: string }, []>("SELECT e.snapshot_hash AS h FROM answers a JOIN encounters e ON e.id = a.encounter_id").get()!.h).toBe(e1.hash);
});

test("the same content served twice is stored as one snapshot, whatever the key order", () => {
  const db = freshDb();
  const page = lesson("l1", [quiz("q1")]);
  const shuffled = JSON.parse(JSON.stringify({ children: page.type === "page" ? page.children : [], subtitle: "", title: "l1", id: "l1", type: "page" }));
  expect(canonical(shuffled)).toBe(canonical(page));
  openEncounter(db, { course: "c", lesson: "l1", page, now: at(0) });
  openEncounter(db, { course: "c", lesson: "l1", page: shuffled, now: at(10 * RESUME_WINDOW_MS) });
  expect(count(db, "snapshots")).toBe(1);
  expect(count(db, "encounters")).toBe(2);
});

test("a choice or block that is not in the encounter's snapshot is rejected and stores nothing", () => {
  const db = freshDb();
  const e = openEncounter(db, { course: "c", lesson: "l1", page: lesson("l1", [quiz("q1")]), now: at(0) });
  expect(submit(db, { submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "nope", ms: 1 }, at(1)).status).toBe("rejected");
  expect(submit(db, { submissionId: uuid(), encounterId: e.id, blockId: "q9", choiceId: "right", ms: 1 }, at(1)).status).toBe("rejected");
  expect(submit(db, { submissionId: uuid(), encounterId: uuid(), blockId: "q1", choiceId: "right", ms: 1 }, at(1)).status).toBe("rejected");
  expect(count(db, "answers")).toBe(0);
});

test("reusing a submission id for a different answer is a conflict, and the first answer stands", () => {
  const db = freshDb();
  const e = openEncounter(db, { course: "c", lesson: "l1", page: lesson("l1", [quiz("q1")]), now: at(0) });
  const id = uuid();
  submit(db, { submissionId: id, encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 1 }, at(1));
  expect(submit(db, { submissionId: id, encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(2)).status).toBe("conflict");
  expect(db.query<{ c: string }, []>("SELECT choice_id AS c FROM answers").all()).toEqual([{ c: "wrong" }]);
});

test("a resent submission stores exactly one row however many times it arrives", () => {
  const db = freshDb();
  const e = openEncounter(db, { course: "c", lesson: "l1", page: lesson("l1", [quiz("q1")]), now: at(0) });
  const s = { submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 };
  for (let i = 0; i < 50; i++) submit(db, s, at(i));
  expect(count(db, "answers")).toBe(1);
});

test("the database itself refuses to update or delete progress", () => {
  const db = freshDb();
  const e = openEncounter(db, { course: "c", lesson: "l1", page: lesson("l1", [quiz("q1")]), now: at(0) });
  submit(db, { submissionId: uuid(), encounterId: e.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1));
  expect(() => db.exec("UPDATE answers SET correct = 0")).toThrow(/append-only/);
  expect(() => db.exec("DELETE FROM answers")).toThrow(/append-only/);
  expect(() => db.exec("DELETE FROM encounters")).toThrow(/append-only/);
  expect(() => db.exec("UPDATE snapshots SET content = '{}'")).toThrow(/append-only/);
  expect(count(db, "answers")).toBe(1);
});

test("a recorded answer cannot omit its encounter, choice or submission", () => {
  const db = freshDb();
  expect(() => db.exec(`INSERT INTO answers (origin, course, block_id, lesson, choice, correct, first_try, ms, at, submission_id)
    VALUES ('block', 'c', 'q1', 'l1', 'x', 1, 1, 1, '2026-11-21', 'abc')`)).toThrow(/needs its encounter and choice/);
});

test("course progress counts each lesson's quizzes answered correctly, across encounters", () => {
  const db = freshDb();
  const page = lesson("l1", [quiz("q1"), quiz("q2")]);
  const e1 = openEncounter(db, { course: "c", lesson: "l1", page, now: at(0) });
  submit(db, { submissionId: uuid(), encounterId: e1.id, blockId: "q1", choiceId: "right", ms: 1 }, at(1));
  submit(db, { submissionId: uuid(), encounterId: e1.id, blockId: "q2", choiceId: "wrong", ms: 1 }, at(2));
  const e2 = openEncounter(db, { course: "c", lesson: "l1", page, now: at(10 * RESUME_WINDOW_MS) });
  submit(db, { submissionId: uuid(), encounterId: e2.id, blockId: "q1", choiceId: "right", ms: 1 }, at(10 * RESUME_WINDOW_MS + 1));
  expect([...lessonProgress(db, "c").get("l1")!]).toEqual(["q1"]);
  expect(lessonProgress(db, "other").size).toBe(0);
});

// A database at schema version 4, as increment 2 left it, with real answers in it.
const V4 = `
CREATE TABLE answers (
  id INTEGER PRIMARY KEY, origin TEXT NOT NULL CHECK (origin IN ('block', 'legacy')), course TEXT, block_id TEXT,
  lesson TEXT NOT NULL, question INTEGER, prompt TEXT, choice TEXT NOT NULL, correct INTEGER NOT NULL,
  first_try INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL,
  CHECK ((origin = 'block' AND block_id IS NOT NULL) OR (origin = 'legacy' AND block_id IS NULL)));
CREATE INDEX answers_block ON answers (block_id, at);
CREATE INDEX answers_lesson ON answers (course, lesson, at);
CREATE TABLE views (id INTEGER PRIMARY KEY, course TEXT, lesson TEXT NOT NULL, at TEXT NOT NULL);
INSERT INTO answers VALUES (1, 'legacy', NULL, NULL, 'l1', 0, 'Old?', 'Yes', 1, 1, 10, '2026-11-18T01:00:00Z');
INSERT INTO answers VALUES (2, 'block', 'c', 'q1', 'l1', NULL, NULL, 'Right one', 1, 1, 20, '2026-11-21T01:00:00Z');
INSERT INTO views VALUES (1, 'c', 'l1', '2026-11-21T00:59:00Z');
PRAGMA user_version = 4;
`;

test("migrating a populated version-4 database keeps every answer and view, after a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "school-record-"));
  dirs.push(dir);
  const db = new Database(join(dir, "progress.db"), { create: true, strict: true });
  db.exec(V4);
  const before = db.query("SELECT * FROM answers ORDER BY id").all();
  expect(shape(db)).toBe("v4");

  let backups = 0;
  migrate(db, () => backups++);
  expect(backups).toBe(1);
  expect(shape(db)).toBe("current");
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(SCHEMA_VERSION);

  const after = db.query<Record<string, unknown>, []>("SELECT * FROM answers ORDER BY id").all();
  expect(after.map(({ encounter_id, choice_id, submission_id, ...rest }) => rest)).toEqual(before as never);
  for (const r of after) expect([r.encounter_id, r.choice_id, r.submission_id]).toEqual([null, null, null]);
  expect(count(db, "views")).toBe(1);

  // And the new rules now hold on the old rows too.
  expect(() => db.exec("DELETE FROM answers WHERE id = 1")).toThrow(/append-only/);
  // Idempotent: a second run is a no-op.
  migrate(db, () => backups++);
  expect(backups).toBe(1);
});
