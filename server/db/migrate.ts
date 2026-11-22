// The numbered-migration runner for School's Postgres record (RFC 3 v0.4.0 §3.3, §3.5).
//
// Migrations are `NNNN_name.sql` files in db/migrations/, numbered from 0001 without gaps. Each
// file runs in its own transaction together with its row in `public.schema_migrations`, so a file
// is either wholly applied and recorded or not at all. Running the runner again applies nothing.
// An applied file is never edited: its checksum is recorded, and a changed file is refused before
// anything runs. A later change is a new numbered file. A file holds no BEGIN, COMMIT or
// ROLLBACK of its own: the runner owns the transaction.
//
// The runner needs a role that may create roles and become them (in practice the database's
// superuser): 0001 creates `school_owner` and `school_app`, then builds the schema as the owner.
//
// It imports no driver. `Connection` is the two calls it needs, which PGlite provides as is; a
// pooled driver must hand it one reserved connection, since BEGIN and COMMIT are separate calls.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS = join(import.meta.dir, "migrations");

export type Migration = { version: number; name: string; sql: string; checksum: string };

/** One database connection: `exec` runs a script of statements, `query` one statement with parameters. */
export type Connection = {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** The migrations in `dir`, in order. Throws on a misnamed file, a repeated version or a gap. */
export function readMigrations(dir: string = MIGRATIONS): Migration[] {
  const out = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((name): Migration => {
    const m = NAME.exec(name);
    if (m === null) throw new Error(`${name} is not named NNNN_name.sql`);
    const sql = readFileSync(join(dir, name), "utf8");
    return { version: Number(m[1]), name, sql, checksum: new Bun.CryptoHasher("sha256").update(sql).digest("hex") };
  }).sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.version === out[i - 1]!.version) throw new Error(`version ${out[i]!.version} is used twice`);
  }
  out.forEach((m, i) => { if (m.version !== i + 1) throw new Error(`version ${i + 1} is missing`); });
  return out;
}

type Applied = { version: number; name: string; checksum: string };

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

  // Refuse an edited history before running anything.
  const before = await recorded();
  for (const m of migrations) {
    const r = before.get(m.version);
    if (r !== undefined && (r.checksum !== m.checksum || r.name !== m.name)) {
      throw new Error(`${m.name} has changed since it was applied as ${r.name}; add a new migration instead`);
    }
  }

  const applied: number[] = [];
  for (const m of migrations) {
    if (before.has(m.version)) continue;
    await db.exec("BEGIN");
    try {
      // Two runners at once: the second waits here, then sees the first's row and skips.
      await db.exec("SELECT pg_advisory_xact_lock(hashtext('school.schema_migrations'))");
      if ((await recorded()).has(m.version)) { await db.exec("COMMIT"); continue; }
      // Recorded first: a file may change role for the rest of its transaction (0001 does).
      await db.query("INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
      await db.exec(m.sql);
      await db.exec("COMMIT");
      applied.push(m.version);
    } catch (e) {
      await db.exec("ROLLBACK");
      throw new Error(`${m.name}: ${(e as Error).message}`, { cause: e });
    }
  }
  return { applied };
}
