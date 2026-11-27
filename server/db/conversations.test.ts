// Migration 0017 on PGlite: the conversation tables and their functions (RFC 6 §5.2, Figure 5.1,
// Table 5.3; flyingrobots/school#225). What the port makes of them is the contract's
// (server/contract/learning-record.ts) and the tables' append-only rules are
// server/contract/conversation-tables.ts; these are the SQL-level facts the port cannot see.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "./migrate.ts";

setDefaultTimeout(60_000); // PGlite starts a whole Postgres in process.

const opened: PGlite[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
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
  { type: "prose", id: "p1", html: "<p>Bells ring because the metal vibrates.</p>" },
] });

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}
const tracked = (db: PGlite) => as(db, "school_app", async () =>
  (await db.query<{ id: string }>("SELECT * FROM school.open_encounter('c', 'l1', $1, $2, 1)", [PAGE, at()])).rows[0]!.id);
const ask = (db: PGlite, o: { conversation?: string; question?: string; encounter: string; block?: string | null; passage?: string | null; text?: string }) =>
  as(db, "school_app", async () => (await db.query<{ s: string }>("SELECT school.ask($1, $2, $3, $4, $5, $6, $7) AS s", [
    o.conversation ?? uuid(), o.question ?? uuid(), o.encounter, o.block === undefined ? "p1" : o.block,
    o.passage === undefined ? "the metal vibrates" : o.passage, o.text ?? "Why?", at(1),
  ])).rows[0]!.s);
const counts = async (db: PGlite) => (await db.query<{ conversations: number; questions: number; replies: number; exposures: number }>(`
  SELECT (SELECT count(*)::int FROM school.conversations) AS conversations, (SELECT count(*)::int FROM school.questions) AS questions,
         (SELECT count(*)::int FROM school.replies) AS replies, (SELECT count(*)::int FROM school.exposures) AS exposures`)).rows[0]!;
const signatures = async (db: PGlite, name: string) => (await db.query<{ f: string }>(`
  SELECT pg_get_function_identity_arguments(p.oid) AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'school' AND p.proname = $1`, [name])).rows.map((r) => r.f);

test("0017 adds ask, record_reply and lesson_conversations with RFC 6 Table 5.3's arguments", async () => {
  const db = await fresh();
  expect(await signatures(db, "ask")).toEqual([
    "p_conversation uuid, p_question uuid, p_encounter uuid, p_block text, p_passage text, p_text text, p_at timestamp with time zone"]);
  expect(await signatures(db, "record_reply")).toEqual([
    "p_question uuid, p_status text, p_text text, p_sources jsonb, p_agent text, p_model text, p_usage jsonb, p_error text, p_at timestamp with time zone"]);
  expect(await signatures(db, "lesson_conversations")).toEqual(["p_course text, p_lesson text"]);
});

// One transaction (RFC 6 Table 5.3): a question the table refuses takes its exposure and its
// conversation with it.
test("a question the table refuses stores no exposure and opens no conversation", async () => {
  const db = await fresh();
  const e = await tracked(db);
  await expect(ask(db, { encounter: e, text: "x".repeat(4001) })).rejects.toThrow("questions_text");
  await expect(ask(db, { encounter: e, text: "" })).rejects.toThrow("questions_text");
  await expect(ask(db, { encounter: e, passage: "x".repeat(2001) })).rejects.toThrow("conversations_passage");
  expect(await counts(db)).toEqual({ conversations: 0, questions: 0, replies: 0, exposures: 0 });
  expect(await ask(db, { encounter: e })).toBe("stored");
  expect(await counts(db)).toEqual({ conversations: 1, questions: 1, replies: 0, exposures: 1 });
});

test("a question's exposure is an ai-help exposure of its own encounter, with a smaller seq", async () => {
  const db = await fresh();
  const e = await tracked(db);
  await ask(db, { encounter: e });
  const rows = (await db.query<{ ok: boolean }>(`
    SELECT x.kind = 'ai-help' AND x.block_id IS NULL AND x.encounter_id = q.encounter_id AND x.seq < q.seq AS ok
    FROM school.questions q JOIN school.exposures x ON x.seq = q.exposure_seq`)).rows;
  expect(rows).toEqual([{ ok: true }]);
});

test("the tables hold one reply per question, and a question to one exposure of its own encounter", async () => {
  const db = await fresh();
  const e = await tracked(db);
  const other = await as(db, "school_app", async () =>
    (await db.query<{ id: string }>("SELECT * FROM school.open_encounter('c', 'l2', $1, $2, 1)", [PAGE.replace('"id":"l1"', '"id":"l2"'), at()])).rows[0]!.id);
  const question = uuid();
  await ask(db, { encounter: e, question });
  await as(db, "school_owner", async () => {
    const reply = () => db.query("INSERT INTO school.replies (question_id, status, text, sources, error, at) VALUES ($1, 'failed', '', '[]', 'x', $2)",
      [question, at(2)]);
    await reply();
    await expect(reply()).rejects.toThrow("replies_question");
    const q = (await db.query<{ conversation_id: string; exposure_seq: number }>("SELECT conversation_id, exposure_seq FROM school.questions")).rows[0]!;
    // The same exposure for a second question, or a question in another encounter than its exposure's.
    await expect(db.query("INSERT INTO school.questions (question_id, conversation_id, encounter_id, text, exposure_seq, at) VALUES ($1, $2, $3, 'Again?', $4, $5)",
      [uuid(), q.conversation_id, e, q.exposure_seq, at(3)])).rejects.toThrow("questions_exposure");
    await expect(db.query("INSERT INTO school.questions (question_id, conversation_id, encounter_id, text, exposure_seq, at) VALUES ($1, $2, $3, 'Again?', $4, $5)",
      [uuid(), q.conversation_id, other, q.exposure_seq, at(3)])).rejects.toThrow("questions_exposure");
  });
  expect(await counts(db)).toEqual({ conversations: 1, questions: 1, replies: 1, exposures: 1 });
});
