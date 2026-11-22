// Increment 1's evidence gate (RFC 1): every old answer survives with its original
// meaning, a restore from the backup works, and the migration is idempotent.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, migrate, shape, snapshot } from "./migrate.ts";

const LEGACY = `
CREATE TABLE answers (
  id INTEGER PRIMARY KEY, lesson TEXT NOT NULL, question INTEGER NOT NULL, prompt TEXT NOT NULL,
  choice TEXT NOT NULL, correct INTEGER NOT NULL, first_try INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE views (id INTEGER PRIMARY KEY, lesson TEXT NOT NULL, at TEXT NOT NULL);
`;

// Deliberately awkward content: an apostrophe, a unicode glyph, and two answers to the
// same position so a de-duplicating migration would be caught.
const ROWS = [
  { id: 1, lesson: "0001-the-inversion", question: 0, prompt: "What does WARP store?", choice: "Transformations, not states", correct: 1, first_try: 1, ms: 4200, at: "2026-11-18T01:00:00Z" },
  { id: 2, lesson: "0001-the-inversion", question: 1, prompt: "Who's the observer, Ω?", choice: "The boundary", correct: 0, first_try: 1, ms: 9100, at: "2026-11-18T01:01:00Z" },
  { id: 3, lesson: "0001-the-inversion", question: 1, prompt: "Who's the observer, Ω?", choice: "A worldline", correct: 1, first_try: 0, ms: 2300, at: "2026-11-18T01:02:00Z" },
  { id: 4, lesson: "0002-warp-graphs", question: 0, prompt: "Depth of an atom?", choice: "Zero", correct: 1, first_try: 1, ms: 1500, at: "2026-11-19T02:00:00Z" },
];

function legacyDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(LEGACY);
  const insert = db.prepare(`INSERT INTO answers (id, lesson, question, prompt, choice, correct, first_try, ms, at)
    VALUES ($id, $lesson, $question, $prompt, $choice, $correct, $first_try, $ms, $at)`);
  for (const r of ROWS) insert.run(r);
  db.prepare("INSERT INTO views (lesson, at) VALUES ($lesson, $at)").run({ lesson: "0001-the-inversion", at: "2026-11-18T00:59:00Z" });
  db.exec("PRAGMA user_version = 0");
  return db;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "school-migrate-"));
}

