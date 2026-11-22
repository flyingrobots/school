// Migration 0001 on PGlite: the record's tables, roles, functions and triggers (RFC 3 v0.4.0 §3.1,
// §3.2, §3.4, §3.5; flyingrobots/school#45). SQL-level: these tests speak to the database
// directly, one block per acceptance item, then the functions' behaviour. The adapter that calls
// the functions through the LearningRecord port is flyingrobots/school#46.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "./migrate.ts";

/** Every table of the record. Asserted equal to the schema's tables, so a new one cannot be missed. */
const RECORD_TABLES = ["answers", "encounters", "explanations", "exposures", "gradings", "snapshots", "views"];

/** The functions `school_app` may execute, and nothing else. */
const APP_FUNCTIONS = [
  "encounter_answers", "encounter_explanations", "explanation", "lesson_progress", "open_encounter",
  "record_exposure", "record_grading", "record_view", "save_explanation", "submit",
];

const SLOW = 30_000; // PGlite starts a whole Postgres in process.

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(db);
  return db;
}

/** Run `sql` as `role`, always returning to the session's own role. */
async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}

async function error(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as Error).message; }
  return "no error";
}

const quiz = (id: string) => ({
  type: "quiz", id, q: "Which?", why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});
const explain = { type: "explain", id: "e1", prompt: "Say why.", model: "Because it is so.", sources: [{ id: "src", title: "S", text: "It is so." }] };
const page = (id: string, children: unknown[], subtitle = "") => JSON.stringify({ type: "page", id, title: id, subtitle, children });
const PAGE = page("l1", [{ type: "section", id: "s", title: "S", children: [quiz("q1"), quiz("q2")] }, explain]);

