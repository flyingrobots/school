// Opening the learner's record: the driver SCHOOL_DATABASE_URL selects, handed to the server as
// school_app (RFC 3 v0.4.0 §3.1, §4; flyingrobots/school#47, flyingrobots/school#91).
//
// - `postgres://...`: Bun.SQL, logged in as school_app with its own password. The server never
//   migrates a Postgres record and never holds the owner's or the superuser's URL: the migrate job
//   does that, before the server starts (`migrateRecord` below; `server/migrate.ts`; the `migrate`
//   service in server/compose.yaml). Before serving, the server runs the login check
//   (`loginRefusals`): the login is school_app, with none of the role attributes, memberships,
//   ownerships, privileges or grants it lists, and a write probe is denied. Any failure, and it
//   refuses to start (`Refused`). What it checks, what it cannot detect and what school_app can
//   still do are in docs/topics/architecture/README.md, "The login check".
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
import { migrate, OWNER, type OnApplied } from "../db/migrate.ts";
import { bunSql, reservedConnection } from "./bunsql.ts";
import { renameCourse, type Renamed } from "../db/rename-course.ts";
import { openPglite, pgliteSql } from "./pglite.ts";
import type { Sql } from "./sql.ts";
import type { Target } from "../config.ts";

/** The role every request runs as: it may only EXECUTE the public functions (migration 0001). */
export const APP = "school_app";

/** The server will not serve from this login: it failed the login check (`loginRefusals`). */
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
      throw new Refused(`the server logs into Postgres only as ${APP}, with none of the privileges its login check refuses ` +
        `(docs/topics/architecture/README.md, "The login check"); this one ${refusals.join("; ")}. Give the server school_app's URL, and the owner's or superuser's URL only to the migrate job (server/migrate.ts)`);
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
  columns: string[] | null; system: string[] | null; functions: string[] | null; grants: string[] | null; defaults: string[] | null;
  create_in: string[] | null; db_create: boolean; db_temp: boolean;
};

/**
 * The functions the migrations grant school_app, as `schema.name(argument types)`. The only
 * functions outside pg_catalog and information_schema it may execute. A migration that grants
 * another adds it here, or the server refuses to start; app-login.test.ts checks the two agree.
 */
export const GRANTED_FUNCTIONS: readonly string[] = [
  "school.choice_decision_notes(text,text,text)",
  "school.choose_course_trust(uuid,boolean,timestamp with time zone)",
  "school.choose_time_zone(text,timestamp with time zone)",
  "school.course_authoring(text)",
  "school.course_progress(text)",
  "school.decide_draft(uuid,uuid,text,uuid,text,timestamp with time zone)",
  "school.due_review(text,jsonb,timestamp with time zone,bigint,integer)",
  "school.encounter_answers(uuid)",
  "school.encounter_decision_notes(uuid)",
  "school.encounter_evidence(uuid)",
  "school.encounter_explanations(uuid)",
  "school.explanation(uuid)",
  "school.install_course(uuid,text,text,text,text,text,text,text,integer,uuid,uuid,timestamp with time zone)",
  "school.installed_courses()",
  "school.last_studied()",
  "school.latest_feedback()",
  "school.lesson_progress(text)",
  "school.mastery(text,jsonb,timestamp with time zone,bigint)",
  "school.mastery_rollup(text,jsonb,timestamp with time zone,bigint)",
  "school.open_encounter(text,text,text,timestamp with time zone,integer)",
  "school.open_lesson_encounter(text,text,text,text,timestamp with time zone,integer,jsonb)",
  "school.record_decision_note(uuid,text,text,text,uuid,text,text,jsonb,timestamp with time zone)",
  "school.record_draft(uuid,uuid,integer,text,text,text,text,text,integer,integer,timestamp with time zone)",
  "school.record_exposure(uuid,uuid,text,text,timestamp with time zone)",
  "school.record_grading(uuid,text,text,text,text,text,jsonb,text,jsonb,text,timestamp with time zone)",
  "school.record_lesson_help(uuid,uuid,text,timestamp with time zone)",
  "school.record_view(text,text,timestamp with time zone)",
  "school.remove_installed_course(text,timestamp with time zone)",
  "school.request_authoring(uuid,text,uuid,text,text,text,timestamp with time zone)",
  "school.save_explanation(uuid,uuid,text,text,bigint,timestamp with time zone)",
  "school.study_days(timestamp with time zone,timestamp with time zone,text)",
  "school.submission_aid(uuid)",
  "school.submit(uuid,uuid,text,text,bigint,timestamp with time zone)",
  "school.time_zone()",
];

