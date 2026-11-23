// The Sql port: what the Postgres adapter needs from a Postgres driver (RFC 3, §4, Figure 1).
//
// It is defined here, in the adapter layer, not in server/core/: the core talks to LearningRecord
// and never to SQL, and RFC 3 draws this port beneath the Postgres adapter, which is its only
// user. Its drivers: PGlite for tests (server/testing/pglite.ts); Bun.SQL for production arrives
// with flyingrobots/school#47. Both run the same function calls.

/** One parameterised statement and the rows it returns, with Postgres values as the driver parses them. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params: readonly unknown[]): Promise<T[]>;
}
