// Opening the learner's record: the driver SCHOOL_DATABASE_URL selects, handed to the server as
// school_app (RFC 3 v0.4.0 §3.1, §4; flyingrobots/school#47, flyingrobots/school#91).
//
// - `postgres://...`: Bun.SQL, logged in as school_app with its own password. The server never
//   migrates a Postgres record and never holds the owner's or the superuser's URL: the migrate job
//   does that, before the server starts (`migrateRecord` below; `server/migrate.ts`; the `migrate`
//   service in server/compose.yaml). Before serving, the server proves its login is school_app and
//   nothing more (`loginRefusals`): not a superuser, a member of no role, the owner of nothing, no
//   privilege on any table, no CREATE anywhere, no temporary tables, and a write probe that is
//   denied. Any of those, and it refuses to start (`Refused`).
// - `pglite:<dir>`: PGlite on disk, in this process, for development and tests. Its one session is
//   the superuser PGlite starts as, so it keeps the single-process path: it migrates, then switches
//   for good with SET ROLE school_app. It has no login to check, and so none of the checks above.
//
// Either way the server is handed only `functionCalls`: a Sql that refuses any statement but
// `SELECT * FROM school.<function>($1, ...)`, the one shape the Postgres adapter issues, and every
// Bun.SQL statement still runs with SET LOCAL ROLE school_app (server/adapters/bunsql.ts). On
// Postgres those are defence in depth behind the login; on PGlite, whose session could
// `RESET ROLE` back to the superuser, they are the guard rail (RFC 3 §3.1), not tamper-proofing.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { migrate, OWNER } from "../db/migrate.ts";
import { bunSql, reservedConnection } from "./bunsql.ts";
import { openPglite, pgliteSql } from "./pglite.ts";
import type { Sql } from "./sql.ts";
import type { Target } from "../config.ts";

/** The role every request runs as: it may only EXECUTE the public functions (migration 0001). */
export const APP = "school_app";

/** The server will not serve from this login: it may do more than school_app may, or is not school_app. */
export class Refused extends Error {}

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

type Pool = InstanceType<typeof Bun.SQL>;

async function openPostgresRecord(url: string): Promise<Opened> {
  const pool = new Bun.SQL(url);
  try {
    const refusals = await loginRefusals(pool);
    if (refusals.length > 0) {
      throw new Refused(`the server logs into Postgres only as ${APP}, with a login that may do nothing but EXECUTE the granted functions; ` +
        `this one ${refusals.join("; ")}. Give the server school_app's URL, and the owner's or superuser's URL only to the migrate job (server/migrate.ts)`);
    }
    // No migrations here: the migrate job applied them before the server started.
    return { sql: bunSql(pool, APP), applied: [], where: `Postgres at ${redact(url)} as ${APP}`, close: () => pool.close() };
  } catch (e) {
    await pool.close();
    throw e;
  }
}

type Login = {
  cu: string; su: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean;
  school: boolean; owns_school: boolean | null; member_of: string[] | null; owns: string[] | null; tables: string[] | null;
  create_in: string[] | null; db_create: boolean; db_temp: boolean;
};

/** What the login's privileges are, as the catalog and the privilege functions report them, for this database. */
const LOGIN = `
SELECT current_user AS cu, session_user AS su,
  r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'school') AS school,
  (SELECT n.nspowner = r.oid FROM pg_namespace n WHERE n.nspname = 'school') AS owns_school,
  (SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
  (SELECT array_agg(o ORDER BY o) FROM (
     SELECT 'schema ' || nspname AS o FROM pg_namespace WHERE nspowner = r.oid
     UNION ALL SELECT 'relation ' || c.oid::regclass::text FROM pg_class c WHERE c.relowner = r.oid
     UNION ALL SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.proowner = r.oid
     UNION ALL SELECT 'type ' || t.oid::regtype::text FROM pg_type t WHERE t.typowner = r.oid AND t.typrelid = 0) owned) AS owns,
  (SELECT array_agg(c.oid::regclass::text ORDER BY c.oid::regclass::text) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) AS tables,
  (SELECT array_agg(nspname::text ORDER BY nspname) FROM pg_namespace WHERE has_schema_privilege(oid, 'CREATE')) AS create_in,
  has_database_privilege(current_database(), 'CREATE') AS db_create,
  has_database_privilege(current_database(), 'TEMPORARY') AS db_temp
FROM pg_roles r WHERE r.rolname = current_user`;

/** Statements school_app must be denied (SQLSTATE 42501), tried in a transaction that is always rolled back. */
const PROBES: [what: string, sql: string][] = [
  ["create a table in schema school", "CREATE TABLE school.school_login_probe (x int)"],
  ["write a table", "INSERT INTO school.views (course, lesson, at) VALUES ('school_login_probe', 'school_login_probe', now())"],
  ["truncate a table", "TRUNCATE school.views"],
  ["run a program with COPY", "COPY (SELECT 1) TO PROGRAM 'true'"],
];

const ROLLBACK = new Error("roll the probe back");

/**
 * Every way the login `pool` connects with may do more than school_app may, as clauses for the
 * refusal ("is a superuser", ...). Empty when it is school_app and may only EXECUTE.
 */