/**
 * The built-in functions (pg_catalog, information_schema) Postgres 18 does not let an ordinary role
 * execute: server files, programs, WAL, replication origins, statistics resets and the like. Every
 * other built-in is executable by PUBLIC as Postgres ships it, and so by any login; the server
 * accepts those. If school_app may execute any of these, by a grant to it or to PUBLIC, it refuses.
 * app-login.test.ts checks this list against the server the tests run on.
 */
export const RESTRICTED_FUNCTIONS: readonly string[] = (
  "lo_export lo_import pg_backup_start pg_backup_stop pg_config pg_create_restore_point pg_current_logfile pg_get_aios " +
  "pg_get_backend_memory_contexts pg_get_shmem_allocations pg_get_shmem_allocations_numa pg_hba_file_rules pg_ident_file_mappings " +
  "pg_log_backend_memory_contexts pg_log_standby_snapshot pg_ls_archive_statusdir pg_ls_dir pg_ls_logdir pg_ls_logicalmapdir " +
  "pg_ls_logicalsnapdir pg_ls_replslotdir pg_ls_summariesdir pg_ls_tmpdir pg_ls_waldir pg_promote pg_read_binary_file pg_read_file " +
  "pg_reload_conf pg_replication_origin_advance pg_replication_origin_create pg_replication_origin_drop pg_replication_origin_oid " +
  "pg_replication_origin_progress pg_replication_origin_session_is_setup pg_replication_origin_session_progress " +
  "pg_replication_origin_session_reset pg_replication_origin_session_setup pg_replication_origin_xact_reset " +
  "pg_replication_origin_xact_setup pg_rotate_logfile pg_show_all_file_settings pg_show_replication_origin_status pg_stat_file " +
  "pg_stat_have_stats pg_stat_reset pg_stat_reset_backend_stats pg_stat_reset_replication_slot pg_stat_reset_shared " +
  "pg_stat_reset_single_function_counters pg_stat_reset_single_table_counters pg_stat_reset_slru pg_stat_reset_subscription_stats " +
  "pg_switch_wal pg_wal_replay_pause pg_wal_replay_resume").split(" ");

/** The built-in relations Postgres 18 does not let an ordinary role SELECT (pg_authid, pg_statistic, ...), likewise checked. */
export const RESTRICTED_RELATIONS: readonly string[] = (
  "_pg_foreign_data_wrappers _pg_foreign_servers _pg_foreign_table_columns _pg_foreign_tables _pg_user_mappings pg_aios pg_authid " +
  "pg_backend_memory_contexts pg_config pg_file_settings pg_hba_file_rules pg_ident_file_mappings pg_largeobject " +
  "pg_replication_origin_status pg_shadow pg_shmem_allocations pg_shmem_allocations_numa pg_statistic pg_statistic_ext_data " +
  "pg_subscription pg_user_mapping sql_parts transforms").split(" ");

const literals = (xs: readonly string[]) => `ARRAY[${xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ")}]::text[]`;

/** A function as `schema.name(argument types)`, whatever the session's search_path. */
const FN = `(n.nspname || '.' || p.proname || '(' || coalesce((SELECT string_agg(format_type(t, NULL), ',' ORDER BY i)
  FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(t, i)), '') || ')')`;
const SYSTEM = `n.nspname IN ('pg_catalog', 'information_schema')`;
const OTHER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;
const RELKINDS = `c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`;

