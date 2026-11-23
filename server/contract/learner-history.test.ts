// The learner-history story (./learner-history.ts, flyingrobots/school#27), replayed on every
// adapter of the LearningRecord port: SQLite, and Postgres on PGlite connected as school_app.
// Real Postgres registers here too when its CI job exists (flyingrobots/school#23).
import { afterAll, setDefaultTimeout } from "bun:test";
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
