// Schema migration for progress.db. Preserves learner history: physical tables may be
// rebuilt, logical history may not change (RFC 1, principle 2).
import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 6;

/**
 * Version 5. The learning record contract (RFC 1; ADR 9). `snapshots` keeps each distinct
 * resolved lesson once, by content hash. `encounters` is a lesson served in the web view. An
 * answer names its encounter, the stable choice id and a client-generated submission id; rows
 * from before version 5 keep all three NULL, which is unknown rather than invented.
 *
 * Progress is append-only, and the database enforces it, not the server: see RULES.
 *
 * Version 4. `course` records which course an answer belongs to: with several courses
 * registered, a lesson id alone identifies nothing. Rows recorded before courses existed
 * keep `course` NULL, which is unknown rather than invented.
 *
 * `origin` separates answers whose block is known from legacy positional ones.
 * A legacy row keeps `block_id` NULL rather than guessing an id: unknown attribution is
 * better evidence than invented attribution (RFC 1, principle 4). Its original question
 * position and prompt are kept so the answer stays interpretable.
 */
const SCHEMA = `
CREATE TABLE answers (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('block', 'legacy')),
  course TEXT,
  block_id TEXT,
  lesson TEXT NOT NULL,
  question INTEGER,
  prompt TEXT,
  choice TEXT NOT NULL,
  correct INTEGER NOT NULL,
  first_try INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  at TEXT NOT NULL,
  encounter_id TEXT REFERENCES encounters (id),
  choice_id TEXT,
  submission_id TEXT,
  CHECK ((origin = 'block' AND block_id IS NOT NULL) OR (origin = 'legacy' AND block_id IS NULL))
);
CREATE INDEX answers_block ON answers (block_id, at);
CREATE INDEX answers_lesson ON answers (course, lesson, at);
CREATE TABLE IF NOT EXISTS views (id INTEGER PRIMARY KEY, course TEXT, lesson TEXT NOT NULL, at TEXT NOT NULL);
`;

/** Tables the answers table refers to. Created before any answers table, on every path. */
const RECORD_TABLES = `
CREATE TABLE IF NOT EXISTS snapshots (hash TEXT PRIMARY KEY, content TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  course TEXT NOT NULL,
  lesson TEXT NOT NULL,
  view TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL REFERENCES snapshots (hash),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS encounters_lesson ON encounters (course, lesson, snapshot_hash, at);

-- Version 6: explanations, and every attempt to grade one (RFC 1 proposal 4). An explanation
-- is saved before any grading; a grading attempt is a row whether it succeeded or failed, and a
-- retry is a new row naming the one it supersedes.
CREATE TABLE IF NOT EXISTS explanations (
  submission_id TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL REFERENCES encounters (id),
  block_id TEXT NOT NULL,
  course TEXT NOT NULL,
  lesson TEXT NOT NULL,
  text TEXT NOT NULL,
  ms INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS explanations_encounter ON explanations (encounter_id, block_id, at);
CREATE TABLE IF NOT EXISTS gradings (
  id INTEGER PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES explanations (submission_id),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  rubric_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT,
  sources TEXT NOT NULL,
  raw_response TEXT,
  findings TEXT,
  error TEXT,
  supersedes INTEGER REFERENCES gradings (id),
  at TEXT NOT NULL,
  CHECK ((status = 'succeeded' AND findings IS NOT NULL AND error IS NULL) OR (status = 'failed' AND findings IS NULL AND error IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS gradings_submission ON gradings (submission_id, id);
`;

/**
 * The rules that keep progress from being lost, held by the database so that no server code
 * path can break them. Triggers rather than CHECKs because SQLite cannot add a CHECK to an
 * existing table, and these must hold identically on a fresh database and a migrated one.
 *
 * A future migration that must rewrite a table drops these first, inside its transaction,
 * and recreates them before commit (the rebuild below does exactly that).
 */
const RULES = `
CREATE UNIQUE INDEX IF NOT EXISTS answers_submission ON answers (submission_id);
CREATE INDEX IF NOT EXISTS answers_encounter ON answers (encounter_id, block_id);
CREATE TRIGGER IF NOT EXISTS answers_complete BEFORE INSERT ON answers
  WHEN NEW.submission_id IS NOT NULL AND (NEW.encounter_id IS NULL OR NEW.choice_id IS NULL)
  BEGIN SELECT RAISE(ABORT, 'a submission needs its encounter and choice'); END;
CREATE TRIGGER IF NOT EXISTS answers_no_update BEFORE UPDATE ON answers
  BEGIN SELECT RAISE(ABORT, 'answers are append-only'); END;
CREATE TRIGGER IF NOT EXISTS answers_no_delete BEFORE DELETE ON answers
  BEGIN SELECT RAISE(ABORT, 'answers are append-only'); END;
CREATE TRIGGER IF NOT EXISTS encounters_no_update BEFORE UPDATE ON encounters
  BEGIN SELECT RAISE(ABORT, 'encounters are append-only'); END;
CREATE TRIGGER IF NOT EXISTS encounters_no_delete BEFORE DELETE ON encounters
  BEGIN SELECT RAISE(ABORT, 'encounters are append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_no_update BEFORE UPDATE ON snapshots
  BEGIN SELECT RAISE(ABORT, 'snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_no_delete BEFORE DELETE ON snapshots
  BEGIN SELECT RAISE(ABORT, 'snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS explanations_no_update BEFORE UPDATE ON explanations
  BEGIN SELECT RAISE(ABORT, 'explanations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS explanations_no_delete BEFORE DELETE ON explanations
  BEGIN SELECT RAISE(ABORT, 'explanations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS gradings_no_update BEFORE UPDATE ON gradings
  BEGIN SELECT RAISE(ABORT, 'gradings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS gradings_no_delete BEFORE DELETE ON gradings
  BEGIN SELECT RAISE(ABORT, 'gradings are append-only'); END;
`;

