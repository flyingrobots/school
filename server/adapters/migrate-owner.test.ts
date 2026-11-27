// The migrate job's bootstrap forces school_owner's attributes (flyingrobots/school#359): an owner
// that already exists with SUPERUSER, LOGIN, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS, made
// by hand or by an older setup, leaves the bootstrap with none of them, as the job already does for
// school_app. On the real Postgres server the Bun.SQL tests use (SCHOOL_TEST_POSTGRES_URL, a
// superuser URL); skipped without it, and CI fails a run that skips it (server/testing/postgres-gate.ts).
//
// Roles are cluster-wide, so these tests never touch the real school_owner: each runs the runner's
// own bootstrap text under role names of its own, which it drops.
import { describe, expect, test } from "bun:test";
import { scratchPostgres, TEST_POSTGRES_URL as URL_ } from "../testing/postgres.ts";
import { BOOTSTRAP } from "../db/migrate.ts";

const SLOW = 30_000;
const { database, track } = scratchPostgres();

/** The attributes the bootstrap forces off, by their pg_roles columns. */
type Attributes = { super: boolean; login: boolean; createrole: boolean; createdb: boolean; replication: boolean; bypassrls: boolean };
const NONE: Attributes = { super: false, login: false, createrole: false, createdb: false, replication: false, bypassrls: false };

/** Fresh role names for one test, and the runner's bootstrap rewritten to use them. */
function roles(): { owner: string; app: string; bootstrap: string } {
  const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const owner = `school_owner_${tag}`;
  const app = `school_app_${tag}`;
  const bootstrap = BOOTSTRAP.replaceAll("school_owner", owner).replaceAll("school_app", app);
  return { owner, app, bootstrap };
}

/** `owner`'s attributes and its catalog row's xmin, which changes with any update of the row. */
async function read(admin: InstanceType<typeof Bun.SQL>, owner: string): Promise<{ attributes: Attributes; xmin: string }> {
  const [r] = await admin.unsafe(`SELECT rolsuper AS super, rolcanlogin AS login, rolcreaterole AS createrole,
    rolcreatedb AS createdb, rolreplication AS replication, rolbypassrls AS bypassrls, xmin::text AS xmin
    FROM pg_authid WHERE rolname = '${owner}'`);
  const { xmin, ...attributes } = r as Attributes & { xmin: string };
  return { attributes, xmin };
}

/**
 * Run `bootstrap` in one transaction on a database of its own, as the runner does for each pending
 * file; returns that database's name, which the test drops before the roles (the owner owns its schema).
 */
async function runBootstrap(bootstrap: string): Promise<string> {
  const url = await database();
  const db = new Bun.SQL(url, { max: 1 });
  try {
    await db.begin(async (tx) => { await tx.unsafe(bootstrap); });
  } finally {
    await db.close();
  }
  return new URL(url).pathname.slice(1);
}

/** Drop `db` (if the test made one), then the test's two roles. */
async function cleanUp(admin: InstanceType<typeof Bun.SQL>, db: string | undefined, owner: string, app: string): Promise<void> {
  if (db !== undefined) await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.unsafe(`DROP ROLE IF EXISTS ${app}`);
  await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
}

describe.skipIf(URL_ === undefined)("Bun.SQL: the bootstrap forces school_owner's attributes (SCHOOL_TEST_POSTGRES_URL)", () => {
  test("an owner that already exists with SUPERUSER LOGIN leaves the bootstrap with neither, nor any other", async () => {
    const { owner, app, bootstrap } = roles();
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    let db: string | undefined;
    try {
      await admin.unsafe(`CREATE ROLE ${owner} SUPERUSER LOGIN`);
      db = await runBootstrap(bootstrap);
      expect((await read(admin, owner)).attributes).toEqual(NONE);
    } finally {
      await cleanUp(admin, db, owner, app);
    }
  }, SLOW);

  test.each(["SUPERUSER", "LOGIN", "CREATEROLE", "CREATEDB", "REPLICATION", "BYPASSRLS"])(
    "an owner that already exists with %s alone leaves the bootstrap without it",
    async (attribute) => {
      const { owner, app, bootstrap } = roles();
      const admin = track(new Bun.SQL(URL_!, { max: 1 }));
      let db: string | undefined;
      try {
        await admin.unsafe(`CREATE ROLE ${owner} ${attribute}`);
        db = await runBootstrap(bootstrap);
        expect((await read(admin, owner)).attributes, `after an owner made ${attribute}`).toEqual(NONE);
      } finally {
        await cleanUp(admin, db, owner, app);
      }
    },
    SLOW,
  );

  test("an owner that already exists with the right attributes is left as it was: its catalog row is not rewritten", async () => {
    const { owner, app, bootstrap } = roles();
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    let db: string | undefined;
    try {
      await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN`);
      const before = await read(admin, owner);
      db = await runBootstrap(bootstrap);
      // xmin is the transaction that wrote the row: an ALTER ROLE, even one that changes nothing,
      // writes a new row version, so an equal xmin means the bootstrap did not update it.
      expect(await read(admin, owner)).toEqual(before);
    } finally {
      await cleanUp(admin, db, owner, app);
    }
  }, SLOW);

  test("with no owner yet, the bootstrap creates it with none of the attributes and does not fail", async () => {
    const { owner, app, bootstrap } = roles();
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    let db: string | undefined;
    try {
      db = await runBootstrap(bootstrap);
      expect((await read(admin, owner)).attributes).toEqual(NONE);
    } finally {
      await cleanUp(admin, db, owner, app);
    }
  }, SLOW);
});