export async function loginRefusals(pool: Pool): Promise<string[]> {
  const l = [...await pool.unsafe(LOGIN)][0] as Login | undefined;
  if (l === undefined) return ["has no row in pg_roles"];
  const out: string[] = [];
  if (l.cu !== APP || l.su !== APP) out.push(`logs in as ${l.su}${l.cu === l.su ? "" : ` (running as ${l.cu})`}, not ${APP}`);
  if (l.rolsuper) out.push("is a superuser");
  for (const [flag, on] of [["CREATEROLE", l.rolcreaterole], ["CREATEDB", l.rolcreatedb], ["REPLICATION", l.rolreplication], ["BYPASSRLS", l.rolbypassrls]] as const) {
    if (on) out.push(`has ${flag}`);
  }
  for (const g of l.member_of ?? []) out.push(`is a member of ${g}`);
  if (l.owns_school === true) out.push("owns schema school");
  const owns = (l.owns ?? []).filter((o) => o !== "schema school");
  if (owns.length > 0) out.push(`owns ${owns.length} object(s), such as ${owns.slice(0, 3).join(", ")}`);
  if ((l.tables ?? []).length > 0) out.push(`has privileges on ${l.tables!.join(", ")}`);
  for (const n of l.create_in ?? []) out.push(`may create objects in schema ${n}`);
  if (l.db_create) out.push("may create schemas in this database");
  if (l.db_temp) out.push("may create temporary tables in this database (the migrate job revokes TEMPORARY from PUBLIC)");
  if (!l.school) {
    out.push("finds that schema school does not exist: run the migrate job on this database first");
    return out; // the probes need the schema
  }
  // The catalog could miss a way in; a write that succeeds would not. Probed only once the catalog
  // finds nothing, so a superuser's login is never used to run even `true` through COPY.
  if (out.length > 0) return out;
  for (const [what, statement] of PROBES) {
    const r = await deniedOrNot(pool, statement);
    if (r !== "42501") out.push(r === "ok" ? `could ${what}` : `could not be shown unable to ${what} (SQLSTATE ${r})`);
  }
  return out;
}

/** The SQLSTATE `statement` fails with on `pool`, or "ok": in a transaction rolled back either way. */
async function deniedOrNot(pool: Pool, statement: string): Promise<string> {
  try {
    await pool.begin(async (tx) => {
      await tx.unsafe(statement);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e === ROLLBACK) return "ok";
    return String((e as { errno?: unknown }).errno ?? "unknown");
  }
  return "ok";
}

/** school_app's password: letters and digits only, since compose puts it into a URL as it is. */
const APP_PASSWORD = /^[A-Za-z0-9]{20,}$/;

/**
 * The migrate job (flyingrobots/school#91): connected with `url`, the owner's or superuser's URL,
 * apply every pending migration as school_owner (server/db/migrate.ts), then make school_app a
 * login with `appPassword` and nothing else, and revoke PUBLIC's TEMPORARY on this database so the
 * server's login cannot create temporary tables. Idempotent: a second run applies nothing and sets
 * the same password again. The password reaches Postgres only as a SCRAM-SHA-256 verifier, never
 * as text, so not even a statement log holds it.
 */
export async function migrateRecord(url: string, appPassword: string): Promise<{ applied: number[] }> {
  if (!APP_PASSWORD.test(appPassword)) {
    throw new Error("SCHOOL_APP_PASSWORD must be at least 20 letters and digits (it goes into a URL as it is); " +
      "generate one, e.g. `openssl rand -base64 32 | tr -d '/+='`");
  }
  const pool = new Bun.SQL(url);
  try {
    const conn = await reservedConnection(pool);
    try {
      const { applied } = await migrate(conn);
      const who = (await conn.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
      if (who === OWNER || who === APP) throw new Error(`the migration connection ended as ${who}`);
      const db = (await conn.query<{ d: string }>("SELECT quote_ident(current_database()) AS d")).rows[0]!.d;
      // One job at a time on this database, as for the migrations. The role is cluster-wide, so a
      // job on another database can still update it at the same moment: that one is retried.
      for (let attempt = 1; ; attempt++) {
        await conn.exec("BEGIN");
        try {
          await conn.exec("SELECT pg_advisory_xact_lock(hashtext('school.migrate_job'))");
          await conn.exec(`ALTER ROLE ${APP} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${scramVerifier(appPassword)}'`);
          await conn.exec(`REVOKE CREATE, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
          await conn.exec("COMMIT");
          break;
        } catch (e) {
          await conn.exec("ROLLBACK");
          if (attempt >= 5 || !/tuple concurrently updated/.test((e as Error).message)) throw e;
          await Bun.sleep(50 * attempt);
        }
      }
      return { applied };
    } finally {
      conn.release();
    }
  } finally {
    await pool.close();
  }
}

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 5802, RFC 7677), in the form Postgres stores in
 * pg_authid and accepts as a PASSWORD: `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`.
 * Only letters, digits, `+/=`, `$` and `:`, so it is safe inside a string literal.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
