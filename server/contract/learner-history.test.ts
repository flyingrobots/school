// The learner-history story (./learner-history.ts, flyingrobots/school#27), replayed on every
// adapter of the LearningRecord port: SQLite, Postgres on PGlite connected as school_app, and a real
// Postgres server through Bun.SQL as the server opens it (flyingrobots/school#23). The last needs
// SCHOOL_TEST_POSTGRES_URL and skips without it; CI sets it and fails a run that skips it
// (server/testing/postgres-gate.ts).
import { afterAll, describe, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresRecord } from "../adapters/postgres.ts";
import { sqliteRecord } from "../adapters/sqlite.ts";
import { migrate as migratePostgres } from "../db/migrate.ts";
import { migrate as migrateSqlite } from "../migrate.ts";
import { pgliteSql } from "../adapters/pglite.ts";
import { scratchPostgres, TEST_POSTGRES_URL } from "../testing/postgres.ts";
import { learnerHistory } from "./learner-history.ts";

setDefaultTimeout(30_000); // PGlite starts a whole Postgres in process.

const dir = mkdtempSync(join(tmpdir(), "school-learner-history-"));
const opened: PGlite[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
  rmSync(dir, { recursive: true, force: true });
});

learnerHistory("sqlite", async () => {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrateSqlite(db);
  return sqliteRecord(db);
}, { recordsExposures: false }); // SQLite has no exposures table; it is being deleted (flyingrobots/school#49).

learnerHistory("postgres (PGlite)", async () => {
  const db = new PGlite();
  opened.push(db);
  await migratePostgres(db);
  await db.exec("SET ROLE school_app");
  return postgresRecord(pgliteSql(db));
}, { recordsExposures: true });

const scratch = scratchPostgres();
describe.skipIf(TEST_POSTGRES_URL === undefined)("Bun.SQL on a real Postgres (SCHOOL_TEST_POSTGRES_URL)", () => {
  learnerHistory("postgres (Bun.SQL)", async () => postgresRecord((await scratch.fresh()).sql), { recordsExposures: true });
});
