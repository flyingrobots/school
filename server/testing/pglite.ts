// The PGlite driver of the Sql port (server/adapters/sql.ts), for tests. It lives in testing/, so it
// is not shipped in the image (server/.dockerignore): PGlite is a dev dependency. PGlite parses timestamptz as a Date, jsonb as a
// value and int8 as a number; the Postgres adapter parses each with Zod either way.
import type { PGliteInterface } from "@electric-sql/pglite";
import type { Sql } from "../adapters/sql.ts";

/** `db` as the Sql port. It runs statements in whatever role the session holds; the caller sets it. */
export function pgliteSql(db: Pick<PGliteInterface, "query">): Sql {
  return {
    query: async <T>(text: string, params: readonly unknown[]) => (await db.query<T>(text, [...params])).rows,
  };
}
