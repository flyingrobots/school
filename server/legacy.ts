// The premise of RFC 3 v0.4.0 §3.3, checked rather than assumed: School holds no learner work in
// SQLite, so nothing migrates to Postgres. If the SQLite progress.db the server used to write is
// there and holds any answer, explanation or view, the server stops and says so, before it opens
// Postgres, instead of starting on an empty record beside the learner's real history.
//
// Read-only: the file is opened readonly, never created, never migrated. This is the one place in
// School that still reads SQLite. The SQLite record was deleted (flyingrobots/school#49), but this
// check stays: it is what makes "there is no learner data in SQLite" a fact the server checks at
// every start instead of an assumption. It uses bun:sqlite, Bun's built-in driver, because counting
// rows means reading SQLite's file format, and the built-in reads it exactly, adds no dependency
// and ships in the image already; a hand-written reader would be new code to trust for one query.
// server/docker.test.ts holds the line: nothing else imports bun:sqlite.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/** The tables that hold learner work, and the word for one row of each. */
const WORK = [["answers", "answer"], ["explanations", "explanation"], ["views", "view"]] as const;

/** Why the server must not start on `path`, or null if it may: absent, or holding no work. */
export function legacyRefusal(path: string): string | null {
  if (!existsSync(path)) return null;
  let found: string[];
  try {
    const db = new Database(path, { readonly: true });
    try {
      const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
      found = WORK.filter(([table]) => tables.has(table)).flatMap(([table, one]) => {
        const n = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
        return n === 0 ? [] : [`${n} ${one}${n === 1 ? "" : "s"}`];
      });
    } finally {
      db.close();
    }
  } catch (e) {
    return `${path} exists but cannot be read as a SQLite database (${(e as Error).message}). ` +
      "School now keeps the record in Postgres and does not migrate SQLite; move the file aside if it holds nothing you need.";
  }
  if (found.length === 0) return null;
  return `${path} holds ${found.join(", ")} from the SQLite record. It is not migrated to Postgres (RFC 3 §3.3), ` +
    "so starting would leave that history behind an empty record. Keep the file somewhere safe, move it out of the way, then start again.";
}