type Shape = "absent" | "legacy" | "v2" | "v3" | "v4" | "current";

function columns(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

/** What the `answers` table on disk looks like, regardless of what user_version claims. */
export function shape(db: Database): Shape {
  const names = columns(db, "answers");
  if (names.length === 0) return "absent";
  if (names.includes("submission_id")) return "current";
  if (names.includes("course")) return "v4";
  if (names.includes("origin")) return "v3";
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

  // A newer School wrote this. Its shape may look current to us; migrating would be a downgrade.
  if (from > SCHEMA_VERSION) {
    throw new Error(`progress.db is schema version ${from}, newer than this School (${SCHEMA_VERSION}); refusing to touch it`);
  }

  // Already current: nothing to write, so no backup and no transaction.
  if (found === "current" && from === SCHEMA_VERSION) {
    return { from, to: SCHEMA_VERSION, copied: 0, shape: found };
  }

  // Back up before rewriting anything. An empty database has nothing to preserve, and a
  // current-shaped one only needs its version stamped, so neither takes a snapshot.
  if (found !== "absent" && found !== "current") onBackup?.(found);

  // The version is written INSIDE the transaction (SQLite applies user_version transactionally),
  // so data and version commit together. And the dispatch is exhaustive on the shape found on
  // disk: a current-shaped table can never reach a rebuild, whatever the version says.
  const run = db.transaction((): number => {
    db.exec(RECORD_TABLES);
    let copied: number;
    switch (found) {
      case "current":
        // Data already at this schema, version not: a crash between the two, under the
        // old ordering. Restore the rules if missing and stamp the version. Nothing else.
        db.exec(RULES);
        copied = 0;
        break;
      case "absent":
        db.exec(SCHEMA);
        db.exec(RULES);
        copied = 0;
        break;
      case "v3":
      case "v4":
        copied = addColumns(db, found);
        break;
      case "legacy":
      case "v2":
        copied = rebuild(db, found);
        break;
      default: {
        const never: never = found;
        throw new Error(`unknown answers shape ${String(never)}`);
      }
    }
    // A views table older than courses lacks `course`; every path ends with it present.
    if (!columns(db, "views").includes("course")) db.exec("ALTER TABLE views ADD COLUMN course TEXT");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return copied;
  });

  const copied = run();
  return { from, to: SCHEMA_VERSION, copied, shape: found };
}

const count = (db: Database, table: string) => db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;

/** v3 and v4 differ from current only by added nullable columns, so add them rather than rebuild. */
function addColumns(db: Database, found: "v3" | "v4"): number {
  const before = count(db, "answers");
  if (found === "v3") {
    db.exec("ALTER TABLE answers ADD COLUMN course TEXT");
    db.exec("DROP INDEX IF EXISTS answers_lesson");
    db.exec("CREATE INDEX answers_lesson ON answers (course, lesson, at)");
  }
  db.exec("ALTER TABLE answers ADD COLUMN encounter_id TEXT REFERENCES encounters (id)");
  db.exec("ALTER TABLE answers ADD COLUMN choice_id TEXT");
  db.exec("ALTER TABLE answers ADD COLUMN submission_id TEXT");
  db.exec(RULES);
  if (count(db, "answers") !== before) throw new Error("migration changed the number of answers");
  return before;
}

/**
 * Rebuild into a new table, then swap. Only for shapes that predate every column the copy
 * could lose. Copying is explicit per shape so that no column is silently reinterpreted:
 * a legacy `question` is a position, never a block id.
 */
function rebuild(db: Database, found: "legacy" | "v2"): number {
  db.exec(SCHEMA.replace(/CREATE TABLE answers/, "CREATE TABLE answers_next")
                .replace(/CREATE INDEX answers_block ON answers /, "CREATE INDEX answers_block_next ON answers_next ")
                .replace(/CREATE INDEX answers_lesson ON answers /, "CREATE INDEX answers_lesson_next ON answers_next "));
  if (found === "legacy") {
    db.exec(`INSERT INTO answers_next (id, origin, course, block_id, lesson, question, prompt, choice, correct, first_try, ms, at)
             SELECT id, 'legacy', NULL, NULL, lesson, question, prompt, choice, correct, first_try, ms, at FROM answers`);
  } else {
    db.exec(`INSERT INTO answers_next (id, origin, course, block_id, lesson, question, prompt, choice, correct, first_try, ms, at)
             SELECT id, 'block', NULL, block_id, lesson, NULL, NULL, choice, correct, first_try, ms, at FROM answers`);
  }
  const copied = count(db, "answers_next");
  const before = count(db, "answers");
  if (copied !== before) throw new Error(`migration would lose rows: ${before} before, ${copied} after`);

  db.exec("DROP TABLE answers");
  db.exec("ALTER TABLE answers_next RENAME TO answers");
  db.exec("DROP INDEX IF EXISTS answers_block_next");
  db.exec("DROP INDEX IF EXISTS answers_lesson_next");
  db.exec("CREATE INDEX IF NOT EXISTS answers_block ON answers (block_id, at)");
  db.exec("CREATE INDEX IF NOT EXISTS answers_lesson ON answers (course, lesson, at)");
  db.exec(RULES);
  return copied;
}
