// Migration 0012 on PGlite: the `ai-help` exposure, the only kind with no block, recorded for a
// whole encounter (RFC 6 §5.1, Table 5.2; flyingrobots/school#224). What the readers make of it is
// the contract's (server/contract/learning-record.ts); these are the SQL-level facts the port
// cannot see.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate } from "./migrate.ts";

setDefaultTimeout(60_000); // PGlite starts a whole Postgres in process.

const opened: PGlite[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  opened.push(db);
  await migrate(db);
  return db;
}

const at = (ms = 0) => new Date(Date.parse("2026-11-21T10:00:00.000Z") + ms).toISOString();
const uuid = () => crypto.randomUUID();
const PAGE = JSON.stringify({ type: "page", id: "l1", title: "l1", subtitle: "", children: [
  { type: "explain", id: "e1", prompt: "?", model: ".", sources: [] },
] });
const OLD_KINDS = ["hint", "model-answer", "feedback", "reference"];

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}
const tracked = (db: PGlite) => as(db, "school_app", async () =>
  (await db.query<{ id: string }>("SELECT * FROM school.open_encounter('c', 'l1', $1, $2, 1)", [PAGE, at()])).rows[0]!.id);
const exposures = async (db: PGlite) =>
  (await db.query<{ block_id: string | null; kind: string }>("SELECT block_id, kind FROM school.exposures ORDER BY seq")).rows;
const signatures = async (db: PGlite, name: string) => (await db.query<{ f: string }>(`
  SELECT pg_get_function_identity_arguments(p.oid) AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'school' AND p.proname = $1`, [name])).rows.map((r) => r.f);

test("0012 adds record_lesson_help(exposure_id, encounter_id, kind, at), and every reader of aid keeps its signature", async () => {
  const db = await fresh();
  expect(await signatures(db, "record_lesson_help")).toEqual(["p_exposure uuid, p_encounter uuid, p_kind text, p_at timestamp with time zone"]);
  expect(await signatures(db, "record_exposure")).toEqual(["p_exposure uuid, p_encounter uuid, p_block text, p_kind text, p_at timestamp with time zone"]);
  expect(await signatures(db, "submission_aid")).toEqual(["p_submission uuid"]);
  expect(await signatures(db, "due_review")).toEqual(["p_course text, p_blocks jsonb, p_at timestamp with time zone, p_delay_ms bigint, p_limit integer"]);
  expect(await signatures(db, "quiz_episodes")).toEqual(["p_course text, p_blocks jsonb"]);
  expect(await signatures(db, "mastery")).toEqual(["p_course text, p_blocks jsonb, p_at timestamp with time zone, p_delay_ms bigint"]);
});

// Known failure mode (flyingrobots/school#224, 2e): a NULL block_id accepted for another kind.
test("the table refuses an exposure of any other kind with no block, and an ai-help exposure with one", async () => {
  const db = await fresh();
  const e = await tracked(db);
  const insert = (block: string | null, kind: string) => as(db, "school_owner", () =>
    db.query("INSERT INTO school.exposures (exposure_id, encounter_id, block_id, kind, at) VALUES ($1, $2, $3, $4, $5)", [uuid(), e, block, kind, at(1)]));
  for (const kind of OLD_KINDS) await expect(insert(null, kind)).rejects.toThrow("exposures_block");
  await expect(insert("e1", "ai-help")).rejects.toThrow("exposures_block");
  await insert(null, "ai-help");
  await insert("e1", "hint");
  expect(await exposures(db)).toEqual([{ block_id: null, kind: "ai-help" }, { block_id: "e1", kind: "hint" }]);
});

test("record_lesson_help stores only ai-help, and record_exposure never stores it", async () => {
  const db = await fresh();
  const e = await tracked(db);
  await as(db, "school_app", async () => {
    for (const kind of OLD_KINDS) {
      await expect(db.query("SELECT school.record_lesson_help($1, $2, $3, $4)", [uuid(), e, kind, at(1)])).rejects.toThrow("exposures_block");
    }
    await expect(db.query("SELECT school.record_exposure($1, $2, 'e1', 'ai-help', $3)", [uuid(), e, at(2)])).rejects.toThrow("exposures_block");
    expect((await db.query<{ s: string }>("SELECT school.record_exposure($1, $2, NULL, 'ai-help', $3) AS s", [uuid(), e, at(3)])).rows)
      .toEqual([{ s: "rejected" }]);
    expect((await db.query<{ s: string }>("SELECT school.record_exposure($1, $2, NULL, 'hint', $3) AS s", [uuid(), e, at(4)])).rows)
      .toEqual([{ s: "rejected" }]);
  });
  expect(await exposures(db)).toEqual([]);
});

test("a database with exposures recorded before 0012 migrates, and those exposures still aid only their own block", async () => {
  const before = mkdtempSync(join(tmpdir(), "school-0011-"));
  dirs.push(before);
  const shipped = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of shipped.filter((f) => f < "0012")) copyFileSync(join(MIGRATIONS, f), join(before, f));
  const db = new PGlite();
  opened.push(db);
  await migrate(db, before);
  const e = await tracked(db);
  await as(db, "school_app", () => db.query("SELECT school.record_exposure($1, $2, 'e1', 'model-answer', $3)", [uuid(), e, at(1)]));
  // Then 0012 alone, so the case keeps proving exactly that step whatever later migrations ship.
  const file = shipped.find((f) => f.startsWith("0012_"))!;
  copyFileSync(join(MIGRATIONS, file), join(before, file));
  expect(await migrate(db, before)).toEqual({ applied: [12] });
  const aid = await as(db, "school_app", async () => {
    const s = uuid();
    await db.query("SELECT school.save_explanation($1, $2, 'e1', 'After.', 1, $3)", [s, e, at(2)]);
    return (await db.query<{ aid: string }>("SELECT aid FROM school.submission_aid($1)", [s])).rows[0]!.aid;
  });
  expect(aid).toBe("aided");
  expect(await exposures(db)).toEqual([{ block_id: "e1", kind: "model-answer" }]);
});
