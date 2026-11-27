// The conversation tables' storage rules (RFC 6 §5.2, Figure 5.1; flyingrobots/school#225), on every
// driver of the Postgres adapter. The contract (./learning-record.ts) speaks only through the port;
// these speak to the tables, as the roles the migrations create, because the promise is the
// tables': the record is append-only, and school_app reaches it only through the functions.
// Registered on PGlite (server/adapters/postgres.test.ts) and on Bun.SQL
// (server/adapters/bunsql.test.ts) under the same titles, so CI's Postgres gate pairs them.
import { expect, test } from "bun:test";
import type { Block } from "../core/model.ts";
import type { LearningRecord } from "../core/ports.ts";
import type { Sql } from "../adapters/sql.ts";

/** A fresh, migrated record, and its database as each role the migrations create. */
export type RecordTables = { record: LearningRecord; as(role: "school_app" | "school_owner"): Sql };

/** The three tables RFC 6 Figure 5.1 adds. */
export const CONVERSATION_TABLES = ["conversations", "questions", "replies"] as const;

const page: Block = { type: "page", id: "l1", title: "l1", subtitle: "", children: [
  { type: "prose", id: "p1", html: "<p>Bells ring because the metal vibrates.</p>" },
] };
const at = "2026-11-21T10:00:00.000Z";

/** One row in each conversation table, written through the port. */
async function populate(r: LearningRecord): Promise<void> {
  const e = await r.openEncounter({ course: "c", lesson: "l1", page, now: at, aidTracking: 1 });
  const questionId = crypto.randomUUID();
  expect(await r.ask({ conversationId: crypto.randomUUID(), questionId, encounterId: e.id, blockId: "p1", passage: "the metal vibrates",
    text: "Why?" }, at)).toEqual({ status: "stored" });
  expect(await r.recordReply({ questionId, status: "succeeded", text: "Because.", error: null, sources: [], agent: "a", model: null, usage: null }, at))
    .toEqual({ status: "stored" });
}

async function counts(owner: Sql): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of CONVERSATION_TABLES) out[t] = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM school.${t}`, []))[0]!.n;
  return out;
}

export function conversationTables(name: string, open: () => Promise<RecordTables>): void {
  // Known failure mode (flyingrobots/school#225, 2e): a direct table write path for school_app.
  test(`${name}: conversations: school_app may not insert, update, delete, read or truncate a conversation table`, async () => {
    const db = await open();
    await populate(db.record);
    const app = db.as("school_app");
    const owner = db.as("school_owner");
    const before = await counts(owner);
    let refused = 0;
    for (const t of CONVERSATION_TABLES) {
      for (const text of [`INSERT INTO school.${t} DEFAULT VALUES`, `UPDATE school.${t} SET at = at`, `DELETE FROM school.${t}`,
        `SELECT * FROM school.${t}`, `TRUNCATE school.${t}`]) {
        await expect(app.query(text, []), `school_app: ${text}`).rejects.toThrow(`permission denied for table ${t}`);
        refused++;
      }
    }
    expect(refused).toBe(15);
    expect(await counts(owner)).toEqual(before);
  });

  test(`${name}: conversations: every conversation table refuses update, delete and truncate, even by its owner`, async () => {
    const db = await open();
    await populate(db.record);
    const owner = db.as("school_owner");
    // A row trigger fires only on a row, so each table holds one.
    expect(await counts(owner)).toEqual({ conversations: 1, questions: 1, replies: 1 });
    for (const t of CONVERSATION_TABLES) {
      for (const text of [`UPDATE school.${t} SET at = at`, `DELETE FROM school.${t}`, `TRUNCATE school.${t} CASCADE`]) {
        await expect(owner.query(text, []), `school_owner: ${text}`).rejects.toThrow(`${t} are append-only`);
      }
    }
    expect(await counts(owner)).toEqual({ conversations: 1, questions: 1, replies: 1 });
  });
}