test("a populated legacy database keeps every answer, with its original meaning", () => {
  const dir = tmp();
  try {
    const db = legacyDb(join(dir, "progress.db"));
    expect(shape(db)).toBe("legacy");

    const result = migrate(db);
    expect(result.copied).toBe(ROWS.length);
    expect(result.from).toBe(0);
    expect(result.to).toBe(SCHEMA_VERSION);

    const after = db.query<Record<string, unknown>, []>("SELECT * FROM answers ORDER BY id").all();
    expect(after.length).toBe(ROWS.length);

    for (const [i, row] of after.entries()) {
      const want = ROWS[i]!;
      // Original meaning: position, prompt and choice text all survive verbatim.
      expect(row.lesson).toBe(want.lesson);
      expect(row.question).toBe(want.question);
      expect(row.prompt).toBe(want.prompt);
      expect(row.choice).toBe(want.choice);
      expect(row.correct).toBe(want.correct);
      expect(row.first_try).toBe(want.first_try);
      expect(row.ms).toBe(want.ms);
      expect(row.at).toBe(want.at);
      // Attribution is unknown, so it is recorded as unknown rather than guessed.
      expect(row.origin).toBe("legacy");
      expect(row.block_id).toBe(null);
    }
    // The two answers to question 1 are still two distinct answers.
    const q1 = after.filter((r) => r.lesson === "0001-the-inversion" && r.question === 1);
    expect(q1.length).toBe(2);
    expect(q1.map((r) => r.first_try)).toEqual([1, 0]);

    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM views").get()?.n).toBe(1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrating twice changes nothing the second time", () => {
  const dir = tmp();
  try {
    const path = join(dir, "progress.db");
    const db = legacyDb(path);
    migrate(db);
    const first = db.query<Record<string, unknown>, []>("SELECT * FROM answers ORDER BY id").all();

    let backups = 0;
    const again = migrate(db, () => backups++);
    expect(again.copied).toBe(0);
    expect(backups).toBe(0); // nothing to write, so nothing is backed up
    expect(db.query<Record<string, unknown>, []>("SELECT * FROM answers ORDER BY id").all()).toEqual(first);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the backup taken before migrating is restorable, and still holds the legacy rows", () => {
  const dir = tmp();
  try {
    const path = join(dir, "progress.db");
    const backup = join(dir, "progress.db.bak");
    const db = legacyDb(path);

    migrate(db, () => snapshot(db, backup));
    db.close();

    // Restore: open the snapshot on its own and read the pre-migration history.
    const restored = new Database(backup, { strict: true });
    expect(shape(restored)).toBe("legacy");
    const rows = restored.query<Record<string, unknown>, []>("SELECT * FROM answers ORDER BY id").all();
    expect(rows.length).toBe(ROWS.length);
    expect(rows[1]!.prompt).toBe("Who's the observer, Ω?");
    expect(restored.query<{ n: number }, []>("SELECT count(*) AS n FROM views").get()?.n).toBe(1);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh database gets the current schema with no rows", () => {
  const dir = tmp();
  try {
    const db = new Database(join(dir, "progress.db"), { create: true, strict: true });
    expect(shape(db)).toBe("absent");
    let backups = 0;
    const result = migrate(db, () => backups++);
    expect(result.copied).toBe(0);
    expect(backups).toBe(0); // an empty database has nothing to preserve
    expect(shape(db)).toBe("current");
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version-2 database keeps its block attribution", () => {
  const dir = tmp();
  try {
    const db = new Database(join(dir, "progress.db"), { create: true, strict: true });
    db.exec(`CREATE TABLE answers (
      id INTEGER PRIMARY KEY, block_id TEXT NOT NULL, lesson TEXT NOT NULL, choice TEXT NOT NULL,
      correct INTEGER NOT NULL, first_try INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL);
      CREATE TABLE views (id INTEGER PRIMARY KEY, lesson TEXT NOT NULL, at TEXT NOT NULL);
      PRAGMA user_version = 2;`);
    db.prepare(`INSERT INTO answers (block_id, lesson, choice, correct, first_try, ms, at)
      VALUES ('inversion-core-1', '0001-the-inversion', 'b', 1, 1, 1200, '2026-11-20T00:00:00Z')`).run();
    expect(shape(db)).toBe("v2");

    expect(migrate(db).copied).toBe(1);
    const row = db.query<Record<string, unknown>, []>("SELECT * FROM answers").get()!;
    expect(row.origin).toBe("block");
    expect(row.block_id).toBe("inversion-core-1");
    expect(row.question).toBe(null);
    expect(row.course).toBe(null); // recorded before courses existed
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version-3 database gains a course column without touching its rows", () => {
  const dir = tmp();
  try {
    const db = legacyDb(join(dir, "progress.db"));
    migrate(db); // -> current
    // Simulate a v3 database by dropping the column v4 added.
    const before = db.query<Record<string, unknown>, []>("SELECT id, lesson, prompt FROM answers ORDER BY id").all();
    db.exec("DROP INDEX IF EXISTS answers_lesson"); // SQLite refuses DROP COLUMN while indexed
    db.exec("ALTER TABLE answers DROP COLUMN course");
    db.exec("PRAGMA user_version = 3");
    expect(shape(db)).toBe("v3");

    const result = migrate(db);
    expect(result.copied).toBe(ROWS.length);
    expect(shape(db)).toBe("current");
    expect(db.query<Record<string, unknown>, []>("SELECT id, lesson, prompt FROM answers ORDER BY id").all()).toEqual(before);
    expect(db.query<Record<string, unknown>, []>("SELECT * FROM answers").get()!.course).toBe(null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
