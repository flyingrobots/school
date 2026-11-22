// The numbered-migration runner (flyingrobots/school#45): idempotent, one transaction per file,
// a ledger of applied versions with their checksums.
import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, readMigrations } from "./migrate.ts";

const SLOW = 30_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function folder(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "school-migrations-"));
  dirs.push(d);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql);
  return d;
}

const tables = async (db: PGlite) =>
  (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1")).rows.map((r) => r.t);
const ledger = async (db: PGlite) =>
  (await db.query<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version")).rows;

test("the shipped migrations are numbered from 0001 without gaps", () => {
  const ms = readMigrations(MIGRATIONS);
  expect(ms.map((m) => m.version)).toEqual(ms.map((_, i) => i + 1));
  expect(ms[0]!.name).toBe("0001_init.sql");
});

test("files apply in order, each recorded once; a second run applies nothing", async () => {
  const d = folder({ "0002_b.sql": "CREATE TABLE b (id int REFERENCES a (id));", "0001_a.sql": "CREATE TABLE a (id int PRIMARY KEY);" });
  const db = new PGlite();
  expect(await migrate(db, d)).toEqual({ applied: [1, 2] });
  expect(await migrate(db, d)).toEqual({ applied: [] });
  expect(await tables(db)).toEqual(["a", "b"]);
  expect(await ledger(db)).toEqual([{ version: 1, name: "0001_a.sql" }, { version: 2, name: "0002_b.sql" }]);
}, SLOW);

test("a failing file leaves nothing of itself behind and is not recorded; earlier files stay applied", async () => {
  const d = folder({ "0001_a.sql": "CREATE TABLE a (id int);", "0002_bad.sql": "CREATE TABLE half (id int); SELECT no_such_function();" });
  const db = new PGlite();
  await expect(migrate(db, d)).rejects.toThrow(/0002_bad\.sql.*no_such_function/);
  expect(await tables(db)).toEqual(["a"]);
  expect(await ledger(db)).toEqual([{ version: 1, name: "0001_a.sql" }]);
}, SLOW);

test("an applied file whose contents changed is refused, and nothing runs", async () => {
  const d = folder({ "0001_a.sql": "CREATE TABLE a (id int);" });
  const db = new PGlite();
  await migrate(db, d);
  writeFileSync(join(d, "0001_a.sql"), "CREATE TABLE a (id bigint);");
  writeFileSync(join(d, "0002_b.sql"), "CREATE TABLE b (id int);");
  await expect(migrate(db, d)).rejects.toThrow(/0001_a\.sql has changed since it was applied/);
  expect(await tables(db)).toEqual(["a"]);
}, SLOW);

test("misnamed or duplicated version numbers are refused before anything runs", () => {
  expect(() => readMigrations(folder({ "1_a.sql": "" }))).toThrow(/1_a\.sql is not named NNNN_name\.sql/);
  expect(() => readMigrations(folder({ "0001_a.sql": "", "0001_b.sql": "" }))).toThrow(/version 1 is used twice/);
  expect(() => readMigrations(folder({ "0001_a.sql": "", "0003_c.sql": "" }))).toThrow(/version 2 is missing/);
});
