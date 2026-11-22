// Schema migration for progress.db. Preserves learner history: physical tables may be
// rebuilt, logical history may not change (RFC 1, principle 2).
import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 3;

/**
 * Version 3. `origin` separates answers whose block is known from legacy positional ones.
 * A legacy row keeps `block_id` NULL rather than guessing an id: unknown attribution is
 * better evidence than invented attribution (RFC 1, principle 4). Its original question
 * position and prompt are kept so the answer stays interpretable.
 */
const SCHEMA = `
CREATE TABLE answers (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('block', 'legacy')),
  block_id TEXT,
  lesson TEXT NOT NULL,
  question INTEGER,
  prompt TEXT,
  choice TEXT NOT NULL,
  correct INTEGER NOT NULL,
  first_try INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  at TEXT NOT NULL,
  CHECK ((origin = 'block' AND block_id IS NOT NULL) OR (origin = 'legacy' AND block_id IS NULL))
);
CREATE INDEX answers_block ON answers (block_id, at);
CREATE INDEX answers_lesson ON answers (lesson, at);
CREATE TABLE IF NOT EXISTS views (id INTEGER PRIMARY KEY, lesson TEXT NOT NULL, at TEXT NOT NULL);
`;

type Shape = "absent" | "legacy" | "v2" | "current";

function columns(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

/** What the `answers` table on disk looks like, regardless of what user_version claims. */
export function shape(db: Database): Shape {
  const names = columns(db, "answers");
  if (names.length === 0) return "absent";
  if (names.includes("origin")) return "current";
  if (names.includes("question") && names.includes("prompt")) return "legacy";
  return "v2";
}

/**
 * A consistent single-file snapshot. A plain file copy is unsafe here: the database runs in
 * WAL mode, so committed pages can still live in the -wal sidecar.
 */
export function snapshot(db: Database, path: string): void {
  db.query("VACUUM INTO ?").run(path);
}

export type Result = { from: number; to: number; copied: number; shape: Shape };

/**
 * Bring `db` to SCHEMA_VERSION, preserving every existing answer and view. Idempotent:
 * running it on an already-current database copies nothing and leaves rows untouched.
 * `onBackup` is called with the pre-migration shape before anything is written, and only
 * when work is actually required.
 */
export function migrate(db: Database, onBackup?: (from: Shape) => void): Result {
  const from = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const found = shape(db);

  // Already current: nothing to write, so no backup and no transaction.
  if (found === "current" && from === SCHEMA_VERSION) {
    return { from, to: SCHEMA_VERSION, copied: 0, shape: found };
  }

  // Nothing to preserve in an empty database, so no snapshot is taken for one.
  if (found !== "absent") onBackup?.(found);

  const run = db.transaction(() => {
    if (found === "absent") {
      db.exec(SCHEMA);
      return 0;
    }

    // Rebuild into a new table, then swap. Copying is explicit per shape so that no column
    // is silently reinterpreted: a legacy `question` is a position, never a block id.
    db.exec(SCHEMA.replace(/CREATE TABLE answers/, "CREATE TABLE answers_next")
                  .replace(/CREATE INDEX answers_block ON answers /, "CREATE INDEX answers_block_next ON answers_next ")
                  .replace(/CREATE INDEX answers_lesson ON answers /, "CREATE INDEX answers_lesson_next ON answers_next "));

    if (found === "legacy") {
      db.exec(`INSERT INTO answers_next (id, origin, block_id, lesson, question, prompt, choice, correct, first_try, ms, at)
               SELECT id, 'legacy', NULL, lesson, question, prompt, choice, correct, first_try, ms, at FROM answers`);
    } else {
      db.exec(`INSERT INTO answers_next (id, origin, block_id, lesson, question, prompt, choice, correct, first_try, ms, at)
               SELECT id, 'block', block_id, lesson, NULL, NULL, choice, correct, first_try, ms, at FROM answers`);
    }
    const copied = db.query<{ n: number }, []>("SELECT count(*) AS n FROM answers_next").get()?.n ?? 0;
    const before = db.query<{ n: number }, []>("SELECT count(*) AS n FROM answers").get()?.n ?? 0;
    if (copied !== before) throw new Error(`migration would lose rows: ${before} before, ${copied} after`);

    db.exec("DROP TABLE answers");
    db.exec("ALTER TABLE answers_next RENAME TO answers");
    db.exec("DROP INDEX IF EXISTS answers_block_next");
    db.exec("DROP INDEX IF EXISTS answers_lesson_next");
    db.exec("CREATE INDEX IF NOT EXISTS answers_block ON answers (block_id, at)");
    db.exec("CREATE INDEX IF NOT EXISTS answers_lesson ON answers (lesson, at)");
    return copied;
  });

  const copied = run();
  // Outside the data transaction: a PRAGMA write is not part of the row history.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { from, to: SCHEMA_VERSION, copied, shape: found };
}
