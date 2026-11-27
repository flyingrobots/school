// Migrate jobs on several databases of one Postgres cluster at once (flyingrobots/school#356). The
// migrate job's advisory locks cover one database, while the roles it creates and alters belong to
// the whole cluster, and every job's connections count against the cluster's one max_connections.
// On the real Postgres server the Bun.SQL tests use (SCHOOL_TEST_POSTGRES_URL, a superuser URL);
// skipped without it, and CI fails a run that skips it (server/testing/postgres-gate.ts).
//
// school_app is shared with every other test on the server: a test that changes its password ends
// with TEST_APP_PASSWORD set again, and a test that holds a change open rolls it back in `finally`.
// The role bootstrap's race is run under role names of its own, which the test drops.
import { describe, expect, test } from "bun:test";
import { scratchPostgres, TEST_APP_PASSWORD, TEST_POSTGRES_URL as URL_ } from "../testing/postgres.ts";
import { APP, migrateRecord, scramVerifier } from "./database.ts";
import { BOOTSTRAP } from "../db/migrate.ts";

const SLOW = 60_000;
const { database, track } = scratchPostgres();

/** `url` (a superuser URL) logging in as `user` with `password` instead. */
const as = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

/** The database name in `url`. */
const nameOf = (url: string) => new URL(url).pathname.slice(1);

/** Whether `user` can log in to `url` with `password`: "ok", or the SQLSTATE of the refusal. */
async function login(url: string, user: string, password: string): Promise<string> {
  const db = new Bun.SQL(as(url, user, password), { max: 1 });
  try {
    await db.unsafe("SELECT 1");
    return "ok";
  } catch (e) {
    return String((e as { errno?: unknown }).errno ?? (e as Error).message);
  } finally {
    await db.close().catch(() => {});
  }
}

/** Resolves once `sql` (a count) is above zero on `admin`; waits on the condition, not on time. */
async function until(admin: InstanceType<typeof Bun.SQL>, sql: string): Promise<void> {
  for (;;) if ((await admin.unsafe(sql))[0].n > 0) return;
}

/** Sessions on database `db` waiting for a heavyweight lock (a row, a transaction, an advisory lock). */
const waiting = (db: string) => `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = '${db}' AND wait_event_type = 'Lock'`;

