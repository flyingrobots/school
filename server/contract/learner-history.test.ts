// The learner-history story (./learner-history.ts, flyingrobots/school#27), replayed on every
// adapter of the LearningRecord port: Postgres on PGlite, connected as school_app.
// Real Postgres registers here too when its CI job exists (flyingrobots/school#23).
import { afterAll, setDefaultTimeout } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { postgresRecord } from "../adapters/postgres.ts";
import { migrate } from "../db/migrate.ts";
import { pgliteSql } from "../adapters/pglite.ts";
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
