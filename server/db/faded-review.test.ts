// Migration 0014 at the SQL level: due review gains the faded rule and nothing else moves (RFC 5
// §4.6; flyingrobots/school#219). The function keeps its signature, return type, volatility,
// security, search_path and grant; and on random histories its three weak rules return exactly what
// 0012's due_review (the one 0013 left in place) returns, with faded items only after them. What the
// rule returns case by case is the contract's (server/contract/learning-record.ts).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate } from "./migrate.ts";
import { REVIEW_DELAY_MS } from "../core/school.ts";

setDefaultTimeout(120_000); // PGlite starts a whole Postgres in process.

const opened: PGlite[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const shipped = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const file = (prefix: string) => {
  const f = shipped.find((x) => x.startsWith(prefix));
  if (f === undefined) throw new Error(`no migration ${prefix}_*.sql in ${MIGRATIONS}`);
  return f;
};

/** A database migrated through 0013, the state 0014 replaces due_review in, and the folder it came from. */
async function at0013(): Promise<{ db: PGlite; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "school-0013-"));
  dirs.push(dir);
  for (const f of shipped.filter((f) => f < "0014")) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  const db = new PGlite();
  opened.push(db);
  await migrate(db, dir);
  return { db, dir };
}

const DESCRIBE = `
  SELECT p.oid::regprocedure::text AS signature, pg_get_function_result(p.oid) AS result, p.provolatile AS volatility,
         p.prosecdef AS definer, p.proconfig AS config, l.lanname AS language,
         has_function_privilege('school_app', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS public
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'school' AND p.proname = 'due_review'`;

test("0014 replaces due_review keeping its signature, result, volatility, security, search_path and grant", async () => {
  const { db, dir } = await at0013();
  const before = (await db.query(DESCRIBE)).rows;
  // Oracle: 0012's definition, which 0013 left in place.
  expect(before).toEqual([{
    signature: "school.due_review(text,jsonb,timestamp with time zone,bigint,integer)", result: "TABLE(item jsonb)", volatility: "s",
    definer: true, config: ["search_path=school, pg_temp"], language: "sql", app: true, public: false,
  }]);
  const f = file("0014");
  copyFileSync(join(MIGRATIONS, f), join(dir, f));
  expect(await migrate(db, dir)).toEqual({ applied: [14] });
  expect((await db.query(DESCRIBE)).rows).toEqual(before);
});

// ---- The differential: old and new on random histories ------------------------------------------

/** A small seeded generator (mulberry32), so a case replays from its seed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** CI's fixed seed; SCHOOL_TEST_SEED replays or explores another. */
const SEED = Number(process.env.SCHOOL_TEST_SEED ?? 219);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BLOCKS = ["q0", "q1", "q2", "q3"];
const CONTENT = JSON.stringify({
  type: "page", id: "l", title: "L", subtitle: "", children: BLOCKS.map((id) => ({
    type: "quiz", id, q: "?", why: ".", choices: [{ id: "right", text: "R", correct: true }, { id: "wrong", text: "W", correct: false }],
  })),
});
/** The gaps between study sessions: within the delay, about the delay, and around one and several stabilities. */
const GAPS = [MINUTE, 2 * HOUR, 15 * HOUR, REVIEW_DELAY_MS, DAY, 2.5 * DAY, 5 * DAY, 12 * DAY];

type Item = { blockId: string; rule: string; answeredAt: string; corrected: boolean; shown: string[]; lastSeen: string; evidence: number[] };
type Held = { blockId: string; strength: number | null; settled: boolean; evidence: number[] };

