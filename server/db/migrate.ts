// The numbered-migration runner for School's Postgres record (RFC 3 v0.4.0 §3.3, §3.5).
//
// Migrations are `NNNN_name.sql` files in db/migrations/, numbered from 0001 without gaps. Each
// file runs in its own transaction together with its row in `public.schema_migrations`, so a file
// is either wholly applied and recorded or not at all. Running the runner again applies nothing.
// An applied file is never edited: its checksum is recorded, and a changed or missing file is
// refused before anything runs. A later change is a new numbered file.
//
// Every file runs as `school_owner` (SET LOCAL ROLE, inside its transaction), so everything any
// migration creates is owned by the owner and gets the owner's default privileges: a new function
// starts revoked from PUBLIC (0001). The owner may create objects only in schema `school`. Before
// switching, the runner makes sure the roles and the schema exist (BOOTSTRAP), which needs the
// connecting role; in practice the database's superuser.
//
// A file holds no transaction control (BEGIN, COMMIT, ROLLBACK, ...) and no role change (SET ROLE,
// RESET ROLE, SESSION AUTHORIZATION): the runner owns both, refuses such a file before running
// anything, and rolls back a file that ends as any role but the owner.
//
// It imports no driver. `Connection` is the two calls it needs, which PGlite provides as is; a
// pooled driver must hand it one reserved connection, since BEGIN and COMMIT are separate calls.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS = join(import.meta.dir, "migrations");

export const OWNER = "school_owner";

/**
 * What every migration relies on and none can create as the owner: the two roles (cluster-wide,
 * so created only if absent) and the schema the owner builds in. Idempotent; runs in each pending
 * file's transaction, as the connecting role, before the switch to the owner.
 */
export const BOOTSTRAP = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'school_owner') THEN
    CREATE ROLE school_owner NOLOGIN;
  END IF;
  -- NOLOGIN here; a deployment grants it LOGIN and a password (docs/working-notes.md).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'school_app') THEN
    CREATE ROLE school_app NOLOGIN;
  END IF;
