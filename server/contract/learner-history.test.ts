// The learner-history story (./learner-history.ts, flyingrobots/school#27), replayed on every
// adapter of the LearningRecord port: Postgres on PGlite connected as school_app, and a real
// Postgres server through Bun.SQL as the server opens it (flyingrobots/school#23). The last needs
// SCHOOL_TEST_POSTGRES_URL and skips without it; CI sets it and fails a run that skips it
// (server/testing/postgres-gate.ts).
import { afterAll, describe, setDefaultTimeout } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { postgresRecord } from "../adapters/postgres.ts";
import { migrate } from "../db/migrate.ts";
import { pgliteSql } from "../adapters/pglite.ts";
import { scratchPostgres, TEST_POSTGRES_URL } from "../testing/postgres.ts";
import { learnerHistory } from "./learner-history.ts";

setDefaultTimeout(30_000); // PGlite starts a whole Postgres in process.

const opened: PGlite[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
});

learnerHistory("postgres (PGlite)", async () => {
  const db = new PGlite();
  opened.push(db);
  await migrate(db);
  await db.exec("SET ROLE school_app");
  return postgresRecord(pgliteSql(db));
});

const scratch = scratchPostgres();
describe.skipIf(TEST_POSTGRES_URL === undefined)("Bun.SQL on a real Postgres (SCHOOL_TEST_POSTGRES_URL)", () => {
  learnerHistory("postgres (Bun.SQL)", async () => postgresRecord((await scratch.fresh()).sql));
});