describe.skipIf(URL_ === undefined)("Bun.SQL: migrate jobs on many databases of one cluster at once (SCHOOL_TEST_POSTGRES_URL)", () => {
  test("a migrate job holds one connection to its database, even while it waits for the runner's lock", async () => {
    const url = await database();
    const db = nameOf(url);
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    const holder = await track(new Bun.SQL(url, { max: 1 })).reserve();
    await holder.unsafe("SELECT pg_advisory_lock(hashtext('school.schema_migrations'))");
    const holderPid = (await holder.unsafe("SELECT pg_backend_pid() AS p"))[0].p;
    const job = migrateRecord(url, TEST_APP_PASSWORD);
    try {
      await until(admin, waiting(db));
      const sessions = (await admin.unsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = '${db}' AND pid <> ${holderPid}`))[0].n;
      // One reserved connection runs the whole job (server/db/migrate.ts needs no more).
      expect(sessions).toBe(1);
    } finally {
      await holder.unsafe("SELECT pg_advisory_unlock(hashtext('school.schema_migrations'))");
      holder.release();
      await job;
    }
  }, SLOW);

  test("sixteen migrate jobs on sixteen databases of one cluster at once all succeed", async () => {
    const urls = await Promise.all(Array.from({ length: 16 }, () => database()));
    const done = await Promise.allSettled(urls.map((u) => migrateRecord(u, TEST_APP_PASSWORD)));
    const why = done.map((d) => (d.status === "fulfilled" ? "fulfilled" : `${(d.reason as { errno?: string }).errno}: ${(d.reason as Error).message}`));
    expect(why).toEqual(urls.map(() => "fulfilled"));
    expect(await login(urls[0]!, APP, TEST_APP_PASSWORD)).toBe("ok");
  }, 120_000);

  test("the role bootstrap, run in two databases of a cluster that has neither role yet, creates each role once and fails neither", async () => {
    const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const owner = `school_owner_${tag}`;
    const app = `school_app_${tag}`;
    // The runner's own text, under role names no other test uses.
    const bootstrap = BOOTSTRAP.replaceAll("school_owner", owner).replaceAll("school_app", app);
    expect(bootstrap).not.toBe(BOOTSTRAP);
    const [a, b] = await Promise.all([database(), database()]);
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    const first = await track(new Bun.SQL(a!, { max: 1 })).reserve();
    const second = await track(new Bun.SQL(b!, { max: 1 })).reserve();
    try {
      // The schedule: the first creates the roles and has not committed when the second, seeing
      // none yet, creates them too and waits on the first; then the first commits.
      await first.unsafe("BEGIN");
      await first.unsafe(bootstrap);
      await second.unsafe("BEGIN");
      const late = second.unsafe(bootstrap).then(() => "ok", (e: unknown) => `${(e as { errno?: string }).errno}: ${(e as Error).message}`);
      await until(admin, waiting(nameOf(b!)));
      await first.unsafe("COMMIT");
      expect(await late).toBe("ok");
      await second.unsafe("COMMIT");
      const roles = [...await admin.unsafe(`SELECT rolname FROM pg_roles WHERE rolname IN ('${owner}', '${app}') ORDER BY 1`)].map((r: { rolname: string }) => r.rolname);
      expect(roles).toEqual([app, owner]);
    } finally {
      await first.unsafe("ROLLBACK").catch(() => {});
      await second.unsafe("ROLLBACK").catch(() => {});
      first.release();
      second.release();
      for (const u of [a!, b!]) await admin.unsafe(`DROP DATABASE IF EXISTS ${nameOf(u)} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${app}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    }
  }, SLOW);

  test("the role bootstrap, run at once in sixteen databases of a cluster that has neither role yet, fails none", async () => {
    const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const owner = `school_owner_${tag}`;
    const app = `school_app_${tag}`;
    const bootstrap = BOOTSTRAP.replaceAll("school_owner", owner).replaceAll("school_app", app);
    const urls = await Promise.all(Array.from({ length: 16 }, () => database()));
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    try {
      const done = await Promise.all(urls.map(async (u) => {
        const db = new Bun.SQL(u, { max: 1 });
        try {
          await db.begin(async (tx) => { await tx.unsafe(bootstrap); });
          return "ok";
        } catch (e) {
          return `${(e as { errno?: string }).errno}: ${(e as Error).message}`;
        } finally {
          await db.close();
        }
      }));
      expect(done).toEqual(urls.map(() => "ok"));
    } finally {
      for (const u of urls) await admin.unsafe(`DROP DATABASE IF EXISTS ${nameOf(u)} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${app}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    }
  }, 120_000);

  test("a job whose role update meets another session's uncommitted change of school_app's password waits for it, then sets its own", async () => {
    const url = await database();
    await migrateRecord(url, TEST_APP_PASSWORD);
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    const other = await track(new Bun.SQL(URL_!, { max: 1 })).reserve();
    await other.unsafe("BEGIN");
    try {
      await other.unsafe(`ALTER ROLE ${APP} PASSWORD '${scramVerifier(`${TEST_APP_PASSWORD}other`)}'`);
      const job = migrateRecord(url, TEST_APP_PASSWORD);
      await until(admin, waiting(nameOf(url)));
      await other.unsafe("COMMIT");
      await job;
    } finally {
      await other.unsafe("ROLLBACK").catch(() => {});
      other.release();
    }
    expect(await login(url, APP, TEST_APP_PASSWORD)).toBe("ok");
    // 28P01, invalid_password: the other session's password was replaced, not kept.
    expect(await login(url, APP, `${TEST_APP_PASSWORD}other`)).toBe("28P01");
  }, SLOW);

  test("when school_app already exists with another password, the next job on another database sets its own", async () => {
    const [a, b] = await Promise.all([database(), database()]);
    const previous = `${TEST_APP_PASSWORD}previous`;
    try {
      await migrateRecord(a!, previous);
      expect(await login(a!, APP, previous)).toBe("ok");
    } finally {
      await migrateRecord(b!, TEST_APP_PASSWORD);
    }
    expect(await login(a!, APP, TEST_APP_PASSWORD)).toBe("ok");
    expect(await login(a!, APP, previous)).toBe("28P01");
  }, SLOW);

  test("a role update that fails for any reason but a concurrent update is thrown as it is, not retried into success", async () => {
    const url = await database();
    await migrateRecord(url, TEST_APP_PASSWORD);
    const db = nameOf(url);
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    // The job's own statements give up on a lock after 200 ms on this database: 55P03.
    await admin.unsafe(`ALTER DATABASE ${db} SET lock_timeout = '200ms'`);
    const other = await track(new Bun.SQL(URL_!, { max: 1 })).reserve();
    await other.unsafe("BEGIN");
    try {
      await other.unsafe(`ALTER ROLE ${APP} PASSWORD '${scramVerifier(TEST_APP_PASSWORD)}'`);
      const job = migrateRecord(url, TEST_APP_PASSWORD).then(() => "fulfilled", (e: unknown) => `${(e as { errno?: string }).errno}: ${(e as Error).message}`);
      await until(admin, waiting(db));
      // Once the job has given up waiting, the change it waited on goes away. A job that retried
      // every error would now succeed, and hide the timeout.
      await until(admin, `SELECT (count(*) = 0)::int AS n FROM pg_stat_activity WHERE datname = '${db}' AND wait_event_type = 'Lock'`);
      await other.unsafe("ROLLBACK");
      expect(await job).toBe("55P03: canceling statement due to lock timeout");
    } finally {
      await other.unsafe("ROLLBACK").catch(() => {});
      other.release();
    }
  }, SLOW);

  test("a job on one database does not wait for the migrate job's locks held on another database of the cluster", async () => {
    const [a, b] = await Promise.all([database(), database()]);
    const holder = await track(new Bun.SQL(a!, { max: 1 })).reserve();
    await holder.unsafe("SELECT pg_advisory_lock(hashtext('school.schema_migrations')), pg_advisory_lock(hashtext('school.migrate_job'))");
    try {
      expect((await migrateRecord(b!, TEST_APP_PASSWORD)).applied.length).toBeGreaterThan(0);
    } finally {
      await holder.unsafe("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  }, SLOW);
});
