// The migrate job forces school_owner's attributes (flyingrobots/school#359): an owner that already
// exists with SUPERUSER, LOGIN, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS, made by hand or by
// an older setup, has none of them once a job ends, as the job already does for school_app. Every
// job does this, one that applies nothing included, so a deployment that already exists is covered.
// On the real Postgres server the Bun.SQL tests use (SCHOOL_TEST_POSTGRES_URL, a superuser URL);
// skipped without it, and CI fails a run that skips it (server/testing/postgres-gate.ts).
//
// Roles are cluster-wide, so these tests never touch the real school_owner's attributes: each runs
// the job with `owner` set to a role name of its own, which it drops.
import { describe, expect, test } from "bun:test";
import { scratchPostgres, TEST_APP_PASSWORD, TEST_POSTGRES_URL as URL_ } from "../testing/postgres.ts";
import { migrateRecord } from "./database.ts";

const SLOW = 30_000;
const { database, track } = scratchPostgres();

/** The attributes the job forces off, by their pg_authid columns. */
type Attributes = { super: boolean; login: boolean; createrole: boolean; createdb: boolean; replication: boolean; bypassrls: boolean };
const NONE: Attributes = { super: false, login: false, createrole: false, createdb: false, replication: false, bypassrls: false };

/** A fresh role name for one test. */
const ownerName = () => `school_owner_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

/** `owner`'s attributes and its catalog row's xmin, which changes with any update of the row; undefined if it does not exist. */
async function read(admin: InstanceType<typeof Bun.SQL>, owner: string): Promise<{ attributes: Attributes; xmin: string } | undefined> {
  const [r] = await admin.unsafe(`SELECT rolsuper AS super, rolcanlogin AS login, rolcreaterole AS createrole,
    rolcreatedb AS createdb, rolreplication AS replication, rolbypassrls AS bypassrls, xmin::text AS xmin
    FROM pg_authid WHERE rolname = '${owner}'`);
  if (r === undefined) return undefined;
  const { xmin, ...attributes } = r as Attributes & { xmin: string };
  return { attributes, xmin };
}

describe.skipIf(URL_ === undefined)("Bun.SQL: the migrate job forces school_owner's attributes (SCHOOL_TEST_POSTGRES_URL)", () => {
  test("on a database already migrated, an owner since made SUPERUSER LOGIN has neither once the next job ends", async () => {
    const owner = ownerName();
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    const url = await database();
    try {
      await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN`);
      await migrateRecord(url, TEST_APP_PASSWORD, undefined, owner);
      await admin.unsafe(`ALTER ROLE ${owner} SUPERUSER LOGIN`);
      expect(await migrateRecord(url, TEST_APP_PASSWORD, undefined, owner)).toEqual({ applied: [] });
      expect((await read(admin, owner))?.attributes).toEqual(NONE);
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    }
  }, SLOW);

  test("an owner that already exists with SUPERUSER LOGIN before the first job has neither, nor any other, once it ends", async () => {
    const owner = ownerName();
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    const url = await database();
    try {
      await admin.unsafe(`CREATE ROLE ${owner} SUPERUSER LOGIN`);
      await migrateRecord(url, TEST_APP_PASSWORD, undefined, owner);
      expect((await read(admin, owner))?.attributes).toEqual(NONE);
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    }
  }, SLOW);

  test.each(["SUPERUSER", "LOGIN", "CREATEROLE", "CREATEDB", "REPLICATION", "BYPASSRLS"])(
    "an owner that already exists with %s alone has it no longer once a job ends",
    async (attribute) => {
      const owner = ownerName();
      const admin = track(new Bun.SQL(URL_!, { max: 1 }));
      const url = await database();
      try {
        await admin.unsafe(`CREATE ROLE ${owner} ${attribute}`);
        await migrateRecord(url, TEST_APP_PASSWORD, undefined, owner);
        expect((await read(admin, owner))?.attributes, `after an owner made ${attribute}`).toEqual(NONE);
      } finally {
        await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
      }
    },
    SLOW,
  );

  test("an owner that already exists with the right attributes is left as it was: its catalog row is not rewritten", async () => {
    const owner = ownerName();
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    const url = await database();
    try {
      await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN`);
      const before = await read(admin, owner);
      await migrateRecord(url, TEST_APP_PASSWORD, undefined, owner);
      // xmin is the transaction that wrote the row: an ALTER ROLE, even one that changes nothing,
      // writes a new row version, so an equal xmin means the job did not update it.
      expect(await read(admin, owner)).toEqual(before);
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    }
  }, SLOW);

  test("with no such owner, the job's check does not fail and creates nothing", async () => {
    const owner = ownerName();
    const admin = track(new Bun.SQL(URL_!, { max: 1 }));
    const url = await database();
    try {
      expect((await migrateRecord(url, TEST_APP_PASSWORD, undefined, owner)).applied.length).toBeGreaterThan(0);
      expect(await read(admin, owner)).toBeUndefined();
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    }
  }, SLOW);
});
