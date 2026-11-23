// The Bun.SQL driver of the Sql port (server/adapters/sql.ts), for a real Postgres server: what a
// `postgres://` SCHOOL_DATABASE_URL selects (server/adapters/database.ts). It uses the `Bun.SQL`
// global rather than importing "bun", so the shipped image needs no package for it.
//
// Bun.SQL is a pool. Two things follow:
// - The migration runner needs one connection for its whole run, since BEGIN and COMMIT are
//   separate calls and its advisory lock is held by a session: `reservedConnection` hands it one.
// - A role set on a pooled connection would stay with that connection and leak to whatever runs on
//   it next. So the app's statements each run in their own transaction that begins with
//   SET LOCAL ROLE, which Postgres undoes at COMMIT or ROLLBACK, whichever connection it was.
//
// Each transaction begins READ COMMITTED, whatever the database's default: open_encounter and
// record_grading read what an advisory lock's previous holder committed, which needs a snapshot per
// statement, and refuse to run under any other level (migration 0005).
import type { Connection } from "../db/migrate.ts";
import type { Sql } from "./sql.ts";

type Pool = InstanceType<typeof Bun.SQL>;
type Reserved = Awaited<ReturnType<Pool["reserve"]>>;

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * `pool` as the Sql port, every statement run as `role`: BEGIN ISOLATION LEVEL READ COMMITTED;
 * SET LOCAL ROLE; the statement; COMMIT. A single function call in its own transaction commits
 * exactly as it would alone.
 */
export function bunSql(pool: Pool, role: string): Sql {
  if (!ROLE_NAME.test(role)) throw new Error(`${JSON.stringify(role)} is not a plain role name`);
  return {
    query: async <T>(text: string, params: readonly unknown[]) =>
      pool.begin("isolation level read committed", async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        return [...await tx.unsafe(text, [...params])] as T[];
      }),
  };
}

/** One connection reserved from `pool`, as the migration runner's Connection. Release it when done. */
export async function reservedConnection(pool: Pool): Promise<Connection & { release(): void }> {
  const c: Reserved = await pool.reserve();
  return {
    exec: (sql) => c.unsafe(sql),
    query: async <T>(sql: string, params: unknown[] = []) => ({ rows: [...await c.unsafe(sql, params)] as T[] }),
    release: () => c.release(),
  };
}