/**
 * What the login's privileges are, as the catalog and the privilege functions report them, for
 * this database and the cluster's shared catalogs. Each column is one kind of check in loginRefusals.
 */
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
     UNION ALL SELECT 'type ' || t.oid::regtype::text FROM pg_type t WHERE t.typowner = r.oid AND t.typrelid = 0
     UNION ALL SELECT 'database ' || d.datname FROM pg_database d WHERE d.datdba = r.oid) owned) AS owns,
  -- Any privilege on a table, view, materialized view, foreign table or sequence outside the system schemas.
  (SELECT array_agg(c.oid::regclass::text ORDER BY c.oid::regclass::text) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${OTHER} AND ${RELKINDS}
       AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE, SELECT, UPDATE')
                ELSE has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') END) AS tables,
  -- Any column privilege on such a relation.
  (SELECT array_agg(c.oid::regclass::text ORDER BY c.oid::regclass::text) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${OTHER} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')) AS columns,
  -- In the system schemas: any write (but UPDATE on pg_settings, which is SET and which Postgres grants
  -- PUBLIC), or reading one of the relations an ordinary role may not read.
  (SELECT array_agg(c.oid::regclass::text ORDER BY c.oid::regclass::text) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM} AND ${RELKINDS}
       AND (has_table_privilege(c.oid, 'INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
            OR (has_table_privilege(c.oid, 'UPDATE') AND c.oid <> 'pg_catalog.pg_settings'::regclass)
            OR (c.relname = ANY (${literals(RESTRICTED_RELATIONS)}) AND has_table_privilege(c.oid, 'SELECT')))) AS system,
  -- Functions it may execute beyond the granted ones: any outside the system schemas, and the restricted built-ins.
  (SELECT array_agg(f ORDER BY f) FROM (
     SELECT ${FN} AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE has_function_privilege(p.oid, 'EXECUTE')
       AND ((NOT ${SYSTEM} AND ${FN} <> ALL (${literals(GRANTED_FUNCTIONS)})) OR (${SYSTEM} AND p.proname = ANY (${literals(RESTRICTED_FUNCTIONS)})))) fs) AS functions,
  -- Every privilege granted to this role by name, on any object, except the migrations' own grants.
  (SELECT array_agg(g ORDER BY g) FROM (
     SELECT a.privilege_type || ' on ' || c.oid::regclass::text AS g FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on column ' || at.attname || ' of ' || at.attrelid::regclass::text
       FROM pg_attribute at, aclexplode(at.attacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on function ' || ${FN} FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
       WHERE a.grantee = r.oid AND ${FN} <> ALL (${literals(GRANTED_FUNCTIONS)})
     UNION ALL SELECT a.privilege_type || ' on schema ' || n.nspname FROM pg_namespace n, aclexplode(n.nspacl) a
       WHERE a.grantee = r.oid AND NOT (n.nspname = 'school' AND a.privilege_type = 'USAGE')
     UNION ALL SELECT a.privilege_type || ' on database ' || d.datname FROM pg_database d, aclexplode(d.datacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on type ' || t.oid::regtype::text FROM pg_type t, aclexplode(t.typacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on language ' || l.lanname FROM pg_language l, aclexplode(l.lanacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on large object ' || lo.oid FROM pg_largeobject_metadata lo, aclexplode(lo.lomacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on foreign-data wrapper ' || w.fdwname FROM pg_foreign_data_wrapper w, aclexplode(w.fdwacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on foreign server ' || s.srvname FROM pg_foreign_server s, aclexplode(s.srvacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on tablespace ' || ts.spcname FROM pg_tablespace ts, aclexplode(ts.spcacl) a WHERE a.grantee = r.oid
     UNION ALL SELECT a.privilege_type || ' on parameter ' || pa.parname FROM pg_parameter_acl pa, aclexplode(pa.paracl) a WHERE a.grantee IN (r.oid, 0)
  ) gs) AS grants,
  -- Default privileges that would grant it (or PUBLIC) future objects, or that it set for itself.
  (SELECT array_agg(dflt ORDER BY dflt) FROM (
     SELECT 'for role ' || da.defaclrole::regrole::text || ' on ' || da.defaclobjtype::text || ': ' || a.privilege_type || ' to ' ||
            CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS dflt
     FROM pg_default_acl da, aclexplode(da.defaclacl) a WHERE a.grantee IN (r.oid, 0) OR da.defaclrole = r.oid) ds) AS defaults,
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
 * The login check: each check `pool`'s login fails, as clauses for the refusal ("is a superuser",
 * "may execute lo_export(oid,text)", ...). Empty when every check holds. It covers the kinds of
 * privilege listed in docs/topics/architecture/README.md, "The login check", and no others.
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
  if (owns.length > 0) out.push(`owns ${owns.slice(0, 5).join(", ")}${owns.length > 5 ? ` and ${owns.length - 5} more object(s)` : ""}`);
  if ((l.tables ?? []).length > 0) out.push(`has privileges on ${l.tables!.join(", ")}`);
  if ((l.columns ?? []).length > 0) out.push(`has column privileges on ${l.columns!.join(", ")}`);
  if ((l.system ?? []).length > 0) out.push(`has privileges on system relation(s) ${l.system!.join(", ")}`);
  for (const f of l.functions ?? []) out.push(`may execute ${f.startsWith("pg_catalog.") ? f.slice("pg_catalog.".length) : f}`);
  if ((l.grants ?? []).length > 0) out.push(`is granted ${l.grants!.join(", ")}`);
  if ((l.defaults ?? []).length > 0) out.push(`has default privileges ${l.defaults!.join(", ")}`);
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

/** How many times the migrate job tries its role update when another job's races it. */
const ATTEMPTS = 20;

/** school_app's password: letters and digits only, since compose puts it into a URL as it is. */
const APP_PASSWORD = /^[A-Za-z0-9]{20,}$/;

/**
 * The migrate job (flyingrobots/school#91): connected with `url`, the owner's or superuser's URL,
 * apply every pending migration as school_owner (server/db/migrate.ts), then make school_app a
 * login with `appPassword` and nothing else, and revoke PUBLIC's TEMPORARY on this database so the
 * server's login cannot create temporary tables. Idempotent: a second run applies nothing and sets
 * the same password again. The password reaches Postgres only as a SCRAM-SHA-256 verifier, never
 * as text, so not even a statement log holds it. `onApplied` hears of each migration as it commits.
 */
export async function migrateRecord(url: string, appPassword: string, onApplied?: OnApplied): Promise<{ applied: number[] }> {
  if (!APP_PASSWORD.test(appPassword)) {
    throw new Error("SCHOOL_APP_PASSWORD must be at least 20 letters and digits (it goes into a URL as it is); " +
      "generate one, e.g. `openssl rand -base64 32 | tr -d '/+='`");
  }
  const pool = new Bun.SQL(url);
  try {
    const conn = await reservedConnection(pool);
    try {
      const { applied } = await migrate(conn, undefined, onApplied);
      const who = (await conn.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
      if (who === OWNER || who === APP) throw new Error(`the migration connection ended as ${who}`);
      const db = (await conn.query<{ d: string }>("SELECT quote_ident(current_database()) AS d")).rows[0]!.d;
      // One job at a time on this database, as for the migrations. The role is cluster-wide, so a
      // job on another database can update its catalog row at the same moment ("tuple concurrently
      // updated"): that is retried, up to ATTEMPTS times with a random, growing pause, then thrown.
      for (let attempt = 1; ; attempt++) {
        await conn.exec("BEGIN");
        try {
          await conn.exec("SELECT pg_advisory_xact_lock(hashtext('school.migrate_job'))");
          await conn.exec(`ALTER ROLE ${APP} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${scramVerifier(appPassword)}'`);
          // Settings on the role, which a compromised server could set for itself (ALTER ROLE
          // school_app SET ...), do not outlive the next job: cleared everywhere they are kept.
          await conn.exec(`ALTER ROLE ${APP} RESET ALL`);
          const dbs = (await conn.query<{ d: string }>(`SELECT quote_ident(d.datname) AS d FROM pg_db_role_setting s
            JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = '${APP}'::regrole`)).rows;
          for (const { d } of dbs) await conn.exec(`ALTER ROLE ${APP} IN DATABASE ${d} RESET ALL`);
          await conn.exec(`REVOKE CREATE, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
          await conn.exec("COMMIT");
          break;
        } catch (e) {
          await conn.exec("ROLLBACK");
          if (attempt >= ATTEMPTS || !/tuple concurrently updated/.test((e as Error).message)) throw e;
          await Bun.sleep(Math.random() * 50 * attempt);
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

/** Rename a course in the record at `url` (db/rename-course.ts), on one reserved connection. */
export async function renameRecordCourse(url: string, from: string, to: string): Promise<Renamed> {
  const pool = new Bun.SQL(url);
  try {
    const conn = await reservedConnection(pool);
    try {
      return await renameCourse(conn, from, to);
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
