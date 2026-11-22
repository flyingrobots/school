import { join } from "node:path";
export const MIGRATIONS = join(import.meta.dir, "migrations");
export type Migration = { version: number; name: string; sql: string; checksum: string };
export type Connection = { exec(sql: string): Promise<unknown>; query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };
export function readMigrations(_dir: string = MIGRATIONS): Migration[] { return []; }
export async function migrate(_db: Connection, _dir: string = MIGRATIONS): Promise<{ applied: number[] }> { return { applied: [] }; }
