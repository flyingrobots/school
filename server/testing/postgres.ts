// Scratch databases on the real Postgres server the Bun.SQL tests run against
// (SCHOOL_TEST_POSTGRES_URL, a superuser URL; CI starts one). Every test gets a database of its
// own, so the tests share nothing and may run in any order. Not shipped (server/.dockerignore).
//
// Each test file calls `scratchPostgres()` once at its top level. That registers the file's own
// afterAll, which drops every database the file made, and names them under a prefix unique to the
// file, so two files never touch each other's databases.
import { afterAll } from "bun:test";
import { openDatabase, type Opened } from "../adapters/database.ts";

/** The scratch server's superuser URL, or undefined when there is none and the Postgres tests skip. */
export const TEST_POSTGRES_URL: string | undefined = process.env.SCHOOL_TEST_POSTGRES_URL || undefined;

/**
 * The teardown's budget. Every DROP DATABASE waits for a checkpoint, which took about three seconds
 * under Docker on macOS on a loaded machine (pg_stat_checkpointer: 99 s of sync over 29
 * checkpoints), so a file's few dozen databases outlasted a 30-second hook, dropped one at a time
 * or all at once, and were left behind.
 */
const TEARDOWN = 180_000;

export type Scratch = {
  /** A new, empty database on the test server, or a copy of `template`; its superuser URL. */
  database(template?: string): Promise<string>;
  /** A migrated database of its own, opened as the server opens one; `url` is its superuser URL. */
  fresh(): Promise<Opened & { url: string }>;
  /** Close `c` before the next `fresh()` and at the end, so pools do not exhaust the server's connections. */
  track<C extends { close(): Promise<void> }>(c: C): C;
};

export function scratchPostgres(): Scratch {
  const run = `school_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const made: string[] = []; // made and not yet being dropped
  let count = 0;
  const opened: { close(): Promise<void> }[] = [];
  let admin: InstanceType<typeof Bun.SQL> | undefined;
  let template: Promise<string> | undefined;
  let previous: string | undefined;
  const dropping: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  /** Drop `name` without waiting: the next test runs meanwhile, and the teardown awaits it. */
  const drop = (name: string) => {
    const i = made.indexOf(name);
    if (i < 0) return;
    made.splice(i, 1);
    dropping.push(admin!.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch((e: unknown) => failures.push(e)));
  };

  const url = (): string => {
    if (TEST_POSTGRES_URL === undefined) throw new Error("SCHOOL_TEST_POSTGRES_URL is not set");
    return TEST_POSTGRES_URL;
  };
  const withDb = (db: string) => { const u = new URL(url()); u.pathname = `/${db}`; return u.toString(); };

  const database = async (from?: string): Promise<string> => {
    admin ??= new Bun.SQL(url());
    const name = `${run}_${count++}`;
    made.push(name);
    await admin.unsafe(`CREATE DATABASE ${name}${from === undefined ? "" : ` TEMPLATE ${from}`}`);
    return withDb(name);
  };

  const fresh = async (): Promise<Opened & { url: string }> => {
    template ??= (async () => {
      const u = await database();
      await (await openDatabase({ driver: "postgres", url: u })).close(); // a template may have no connections
      return made[made.length - 1]!;
    })();
    // Tests in a file run one at a time, so the previous test's pool and database are done with.
    for (const o of opened.splice(0)) await o.close();
    if (previous !== undefined) drop(previous);
    const u = await database(await template);
    previous = made[made.length - 1]!;
    const o = await openDatabase({ driver: "postgres", url: u });
    opened.push(o);
    return { ...o, url: u };
  };

  afterAll(async () => {
    // A pool's graceful close once hung past the hook's timeout on a loaded machine, leaving every
    // database behind. So each close gets two seconds, then DROP ... WITH (FORCE) ends whatever
    // connections are left. Databases of earlier tests are already being dropped, in the background.
    const bounded = (p: Promise<unknown>) => Promise.race([p, Bun.sleep(2_000)]);
    for (const o of opened.splice(0)) await bounded(o.close());
    if (admin !== undefined) {
      for (const name of [...made]) drop(name);
      await Promise.all(dropping.splice(0));
      await bounded(admin.close());
    }
    if (failures.length > 0) throw new AggregateError(failures, "dropping the scratch databases failed");
  }, TEARDOWN);

  return {
    database,
    fresh,
    track: (c) => { opened.push(c); return c; },
  };
}