END
$$;
CREATE SCHEMA IF NOT EXISTS school AUTHORIZATION school_owner;
`;

export type Migration = { version: number; name: string; sql: string; checksum: string };

/** One database connection: `exec` runs a script of statements, `query` one statement with parameters. */
export type Connection = {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** The migrations in `dir`, in order. Throws on a misnamed file, a repeated version, a gap or a forbidden statement. */
export function readMigrations(dir: string = MIGRATIONS): Migration[] {
  const out = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((name): Migration => {
    const m = NAME.exec(name);
    if (m === null) throw new Error(`${name} is not named NNNN_name.sql`);
    const sql = readFileSync(join(dir, name), "utf8");
    refuseControl(name, sql);
    return { version: Number(m[1]), name, sql, checksum: new Bun.CryptoHasher("sha256").update(sql).digest("hex") };
  }).sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.version === out[i - 1]!.version) throw new Error(`version ${out[i]!.version} is used twice`);
  }
  out.forEach((m, i) => { if (m.version !== i + 1) throw new Error(`version ${i + 1} is missing`); });
  return out;
}

/**
 * `sql` with comments, string literals, quoted identifiers and dollar-quoted bodies blanked out,
 * so what is left is only the top level of the script.
 */
function topLevel(sql: string): string {
  let out = "";
  let i = 0;
  const ident = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  while (i < sql.length) {
    const c = sql[i]!;
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      let depth = 0;
      do {
        if (sql.startsWith("/*", i)) { depth++; i += 2; } else if (sql.startsWith("*/", i)) { depth--; i += 2; } else i++;
      } while (depth > 0 && i < sql.length);
    } else if (c === "'") {
      const escapes = /[Ee]/.test(sql[i - 1] ?? "") && !ident(sql[i - 2]);
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
    } else if (c === '"') {
      i++;
      while (i < sql.length) { if (sql[i] === '"') { if (sql[i + 1] === '"') { i += 2; continue; } i++; break; } i++; }
    } else if (c === "$" && !ident(sql[i - 1]) && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
    } else {
      out += c;
      i++;
      continue;
    }
    out += " ";
  }
  return out;
}

const TRANSACTION = /^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|PREPARE\s+TRANSACTION)\b/i;
const ROLE = /^((SET|RESET)\s+((SESSION|LOCAL)\s+)?(ROLE|SESSION\s+AUTHORIZATION)\b|SET\s+(SESSION|LOCAL)\s+SESSION\s+AUTHORIZATION\b)/i;

/** Refuse a file with top-level transaction control or a role change: the runner owns both. */
function refuseControl(name: string, sql: string): void {
  let atomic = false; // inside a SQL-standard function body, BEGIN ATOMIC ... END
  for (const raw of topLevel(sql).split(";")) {
    const s = raw.trim();
    if (s === "") continue;
    if (atomic) { if (/^END$/i.test(s)) atomic = false; continue; }
    if (/\bBEGIN\s+ATOMIC\b/i.test(s)) { atomic = true; continue; }
    const t = TRANSACTION.exec(s);
    if (t) throw new Error(`${name}: the runner owns the transaction; remove its ${t[1]!.split(/\s+/)[0]!.toUpperCase()}`);
    const r = ROLE.exec(s);
    if (r) throw new Error(`${name}: the runner runs every file as ${OWNER}; remove its ${r[0].replace(/\s+/g, " ").toUpperCase()}`);
  }
}

type Applied = { version: number; name: string; checksum: string };

/** Throws unless every recorded version has its file, unchanged. */
function verify(migrations: Migration[], recorded: Map<number, Applied>): void {
  const files = new Map(migrations.map((m) => [m.version, m]));
  for (const r of recorded.values()) {
    const m = files.get(r.version);
    if (m === undefined) throw new Error(`version ${r.version} (${r.name}) is recorded as applied but has no file`);
    if (r.checksum !== m.checksum || r.name !== m.name) {
      throw new Error(`${m.name} has changed since it was applied as ${r.name}; add a new migration instead`);
    }
  }
}

/**
 * Apply every migration in `dir` not yet recorded, in order. Returns the versions applied by this
 * call, so a second run returns none. A failing file rolls back and throws, naming the file;
 * files before it stay applied.
 */
export async function migrate(db: Connection, dir: string = MIGRATIONS): Promise<{ applied: number[] }> {
  const migrations = readMigrations(dir);
  await db.exec(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const recorded = async () => new Map((await db.query<Applied>("SELECT version, name, checksum FROM public.schema_migrations")).rows
    .map((r) => [r.version, r]));

  // Refuse an edited or lost history before running anything.
  const before = await recorded();
  verify(migrations, before);

  const applied: number[] = [];
  for (const m of migrations) {
    if (before.has(m.version)) continue;
    await db.exec("BEGIN");
    try {
      // Two runners at once: the second waits here, then sees what the first recorded.
      await db.exec("SELECT pg_advisory_xact_lock(hashtext('school.schema_migrations'))");
      const now = await recorded();
      verify(migrations, now);
      if (now.has(m.version)) { await db.exec("COMMIT"); continue; }
      await db.query("INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
      await db.exec(BOOTSTRAP);
      await db.exec(`SET LOCAL ROLE ${OWNER}`);
      await db.exec(m.sql);
      const who = (await db.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
      if (who !== OWNER) throw new Error(`must end as ${OWNER}, not ${who}`);
      await db.exec("COMMIT");
      applied.push(m.version);
    } catch (e) {
      await db.exec("ROLLBACK");
      const message = (e as Error).message;
      throw new Error(message.startsWith(`${m.name} `) ? message : `${m.name}: ${message}`, { cause: e });
    }
  }
  return { applied };
}
