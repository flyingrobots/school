// Opening the learner's record: the driver SCHOOL_DATABASE_URL selects, migrated as the owner, then
// handed to the server as school_app (RFC 3 v0.4.0 §3.1, §4; flyingrobots/school#47).
//
// - `pglite:<dir>`: PGlite on disk, in this process. Its one session migrates as the superuser it
//   starts as, then switches for good with SET ROLE school_app, as the tests do.
// - `postgres://...`: Bun.SQL. The URL's user must be able to create roles (in practice the
//   database's superuser): the runner needs it. Migrations run on one reserved connection; every
//   request's statement then runs as school_app with SET LOCAL ROLE (server/adapters/bunsql.ts).
//
// Either way the startup check below proves that what the server is handed really is school_app
// before a single request is served, and the server is handed only `functionCalls`: a Sql that
// refuses any statement but `SELECT * FROM school.<function>($1, ...)`, the one shape the Postgres
// adapter issues. That matters because both drivers log in as the superuser and only then take
// school_app's role: a script such as `RESET ROLE; DELETE ...` would get the role back. The guard
// refuses it before any driver sees it. It is a guard rail (RFC 3 §3.1), not tamper-proofing: the
// process holds the superuser URL anyway, since it runs the migrations.
import { migrate, OWNER } from "../db/migrate.ts";
import { bunSql, reservedConnection } from "./bunsql.ts";
import { openPglite, pgliteSql } from "./pglite.ts";
import type { Sql } from "./sql.ts";
import type { Target } from "../config.ts";

/** The role every request runs as: it may only EXECUTE the public functions (migration 0001). */
export const APP = "school_app";

export type Opened = {
  /** The record as school_app, for the Postgres adapter. */
  sql: Sql;
  /** The migration versions this start applied. */
  applied: number[];
  /** Where the record is, for the log: never the password. */
  where: string;
  close(): Promise<void>;
};

/**
 * A postgres:// URL as the log names it: scheme, host, port and database only. Never the user or
 * password, which may be in the user info or in the query string (?password=...), nor the query.
 */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "postgres://(unparseable URL)";
  }
}

/** The only statement the server's record may run: one call of a function in schema school, every argument a parameter. */
export const FUNCTION_CALL = /^SELECT \* FROM school\.[a-z_][a-z0-9_]*\((\$[1-9]\d*(, \$[1-9]\d*)*)?\)$/;

/** `sql`, refusing every statement that is not a FUNCTION_CALL before it reaches the driver. */
export function functionCalls(sql: Sql): Sql {
  return {
    query: async <T>(text: string, params: readonly unknown[]) => {
      if (!FUNCTION_CALL.test(text)) throw new Error(`the record runs only function calls, not: ${text.slice(0, 80)}`);
      return sql.query<T>(text, params);
    },
  };
}

export async function openDatabase(target: Target): Promise<Opened> {
  const opened = target.driver === "pglite" ? await openPgliteRecord(target.dir) : await openPostgresRecord(target.url);
  try {
    const who = (await opened.sql.query<{ u: string }>("SELECT current_user AS u", []))[0]?.u;
    if (who !== APP) throw new Error(`requests would run as ${who ?? "nobody"}, not ${APP}`);
  } catch (e) {
    await opened.close();
    throw e;
  }
  return { ...opened, sql: functionCalls(opened.sql) };
}

async function openPgliteRecord(dir: string): Promise<Opened> {
  const db = await openPglite(dir);
  try {
    const { applied } = await migrate(db);
    await db.exec(`SET ROLE ${APP}`);
    return { sql: pgliteSql(db), applied, where: `PGlite at ${dir}`, close: () => db.close() };
  } catch (e) {
    await db.close();
    throw e;
  }
}

async function openPostgresRecord(url: string): Promise<Opened> {
  const pool = new Bun.SQL(url);
  try {
    const conn = await reservedConnection(pool);
    let applied: number[];
    try {
      ({ applied } = await migrate(conn));
      // The runner ends each file as the owner inside its transaction; the session is back to the
      // connecting role here, and the connection goes back to the pool clean.
      const who = (await conn.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
      if (who === OWNER || who === APP) throw new Error(`the migration connection ended as ${who}`);
    } finally {
      conn.release();
    }
    return { sql: bunSql(pool, APP), applied, where: `Postgres at ${redact(url)}`, close: () => pool.close() };
  } catch (e) {
    await pool.close();
    throw e;
  }
}