const T0 = Date.parse("2001-02-03T04:05:06.789Z"); // long past: a stored now() could never equal it
const at = (ms = 0) => new Date(T0 + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const uuid = () => crypto.randomUUID();

type Opened = { id: string; hash: string; resumed: boolean };
const open = async (db: PGlite, when = at(), content = PAGE, lesson = "l1", aid: number | null = null) =>
  (await db.query<Opened>("SELECT * FROM school.open_encounter('c', $1, $2, $3, $4)", [lesson, content, when, aid])).rows[0]!;

type Submitted = { status: string; correct: boolean | null; first_try: boolean | null };
const submit = async (db: PGlite, o: { encounter: string; block?: string; choice?: string; id?: string; ms?: number; when?: string }) =>
  (await db.query<Submitted>("SELECT * FROM school.submit($1, $2, $3, $4, $5, $6)",
    [o.id ?? uuid(), o.encounter, o.block ?? "q1", o.choice ?? "right", o.ms ?? 1, o.when ?? at(1)])).rows[0]!;

const saveExplanation = async (db: PGlite, o: { encounter: string; id?: string; block?: string; text?: string; ms?: number; when?: string }) =>
  (await db.query<{ save_explanation: string }>("SELECT school.save_explanation($1, $2, $3, $4, $5, $6)",
    [o.id ?? uuid(), o.encounter, o.block ?? "e1", o.text ?? "Because.", o.ms ?? 7, o.when ?? at(2)])).rows[0]!.save_explanation;

type GradingJson = { id: number; status: string; findings: unknown; error: string | null; model: string | null; supersedes: number | null; at: string };
const FINDINGS = { insufficient_evidence: false, summary: "Good.", contradictions: [], fidelity: { verdict: "meets", note: "" },
  completeness: { verdict: "partly", note: "" }, accessibility: { verdict: "meets", note: "" } };
const recordGrading = async (db: PGlite, submission: string, when: string, ok = true) =>
  (await db.query<{ record_grading: GradingJson }>("SELECT school.record_grading($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)", [
    submission, ok ? "succeeded" : "failed", "rubric-v1", "prompt-v1", "test", ok ? "m" : null, "[]",
    ok ? "{}" : null, ok ? JSON.stringify(FINDINGS) : null, ok ? null : "the bridge could not be reached", when,
  ])).rows[0]!.record_grading;

/** One row in every record table, written through the functions as the application. */
async function populate(db: PGlite): Promise<{ encounter: string; submission: string }> {
  return as(db, "school_app", async () => {
    const e = await open(db, at(), PAGE, "l1", 1);
    await submit(db, { encounter: e.id });
    const submission = uuid();
    expect(await saveExplanation(db, { encounter: e.id, id: submission })).toBe("stored");
    await recordGrading(db, submission, at(3));
    await db.query("SELECT school.record_view('c', 'l1', $1)", [at(4)]);
    await db.query("SELECT school.record_exposure($1, 'e1', 'model-answer', $2)", [e.id, at(5)]);
    return { encounter: e.id, submission };
  });
}

describe("acceptance", () => {
  test("the record tables are exactly the expected ones", async () => {
    const db = await fresh();
    const { rows } = await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'school' ORDER BY 1");
    expect(rows.map((r) => r.t)).toEqual(RECORD_TABLES);
  }, SLOW);

  test("as school_app, direct INSERT, UPDATE, DELETE and TRUNCATE on every record table are denied", async () => {
    const db = await fresh();
    await populate(db);
    const before = await counts(db);
    await as(db, "school_app", async () => {
      for (const t of RECORD_TABLES) {
        for (const sql of [
          `INSERT INTO school.${t} DEFAULT VALUES`,
          `UPDATE school.${t} SET at = at`,
          `DELETE FROM school.${t}`,
          `TRUNCATE school.${t}`,
          `SELECT * FROM school.${t}`,
        ]) expect(`${sql}: ${await error(db.exec(sql))}`).toBe(`${sql}: permission denied for table ${t}`);
      }
      expect(await error(db.exec("SELECT nextval('school.record_seq')"))).toBe("permission denied for sequence record_seq");
    });
    expect(await counts(db)).toEqual(before);
  }, SLOW);

  test("as the owner, an update or delete of a record row is refused by a trigger, and so is a truncate", async () => {
    const db = await fresh();
    await populate(db);
    const before = await counts(db);
    for (const n of Object.values(before)) expect(n).toBe(1); // a row trigger only fires on a row
    await as(db, "school_owner", async () => {
      for (const t of RECORD_TABLES) {
        expect(await error(db.exec(`UPDATE school.${t} SET at = at`))).toBe(`${t} are append-only`);
        expect(await error(db.exec(`DELETE FROM school.${t}`))).toBe(`${t} are append-only`);
        expect(await error(db.exec(`TRUNCATE school.${t} CASCADE`))).toBe(`${t} are append-only`);
      }
    });
    expect(await counts(db)).toEqual(before);
  }, SLOW);

  test("no function is executable by a role without an explicit grant", async () => {
    const db = await fresh();
    await db.exec("CREATE ROLE stranger NOLOGIN");
    const fns = (await db.query<{ oid: number; name: string; acl: string | null }>(`
      SELECT p.oid, p.proname AS name, p.proacl::text AS acl FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'school' ORDER BY p.proname`)).rows;
    expect(fns.length).toBeGreaterThan(APP_FUNCTIONS.length); // trigger and helper functions too
    for (const f of fns) {
      // A NULL ACL means the default, which grants PUBLIC; every function must carry an explicit one.
      expect(`${f.name}: ${f.acl === null ? "default ACL" : "explicit"}`).toBe(`${f.name}: explicit`);
      const publicEntries = (await db.query("SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = $1)) WHERE grantee = 0", [f.oid])).rows;
      expect(`${f.name}: ${publicEntries.length}`).toBe(`${f.name}: 0`);
      const stranger = (await db.query<{ ok: boolean }>("SELECT has_function_privilege('stranger', $1::oid, 'EXECUTE') AS ok", [f.oid])).rows[0]!.ok;
      expect(`${f.name}: ${stranger}`).toBe(`${f.name}: false`);
    }
    const app = (await db.query<{ name: string }>(`
      SELECT DISTINCT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'school' AND has_function_privilege('school_app', p.oid, 'EXECUTE') ORDER BY 1`)).rows.map((r) => r.name);
    expect(app).toEqual(APP_FUNCTIONS);

    // Default privileges: a function the owner adds later starts revoked from PUBLIC, too.
    await as(db, "school_owner", () => db.exec("CREATE FUNCTION school.later() RETURNS int LANGUAGE sql AS 'SELECT 1'"));
    const later = (await db.query<{ ok: boolean }>("SELECT has_function_privilege('stranger', 'school.later()', 'EXECUTE') AS ok")).rows[0]!.ok;
    expect(later).toBe(false);
  }, SLOW);

  test("school_owner owns the schema and every object in it", async () => {
    const db = await fresh();
    const q = async (sql: string) => (await db.query<{ name: string; owner: string }>(sql)).rows;
    const objects = [
      ...await q(`SELECT 'schema ' || nspname AS name, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'school'`),
      ...await q(`SELECT c.relkind::text || ' ' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'school'`),
      ...await q(`SELECT 'function ' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'school'`),
      ...await q(`SELECT 'type ' || t.typname AS name, pg_get_userbyid(t.typowner) AS owner FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'school'`),
    ];
    expect(objects.length).toBeGreaterThan(RECORD_TABLES.length + APP_FUNCTIONS.length);
    expect(objects.filter((o) => o.owner !== "school_owner")).toEqual([]);
  }, SLOW);

  test("the migrations create no function outside schema school", async () => {
    const db = new PGlite();
    const outside = async () => (await db.query<{ f: string }>(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname <> 'school' ORDER BY 1`)).rows.map((r) => r.f);
    const before = await outside();
    await migrate(db);
    expect(await outside()).toEqual(before);
    expect((await db.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'school'")).rows.length)
      .toBeGreaterThan(APP_FUNCTIONS.length);
  }, SLOW);

  test("no record function calls now() or any other clock", async () => {
    const db = await fresh();
    const clock = /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\b(current_timestamp|current_date|current_time|localtimestamp|localtime)\b/i;
    const fns = (await db.query<{ name: string; src: string }>(`
      SELECT p.proname AS name, pg_get_functiondef(p.oid) AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'school'`)).rows;
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining(APP_FUNCTIONS));
    for (const f of fns) expect(`${f.name}: ${clock.test(f.src)}`).toBe(`${f.name}: false`);
    // Nor does any column default to the clock.
    const defaults = (await db.query<{ col: string; def: string }>(`
      SELECT c.relname || '.' || a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE n.nspname = 'school'`)).rows;
    expect(defaults.length).toBeGreaterThanOrEqual(RECORD_TABLES.length);
    for (const d of defaults) expect(`${d.col}: ${d.def}`).toMatch(/: nextval\('school\.record_seq'::regclass\)$/);
  }, SLOW);

  test("a fixed at is stored exactly, in every record table", async () => {
    const db = await fresh();
    await populate(db);
    const stored = await as(db, "school_owner", async () => {
      const out: Record<string, string[]> = {};
      for (const t of RECORD_TABLES) {
        out[t] = (await db.query<{ at: string }>(`SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM school.${t}`)).rows.map((r) => r.at);
      }
      return out;
    });
    const us = (ms: number) => at(ms).replace("Z", "000Z");
    // The snapshot and encounter take the open's at; each later write its own.
    expect(stored).toEqual({
      snapshots: [us(0)], encounters: [us(0)], answers: [us(1)], explanations: [us(2)],
      gradings: [us(3)], views: [us(4)], exposures: [us(5)],
    });
  }, SLOW);

  test("running the migrations twice changes nothing", async () => {
    const db = new PGlite();
    const first = await migrate(db);
    expect(first.applied).toEqual([1]);
    const before = await fingerprint(db);
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(await fingerprint(db)).toEqual(before);
  }, SLOW);
});

async function counts(db: PGlite): Promise<Record<string, number>> {
  return as(db, "school_owner", async () => {
    const out: Record<string, number> = {};
    for (const t of RECORD_TABLES) out[t] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM school.${t}`)).rows[0]!.n;
    return out;
  });
}

/** Everything a migration could change: objects, columns, code, privileges, roles and the version ledger. */
async function fingerprint(db: PGlite): Promise<unknown> {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    relations: await q(`SELECT c.relname, c.relkind, c.relacl::text, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('school', 'public') ORDER BY 1`),
    columns: await q(`SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema IN ('school', 'public') ORDER BY 1, 2, 3`),
    functions: await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosrc, p.proacl::text, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'school' ORDER BY 1, 2`),
    triggers: await q(`SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
    indexes: await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname IN ('school', 'public') ORDER BY 1`),
    defaults: await q(`SELECT defaclrole::regrole::text, defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY 1, 2`),
    roles: await q(`SELECT rolname, rolcanlogin, rolsuper, rolinherit FROM pg_roles WHERE rolname LIKE 'school%' ORDER BY 1`),
    schemas: await q(`SELECT nspname, nspacl::text, pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'school'`),
    sequence: await q(`SELECT last_value, is_called FROM school.record_seq`),
    ledger: await q(`SELECT version, name, checksum, applied_at FROM public.schema_migrations ORDER BY version`),
  };
}

describe("functions", () => {
  test("answers: correct and first try come from the snapshot; a resend is a duplicate; a reused id a conflict", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e = await open(db);
      const right = uuid();
      expect(await submit(db, { encounter: e.id, choice: "wrong", when: at(1) })).toEqual({ status: "stored", correct: false, first_try: true });
      expect(await submit(db, { encounter: e.id, choice: "right", id: right, when: at(2) })).toEqual({ status: "stored", correct: true, first_try: false });
      expect(await submit(db, { encounter: e.id, choice: "right", id: right, when: at(3) })).toEqual({ status: "duplicate", correct: true, first_try: false });
      expect(await submit(db, { encounter: e.id, choice: "wrong", id: right, when: at(4) })).toEqual({ status: "conflict", correct: null, first_try: null });
      expect(await submit(db, { encounter: e.id, block: "q2", choice: "right", when: at(5) })).toEqual({ status: "stored", correct: true, first_try: true });
      for (const bad of [{ choice: "nope" }, { block: "q9" }, { block: "e1" }, { encounter: uuid() }]) {
        expect(await submit(db, { encounter: e.id, ...bad })).toEqual({ status: "rejected", correct: null, first_try: null });
      }
      const answers = (await db.query("SELECT block_id, choice_id, correct FROM school.encounter_answers($1) ORDER BY seq", [e.id])).rows;
      expect(answers).toEqual([
        { block_id: "q1", choice_id: "wrong", correct: false },
        { block_id: "q1", choice_id: "right", correct: true },
        { block_id: "q2", choice_id: "right", correct: true },
      ]);
    });
  }, SLOW);

  test("the partial unique index allows one first try per encounter and block", async () => {
    const db = await fresh();
    const { encounter } = await populate(db);
    const def = (await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'answers_one_first_try'")).rows[0]!.indexdef;
    expect(def).toBe("CREATE UNIQUE INDEX answers_one_first_try ON school.answers USING btree (encounter_id, block_id) WHERE first_try");
    // Even the owner cannot record a second first try for that block.
    const msg = await as(db, "school_owner", () => error(db.query(`INSERT INTO school.answers
      (submission_id, encounter_id, block_id, choice_id, correct, first_try, ms, at) VALUES ($1, $2, 'q1', 'right', true, true, 1, $3)`,
      [uuid(), encounter, at(9)])));
    expect(msg).toContain("answers_one_first_try");
  }, SLOW);

  test("an encounter resumes inside six hours of its last activity, here an answer, and only for the same content", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e1 = await open(db, at(0));
      expect(e1.resumed).toBe(false);
      expect(e1.hash).toBe(new Bun.CryptoHasher("sha256").update(PAGE).digest("hex"));
      await submit(db, { encounter: e1.id, choice: "wrong", when: at(6 * HOUR - 1000) });
      expect(await open(db, at(6 * HOUR + 1000))).toEqual({ ...e1, resumed: true });
      const edited = await open(db, at(6 * HOUR + 2000), page("l1", [quiz("q1")], "edited"));
      expect(edited.id).not.toBe(e1.id);
      const later = await open(db, at(13 * HOUR));
      expect(later.resumed).toBe(false);
      expect(later.id).not.toBe(e1.id);
      expect(await submit(db, { encounter: later.id, choice: "right", when: at(13 * HOUR + 1) })).toMatchObject({ first_try: true });
    });
  }, SLOW);

  // The resume rule is main's (flyingrobots/school#53; server/record.ts): activity is the learner's, the
  // encounter's opening, its latest answer and its latest explanation. These mirror the contract's cases.
  test("an explanation is activity: one written late in the window keeps the encounter open past it", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e1 = await open(db, at(0));
      expect(await saveExplanation(db, { encounter: e1.id, when: at(6 * HOUR - 1000) })).toBe("stored");
      expect(await open(db, at(6 * HOUR + 1000))).toEqual({ ...e1, resumed: true });
    });
  }, SLOW);

  test("grading is not the learner's activity: a late grading does not keep the encounter open", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e1 = await open(db, at(0));
      const id = uuid();
      expect(await saveExplanation(db, { encounter: e1.id, id, when: at(1000) })).toBe("stored");
      await recordGrading(db, id, at(12 * HOUR));
      const later = await open(db, at(12 * HOUR + 1000));
      expect(later.id).not.toBe(e1.id);
      expect(later.resumed).toBe(false);
    });
  }, SLOW);

  test("a different aid_tracking does not resume, and aid_tracking must be passed, even as NULL", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const tracked = await open(db, at(0), PAGE, "l1", 1);
      const untracked = await open(db, at(1), PAGE, "l1", null);
      expect(untracked.id).not.toBe(tracked.id);
      expect(untracked.resumed).toBe(false);
      expect(await open(db, at(2), PAGE, "l1", null)).toEqual({ ...untracked, resumed: true });
      expect(await error(db.query("SELECT * FROM school.open_encounter('c', 'l1', $1, $2)", [PAGE, at(3)])))
        .toMatch(/^function school\.open_encounter\(.*\) does not exist$/);
    });
  }, SLOW);

  test("any ms the model accepts is stored exactly, past 2^31", async () => {
    const db = await fresh();
    const big = [2 ** 31, Number.MAX_SAFE_INTEGER];
    const ids: string[] = [];
    await as(db, "school_app", async () => {
      const e = await open(db);
      for (const [i, ms] of big.entries()) {
        const id = uuid();
        ids.push(id);
        expect(await submit(db, { encounter: e.id, block: i === 0 ? "q1" : "q2", ms, id })).toMatchObject({ status: "stored" });
        expect(await saveExplanation(db, { encounter: e.id, ms, id })).toBe("stored");
      }
    });
    const stored = await as(db, "school_owner", async () => ({
      answers: (await db.query<{ ms: string }>("SELECT ms::text FROM school.answers WHERE submission_id = ANY($1::uuid[]) ORDER BY seq", [ids])).rows.map((r) => r.ms),
      explanations: (await db.query<{ ms: string }>("SELECT ms::text FROM school.explanations WHERE submission_id = ANY($1::uuid[]) ORDER BY seq", [ids])).rows.map((r) => r.ms),
    }));
    expect(stored).toEqual({ answers: big.map(String), explanations: big.map(String) });
    const types = (await db.query<{ col: string; type: string }>(`SELECT table_name || '.' || column_name AS col, data_type AS type
      FROM information_schema.columns WHERE table_schema = 'school' AND column_name = 'ms' ORDER BY 1`)).rows;
    expect(types).toEqual([{ col: "answers.ms", type: "bigint" }, { col: "explanations.ms", type: "bigint" }]);
  }, SLOW);

  test("a reused submission id with a NULL encounter, block or choice is a conflict, as on SQLite", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e = await open(db);
      const id = uuid();
      expect(await submit(db, { encounter: e.id, id })).toMatchObject({ status: "stored" });
      for (const args of [[id, null, "q1", "right"], [id, e.id, null, "right"], [id, e.id, "q1", null]]) {
        const r = (await db.query<Submitted>("SELECT * FROM school.submit($1, $2, $3, $4, 1, $5)", [...args, at(9)])).rows[0];
        expect(`${JSON.stringify(args.slice(1))}: ${r?.status}`).toBe(`${JSON.stringify(args.slice(1))}: conflict`);
      }
    });
  }, SLOW);

  test("lesson progress lists each lesson's quizzes ever answered correctly", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e1 = await open(db, at(0));
      await submit(db, { encounter: e1.id, block: "q2", choice: "right" });
      await submit(db, { encounter: e1.id, block: "q1", choice: "wrong" });
      const e2 = await open(db, at(0), page("l2", [quiz("q1")]), "l2");
      await submit(db, { encounter: e2.id, block: "q1", choice: "right" });
      const p = (await db.query<{ p: unknown }>("SELECT school.lesson_progress('c') AS p")).rows[0]!.p;
      expect(p).toEqual({ l1: ["q2"], l2: ["q1"] });
      expect((await db.query<{ p: unknown }>("SELECT school.lesson_progress('other') AS p")).rows[0]!.p).toEqual({});
    });
  }, SLOW);

  test("explanations: saved once, duplicates and conflicts detected, only into an explain block", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e = await open(db);
      const id = uuid();
      expect(await saveExplanation(db, { encounter: e.id, id, text: "Because reasons." })).toBe("stored");
      expect(await saveExplanation(db, { encounter: e.id, id, text: "Because reasons.", when: at(9) })).toBe("duplicate");
      expect(await saveExplanation(db, { encounter: e.id, id, text: "Other." })).toBe("conflict");
      expect(await saveExplanation(db, { encounter: e.id, block: "q1" })).toBe("rejected");
      expect(await saveExplanation(db, { encounter: uuid() })).toBe("rejected");
      const saved = (await db.query<{ submission_id: string; block_id: string; text: string; block: unknown; grading: unknown }>(
        "SELECT submission_id, block_id, text, block, grading FROM school.explanation($1)", [id])).rows;
      expect(saved).toEqual([{ submission_id: id, block_id: "e1", text: "Because reasons.", block: explain, grading: null }]);
      expect((await db.query("SELECT * FROM school.explanation($1)", [uuid()])).rows).toEqual([]);
    });
  }, SLOW);

  test("gradings: each attempt is a row, a retry supersedes the latest, and reads see the latest", async () => {
    const db = await fresh();
    await as(db, "school_app", async () => {
      const e = await open(db);
      const old = uuid(), latest = uuid();
      await saveExplanation(db, { encounter: e.id, id: old, text: "First go.", when: at(1) });
      await saveExplanation(db, { encounter: e.id, id: latest, text: "Second go.", when: at(1) }); // same at: seq orders them
      const first = await recordGrading(db, latest, at(2), false);
      expect(first).toEqual({ id: first.id, status: "failed", findings: null, error: "the bridge could not be reached", model: null, supersedes: null, at: at(2) });
      const second = await recordGrading(db, latest, at(3));
      expect(second).toEqual({ id: second.id, status: "succeeded", findings: FINDINGS, error: null, model: "m", supersedes: first.id, at: at(3) });
      expect(await error(db.query("SELECT school.record_grading($1, 'failed', 'r', 'p', 'a', null, '[]', null, null, 'x', $2)", [uuid(), at(4)])))
        .toBe("no explanation with that submission id");
      const rows = (await db.query("SELECT submission_id, block_id, text, grading FROM school.encounter_explanations($1) ORDER BY seq", [e.id])).rows;
      expect(rows).toEqual([{ submission_id: latest, block_id: "e1", text: "Second go.", grading: second }]);
      const one = (await db.query<{ grading: unknown }>("SELECT grading FROM school.explanation($1)", [latest])).rows[0]!.grading;
      expect(one).toEqual(second);
    });
    // A grading can only supersede an attempt on the same submission, and each attempt only once.
    const rows = await as(db, "school_owner", async () => (await db.query<{ seq: number; supersedes: number | null }>(
      "SELECT seq::int, supersedes::int FROM school.gradings ORDER BY seq")).rows);
    const msg = await as(db, "school_owner", () => error(db.query(`INSERT INTO school.gradings
      (submission_id, status, rubric_version, prompt_version, adapter, sources, error, supersedes, at)
      SELECT submission_id, 'failed', 'r', 'p', 'a', '[]', 'x', $1, $2 FROM school.gradings WHERE seq = $1`, [rows[0]!.seq, at(5)])));
    expect(msg).toContain("gradings_supersedes_once");
  }, SLOW);

  test("every evidence row takes its seq from one shared sequence, in the order written", async () => {
    const db = await fresh();
    await populate(db);
    const seqs = await as(db, "school_owner", async () => (await db.query<{ t: string; seq: number }>(`
      SELECT 'snapshots' AS t, seq::int FROM school.snapshots UNION ALL SELECT 'encounters', seq::int FROM school.encounters
      UNION ALL SELECT 'answers', seq::int FROM school.answers UNION ALL SELECT 'explanations', seq::int FROM school.explanations
      UNION ALL SELECT 'gradings', seq::int FROM school.gradings UNION ALL SELECT 'views', seq::int FROM school.views
      UNION ALL SELECT 'exposures', seq::int FROM school.exposures ORDER BY seq`)).rows);
    expect(seqs.map((r) => r.t)).toEqual(["snapshots", "encounters", "answers", "explanations", "gradings", "views", "exposures"]);
    expect(new Set(seqs.map((r) => r.seq)).size).toBe(seqs.length);
  }, SLOW);

  test("exposures name a known kind, and an encounter records whether aid was tracked", async () => {
    const db = await fresh();
    const { encounter } = await populate(db);
    await as(db, "school_app", async () => {
      expect(await error(db.query("SELECT school.record_exposure($1, 'e1', 'peeking', $2)", [encounter, at(6)]))).toContain("exposures_kind");
      expect(await error(db.query("SELECT school.record_exposure($1, 'e1', 'hint', $2)", [uuid(), at(6)]))).toContain("exposures_encounter_id_fkey");
      const untracked = await open(db, at(0), page("l3", [quiz("q1")]), "l3");
      expect(untracked.resumed).toBe(false);
    });
    const tracking = await as(db, "school_owner", async () => (await db.query("SELECT lesson, aid_tracking FROM school.encounters ORDER BY seq")).rows);
    expect(tracking).toEqual([{ lesson: "l1", aid_tracking: 1 }, { lesson: "l3", aid_tracking: null }]);
  }, SLOW);
});
