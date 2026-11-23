// Migration 0002 on PGlite: exposures are idempotent by a client id and checked against the
// encounter's snapshot, and aid is derived by seq (RFC 2 §3, Listing 1; flyingrobots/school#29).
// Behaviour through the port is the contract's (server/contract/learning-record.ts); these are the
// SQL-level facts the port cannot see.
import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, readMigrations } from "./migrate.ts";

const SLOW = 30_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const at = (ms = 0) => new Date(Date.parse("2001-02-03T04:05:06.789Z") + ms).toISOString();
const uuid = () => crypto.randomUUID();
const PAGE = JSON.stringify({ type: "page", id: "l1", title: "l1", subtitle: "", children: [
  { type: "explain", id: "e1", prompt: "?", model: ".", sources: [] },
] });

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}

const signatures = async (db: PGlite, name: string) => (await db.query<{ f: string }>(`
  SELECT pg_get_function_identity_arguments(p.oid) AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'school' AND p.proname = $1`, [name])).rows.map((r) => r.f);

test("0002 replaces record_exposure: the unchecked signature without an id is gone", async () => {
  const db = new PGlite();
  await migrate(db);
  expect(await signatures(db, "record_exposure")).toEqual(["p_exposure uuid, p_encounter uuid, p_block text, p_kind text, p_at timestamp with time zone"]);
  expect(await signatures(db, "submission_aid")).toEqual(["p_submission uuid"]);
}, SLOW);

test("an exposure id is unique in the table itself, not only in the function", async () => {
  const db = new PGlite();
  await migrate(db);
  const e = await as(db, "school_app", async () =>
    (await db.query<{ id: string }>("SELECT * FROM school.open_encounter('c', 'l1', $1, $2, 1)", [PAGE, at()])).rows[0]!.id);
  const id = uuid();
  const insert = () => as(db, "school_owner", () =>
    db.query("INSERT INTO school.exposures (exposure_id, encounter_id, block_id, kind, at) VALUES ($1, $2, 'e1', 'hint', $3)", [id, e, at(1)]));
  await insert();
  await expect(insert()).rejects.toThrow("exposures_exposure_id");
}, SLOW);

test("a database with exposures recorded under 0001 migrates, and those exposures still aid", async () => {
  const only0001 = mkdtempSync(join(tmpdir(), "school-0001-"));
  dirs.push(only0001);
  copyFileSync(join(MIGRATIONS, "0001_init.sql"), join(only0001, "0001_init.sql"));
  const db = new PGlite();
  expect(await migrate(db, only0001)).toEqual({ applied: [1] });
  const e = await as(db, "school_app", async () => {
    const id = (await db.query<{ id: string }>("SELECT * FROM school.open_encounter('c', 'l1', $1, $2, 1)", [PAGE, at()])).rows[0]!.id;
    await db.query("SELECT school.record_exposure($1, 'e1', 'model-answer', $2)", [id, at(1)]);
    return id;
  });
  // 0002 and every migration after it.
  expect(await migrate(db)).toEqual({ applied: readMigrations().map((m) => m.version).filter((v) => v > 1) });
  const aid = await as(db, "school_app", async () => {
    const s = uuid();
    await db.query("SELECT school.save_explanation($1, $2, 'e1', 'After.', 1, $3)", [s, e, at(2)]);
    return (await db.query<{ aid: string }>("SELECT aid FROM school.submission_aid($1)", [s])).rows[0]!.aid;
  });
  expect(aid).toBe("aided");
}, SLOW);