test("on random histories the three weak rules return exactly what 0012's due_review does, and faded items only fill what they leave", async () => {
  const { db, dir } = await at0013();
  // 0012's due_review as it stands at 0013, kept beside the new one under another name.
  const old = readFileSync(join(MIGRATIONS, file("0012")), "utf8").match(/CREATE OR REPLACE FUNCTION school\.due_review\([\s\S]*?\n\$\$;/);
  if (old === null) throw new Error("0012 holds no due_review");
  await db.exec(old[0].replace("FUNCTION school.due_review(", "FUNCTION school.due_review_0012("));
  const f = file("0014");
  copyFileSync(join(MIGRATIONS, f), join(dir, f));
  await migrate(db, dir);

  const replay = `replay: SCHOOL_TEST_SEED=${SEED} bun test server/db/faded-review.test.ts`;
  console.log(replay);
  const rand = seeded(SEED);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const iso = (ms: number) => new Date(ms).toISOString();
  const seen = { identical: 0, fadedAdded: 0, weakFilledLimit: 0, fadedCutByLimit: 0, weakAndFaded: 0 };

  for (let h = 0; h < 60; h++) {
    const course = `c${h}`;
    let t = Date.parse("2026-01-01T09:00:00Z");
    for (let s = 0, sessions = 3 + Math.floor(rand() * 10); s < sessions; s++) {
      t += pick(GAPS);
      const tracked = rand() > 0.15;
      const e = (await db.query<{ id: string }>("SELECT id FROM school.open_encounter($1, 'l', $2, $3, $4)",
        [course, CONTENT, iso(t), tracked ? 1 : null])).rows[0]!.id;
      if (tracked && rand() < 0.1) await db.query("SELECT school.record_lesson_help($1, $2, 'ai-help', $3)", [crypto.randomUUID(), e, iso(t)]);
      for (const b of BLOCKS.filter(() => rand() < 0.6)) {
        t += MINUTE;
        if (tracked && rand() < 0.2) await db.query("SELECT school.record_exposure($1, $2, $3, 'hint', $4)", [crypto.randomUUID(), e, b, iso(t)]);
        const right = rand() < 0.7;
        await db.query("SELECT school.submit($1, $2, $3, $4, 1, $5)", [crypto.randomUUID(), e, b, right ? "right" : "wrong", iso(t)]);
        if (!right && rand() < 0.6) await db.query("SELECT school.submit($1, $2, $3, 'right', 1, $4)", [crypto.randomUUID(), e, b, iso(t + 1000)]);
      }
    }
    const lastSeen = new Map((await db.query<{ block_id: string; at: Date }>(`
      SELECT DISTINCT ON (a.block_id) a.block_id, a.at FROM school.answers a JOIN school.encounters e ON e.id = a.encounter_id
      WHERE e.course = $1 ORDER BY a.block_id, a.seq DESC`, [course])).rows.map((x) => [x.block_id, x.at.getTime()]));

    for (let q = 0; q < 5; q++) {
      const now = t + Math.floor(rand() * 30 * DAY);
      const blocks = rand() < 0.5 ? BLOCKS : BLOCKS.filter(() => rand() < 0.7);
      const limit = Math.floor(rand() * 6);
      const args = [course, JSON.stringify(blocks), iso(now), REVIEW_DELAY_MS, limit];
      const before = (await db.query<{ item: Item }>("SELECT item FROM school.due_review_0012($1, $2::jsonb, $3, $4, $5)", args)).rows.map((x) => x.item);
      const after = (await db.query<{ item: Item }>("SELECT item FROM school.due_review($1, $2::jsonb, $3, $4, $5)", args)).rows.map((x) => x.item);
      const held = (await db.query<{ item: Held }>("SELECT item FROM school.mastery($1, $2::jsonb, $3, $4)", args.slice(0, 4))).rows.map((x) => x.item);
      const where = { h, q, course, now: iso(now), blocks, limit };

      // Weak items: exactly the old function's, in its order, at the head of the list.
      expect({ where, weak: after.slice(0, before.length) }, replay).toEqual({ where, weak: before });
      // Faded items: independently, every settled quiz below one half, seen at least the delay ago
      // and not a weak item, lowest strength first, then by the first try that refreshed it.
      const weakIds = new Set(before.map((x) => x.blockId));
      const eligible = held
        .filter((m) => m.settled && m.strength !== null && m.strength < 0.5 && !weakIds.has(m.blockId) && now - lastSeen.get(m.blockId)! >= REVIEW_DELAY_MS)
        .sort((a, b) => a.strength! - b.strength! || Math.max(...a.evidence) - Math.max(...b.evidence));
      const room = Math.max(limit - before.length, 0);
      const faded = after.slice(before.length);
      expect({ where, faded: faded.map((x) => [x.blockId, x.rule, x.evidence]) }, replay)
        .toEqual({ where, faded: eligible.slice(0, room).map((m) => [m.blockId, "due-review/faded", m.evidence]) });
      // The claim of RFC 5 §4.6: on a history with no faded quiz, nothing changes at all.
      if (eligible.length === 0) expect({ where, after }, replay).toEqual({ where, after: before });

      if (eligible.length === 0) seen.identical++;
      if (faded.length > 0) seen.fadedAdded++;
      if (before.length === limit && limit > 0) seen.weakFilledLimit++;
      if (eligible.length > room) seen.fadedCutByLimit++;
      if (before.length > 0 && faded.length > 0) seen.weakAndFaded++;
    }
  }
  // Witnesses: the fixed seed reaches each kind of case.
  console.log(`faded review differential: ${JSON.stringify(seen)}`);
  for (const [what, k] of Object.entries(seen)) expect(`${what}: ${k > 0}`, replay).toBe(`${what}: true`);
});
