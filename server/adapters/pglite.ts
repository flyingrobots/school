// The PGlite driver of the Sql port (server/adapters/sql.ts): a whole Postgres in the server's own
// process, on disk in one directory. It is what `pglite:<dir>` selects (server/adapters/database.ts),
// so a learner runs School with no Postgres to install, and what the tests run on.
//
// PGlite is one session, so it needs no reserved connection: the migration runner gets it as is.
// PGlite parses timestamptz as a Date, jsonb as a value and int8 as a number; the Postgres adapter
// parses each with Zod either way.
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import type { Sql } from "./sql.ts";

/** `db` as the Sql port. It runs statements in whatever role the session holds; the caller sets it. */
export function pgliteSql(db: Pick<PGliteInterface, "query">): Sql {
  return {
    query: async <T>(text: string, params: readonly unknown[]) => (await db.query<T>(text, [...params])).rows,
  };
}

/** PGlite on disk in `dir`, created with its parents on first use. Its one session starts as the superuser. */
export async function openPglite(dir: string): Promise<PGlite> {
  mkdirSync(dir, { recursive: true });
  return PGlite.create(dir);
}
