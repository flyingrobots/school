// The SQLite adapter passes the LearningRecord contract. It is the reference the Postgres
// adapter must match before SQLite is deleted (flyingrobots/school#22).
import { afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learningRecordContract } from "../contract/learning-record.ts";
import { migrate } from "../migrate.ts";
import { sqliteRecord } from "./sqlite.ts";

const dir = mkdtempSync(join(tmpdir(), "school-sqlite-adapter-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

learningRecordContract("sqlite", async () => {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return sqliteRecord(db);
}, { recordsExposures: false }); // SQLite has no exposures table; it is being deleted (flyingrobots/school#49).
