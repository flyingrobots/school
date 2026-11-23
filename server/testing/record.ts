// Reading the Postgres record of a School server the test has stopped, as the database's superuser
// (who owns everything school_app may not read). PGlite is one process's database and takes no
// lock: a second PGlite on a directory the server still has open could corrupt it. So read only
// after the server's process has exited, then start it again. Not shipped (server/.dockerignore).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite } from "../adapters/pglite.ts";

/** The rows `text` returns from the PGlite record in `dir`, queried as the superuser. */
export async function ownerQuery<T = Record<string, unknown>>(dir: string, text: string, params: unknown[] = []): Promise<T[]> {
  const db = await openPglite(dir);
  try {
    return (await db.query<T>(text, params)).rows;
  } finally {
    await db.close();
  }
}

/** Every byte of every file in the PGlite record in `dir`, as latin1 text: what is on disk. */
export function recordBytes(dir: string): string {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.isFile() ? [readFileSync(join(d, e.name)).toString("latin1")] : []);
  return walk(dir).join("");
}
