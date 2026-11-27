---
title: "Back up and restore the learning record"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-22
updated: 2026-11-23
status: "How-to. Describes the `backup` service in server/compose.yaml (flyingrobots/school#48)."
---

# Back up and restore the learning record

This page is a how-to for the operator of a School deployment under `docker compose`. It covers
checking that backups run, drilling a restore, and restoring for real, either over a damaged
database or after losing the database's volume.

## What runs

The `backup` service in `server/compose.yaml` runs `server/backup/backup.sh` in the database's own
image, `postgres:18.7` pinned by digest, so `pg_dump` is always the same major version as the
server it dumps.

| Setting | Default | Meaning |
| --- | --- | --- |
| `SCHOOL_BACKUP_INTERVAL_SECONDS` | `21600` (six hours) | Time between dumps. The first dump is taken when the service starts. |
| `SCHOOL_BACKUP_KEEP` | `28` (a week at the default interval) | How many dumps are kept. After each good dump, older ones are deleted. |

Set either in `server/.env`. The service refuses to start (exit 2) if either is not a positive
whole number.

- **Format.** Each dump is `pg_dump --format=custom` of database `school`, saved as
  `/backups/school-<UTC time>.dump`, for example `school-20261123T041319Z.dump`, in the named
  volume `backups`.
- **Atomicity.** `pg_dump` writes to a hidden `.partial` file of its own (made by `mktemp`, so
  two runs never share one). Only once `pg_dump` succeeds is the file put in place under its name,
  and only if no dump has that name yet: a dump never overwrites another. A dump that fails at
  either point leaves no file, deletes nothing, and is tried again five minutes later.
- **Retention.** Only files named `school-<UTC time>.dump` are counted and pruned. A copy saved
  under any other name in the volume is never touched.
- **File modes.** The folder is `0700` and every dump `0600`, owned by root in the container.
- **Secrets.** The password comes from `SCHOOL_POSTGRES_PASSWORD` in the environment, as it does
  for the database. Nothing the service prints contains it.
- **Output.** Every line, on stdout or stderr, is one JSON object naming its published schema
  (`_schema`, a file in `server/backup/schemas/`, which compose mounts beside the script), with
  `"kind":"backup"`, an `event` and the invocation's `run` id: `started`, `dumped` (with `file` and
  `bytes`), `pruned`, `waiting`, `captured` (what `pg_dump` printed during a dump that succeeded),
  `failed` (with the `file` it would have made and a `message` holding `pg_dump`'s own words),
  `error` or `stopped`. `pg_dump`'s stderr never reaches the log as raw text, and every message is
  scrubbed of the password. `backup.sh --help` and `--schema` describe it; `--human` prints prose.
  Each message type is in [the programs' output](../../topics/program-output/README.md#the-backup-job).

> [!WARNING]
> The dumps live on the same machine as the database. `docker compose down -v` deletes the
> `backups` volume along with the record. Copying dumps off the machine is out of scope here
> (flyingrobots/school#48). To keep one elsewhere, copy it out of the volume yourself (step 3).

## Before you start

Run every command from `server/`, with the deployment's `server/.env` in place. A command that
creates or starts a container (`up`, `run`, `start`) needs School's secrets, which live in the
Keychain (flyingrobots/school#123, [School's secrets](../../topics/secrets/README.md)), so it is
given here as `../school --human compose ...`, which runs `docker compose` with them and prints
compose's output as it is (without `--human`, each line comes as a JSON object); `exec`, `logs`,
`ps`, `cp`, `stop` and `down` need none. Compose names the
project after the folder, so its volumes are `server_postgres`, `server_backups` and
`server_course-store` (course content, not part of the record) unless you set
`COMPOSE_PROJECT_NAME`. `docker volume ls` shows them.

The backup service connects to the database with the superuser password in a file,
`/run/secrets/postgres_password`, which its `PGPASSWORD_FILE` names. `backup.sh` reads that file
into `PGPASSWORD`, but libpq itself does not read `PGPASSWORD_FILE`, and `docker compose exec` or
`run --entrypoint` starts the command without `backup.sh`. So every command below that connects
from the backup service (`createdb`, `pg_restore --dbname`, `psql`) runs in `sh -c` and loads the
password first, inside the container: `PGPASSWORD="$(cat "$PGPASSWORD_FILE")" <command>`. The
single quotes keep the host's shell from expanding it, and the password is never on a command
line. `pg_restore --list` and `ls` connect to nothing and run as they are; `psql` in the
`postgres` service connects over its local socket, which needs no password.

## 1. Check that backups run

```sh
docker compose logs backup
docker compose exec backup ls -l /backups
```

Expect a `dumped` line no older than the interval, and dumps of growing size as the record grows.
A `failed` line carries pg_dump's own message.

## 2. Take a dump now

Do this before anything risky, and at the start of a drill:

```sh
docker compose exec backup /bin/sh /backup/backup.sh once
```

It takes one dump and applies the retention, then exits: `0` if the dump succeeded, `1` if it failed.

## 3. Copy a dump out of the volume

```sh
docker compose cp backup:/backups/school-20261123T041319Z.dump ./
chmod 600 school-20261123T041319Z.dump
```

The copy holds the learner's whole record. Keep it as private as the record.

Take one before renaming a course in the record, too (docs/topics/migrate-job, "Renaming a
course"): the rename rewrites which course every encounter, view and decision note is filed under.

## 4. Drill a restore

A drill restores a dump beside the live database, checks that it holds the same record, and leaves
the live database untouched. Run one after changing anything about the deployment, and on a
schedule you will keep.

1. Stop the server, so the record does not change between the dump and the check:

   ```sh
   docker compose stop school
   ```

2. Take a dump (step 2) and note the file it names.

3. Check that the archive reads, and restore it into a new, empty database:

   ```sh
   docker compose exec backup pg_restore --list /backups/<file> | grep -c 'TABLE DATA'
   docker compose exec backup sh -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" createdb school_restore'
   docker compose exec backup sh -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" pg_restore --exit-on-error --single-transaction --dbname=school_restore /backups/<file>'
   ```

   `--single-transaction` with `--exit-on-error` restores everything or nothing; a silent exit
   status `0` means everything.

4. Verify. `server/backup/verify.sql` prints every table of the record with its row count and a
   digest of its rows, so two databases holding the same record print the same lines:

   ```sh
   docker compose exec -T backup sh -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" psql --set=ON_ERROR_STOP=1 --dbname=school --tuples-only --no-align' < backup/verify.sql > /tmp/school.verify &&
     docker compose exec -T backup sh -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" psql --set=ON_ERROR_STOP=1 --dbname=school_restore --tuples-only --no-align' < backup/verify.sql > /tmp/school_restore.verify &&
     diff /tmp/school.verify /tmp/school_restore.verify && echo identical
   ```

   The `&&` matters: `diff` runs only if both queries succeeded, so two failed queries, which
   leave two empty files, cannot print `identical`. Anything else printed means the check failed.

5. End the drill, either by dropping the copy and starting the server again:

   ```sh
   docker compose exec postgres psql --username=postgres --dbname=postgres --command='DROP DATABASE school_restore'
   ../school --human compose start school
   ```

   or by switching to it, which proves the switch as well: do step 5.1, skip step 5.2, since
   `school_restore` is already restored and checked, and go on from step 5.3.

## 5. Restore over the live database

Use this when the volume is fine but the record in it is not, for example after a bad change.
Choose the newest dump from before the damage (step 1), then:

1. Stop everything that connects to the database. The backup service is stopped too, so it does
   not dump the damaged record over good dumps while you work:

   ```sh
   docker compose stop school backup
   ```

2. Restore the dump into a new database, `school_restore`, and check that `verify.sql` lists every
   table with plausible counts. The backup service is stopped, so these use one-off containers of
   it (`docker compose run`), which have its volume and connection settings but not its schedule:

   ```sh
   ../school --human compose run --rm --entrypoint sh backup -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" createdb school_restore'
   ../school --human compose run --rm --entrypoint sh backup -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" pg_restore --exit-on-error --single-transaction --dbname=school_restore /backups/<file>'
   ../school --human compose run --rm -T --entrypoint sh backup -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" psql --set=ON_ERROR_STOP=1 --dbname=school_restore --tuples-only --no-align' < backup/verify.sql
   ```

3. Switch: keep the damaged database under another name, and give the restored one the live name.

   ```sh
   docker compose exec postgres psql --username=postgres --dbname=postgres \
     --command='ALTER DATABASE school RENAME TO school_before_restore' \
     --command='ALTER DATABASE school_restore RENAME TO school'
   ../school --human compose up -d school backup
   ```

   `up` runs the one-shot `migrate` service first, since the server depends on it. Its `done` line
   lists no applied migration when the dump came from the same version of School; a dump from an
   older version is migrated forward. It also revokes `TEMPORARY` from `PUBLIC` on the renamed
   database, which the restored copy was created without, before the server logs in as
   `school_app`.

4. Once the server answers with the record you expect, drop the damaged copy:

   ```sh
   docker compose exec postgres psql --username=postgres --dbname=postgres --command='DROP DATABASE school_before_restore'
   ```

## 6. Restore after losing the database's volume

Use this when the `postgres` volume is gone or unusable but the `backups` volume, or a copy of a
dump, survives. The roles `school_owner` and `school_app` belong to the Postgres server, not to a
database, so a dump does not hold them: create them before restoring.

1. Stop everything, and remove the database's volume only if it is still there and unusable.
   Never pass `-v`, which would delete the backups too.

   ```sh
   docker compose down
   docker volume rm server_postgres
   ```

2. Start the database alone. It creates an empty `school` database with the superuser password
   from the Keychain.

   ```sh
   ../school --human compose up -d postgres
   ```

3. Create the roles, as the migrations would, then restore into `school`. `docker compose run`
   starts a one-off container of the backup service with its volume and connection settings,
   without starting its schedule, which would otherwise dump the empty database first.

   ```sh
   ../school --human compose run --rm --entrypoint ls backup -l /backups
   docker compose exec postgres psql --username=postgres --dbname=school \
     --command='CREATE ROLE school_owner NOLOGIN' --command='CREATE ROLE school_app NOLOGIN'
   ../school --human compose run --rm --entrypoint sh backup -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" pg_restore --exit-on-error --single-transaction --dbname=school /backups/<file>'
   ../school --human compose run --rm -T --entrypoint sh backup -c 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")" psql --set=ON_ERROR_STOP=1 --tuples-only --no-align' < backup/verify.sql
   ```

   If the `backups` volume is gone too but you kept a copy (step 3), put it back first:
   `../school --human compose up -d backup`, then `docker compose cp <file> backup:/backups/`, then
   `docker compose stop backup`. Starting the service dumps the empty database once; that dump
   is harmless, but do not restore it.

4. Start the rest:

   ```sh
   ../school --human compose up -d
   ```

   The `migrate` service runs before the server. It applies nothing, because the dump holds the
   migration history, and it gives `school_app` its `LOGIN` and the password `SCHOOL_APP_PASSWORD`
   from the Keychain, so the server can log in again.

## What a drill printed

These are abridged from the drill of 2026-11-22, run for flyingrobots/school#48 against a
throwaway course with three answers written through School's API. The full transcript is in that
pull request.

Step 4, the verification of the restored database (the `diff` printed `identical`):

```text
public.schema_migrations|5|2f6d0b614432060504c37bb893f6ebb0
school.answers|3|49a7d9c8e27f3227000dd6defce51e42
school.decision_notes|0|d41d8cd98f00b204e9800998ecf8427e
school.encounters|1|b9b2c55e8fc4fa350f43f681ca024a89
school.explanations|0|d41d8cd98f00b204e9800998ecf8427e
school.exposures|0|d41d8cd98f00b204e9800998ecf8427e
school.gradings|0|d41d8cd98f00b204e9800998ecf8427e
school.snapshots|1|5db55c5e0b50269d07deb29d778f3b07
school.views|0|d41d8cd98f00b204e9800998ecf8427e
```

The backup service's lines in that drill predate flyingrobots/school#135, which added `_schema` and
`run` to every line. Each line it prints now is in
[the programs' output](../../topics/program-output/README.md#the-backup-job), with real lines from
2026-11-23; for example, a retention that is not a positive whole number:

```text
$ backup.sh once   # SCHOOL_BACKUP_KEEP=0
{"_schema":{"id":"school.backup.error.refused","version":"1.0.0"},"kind":"backup","event":"error","error":"refused","code":2,"message":"SCHOOL_BACKUP_KEEP must be a positive whole number, not \"0\"","run":"a9896083-23e8-4a18-ad6c-53828c5bb34c"}
exit=2
```

## How this is tested

`server/backup/backup.test.ts` runs the script and the restore of step 4 in the same image, against
a real Postgres. It writes the learner-history story, a view and a decision note through the
server's functions, dumps the database, restores the dump into an empty database, and checks that
every read of the `LearningRecord` port, and `verify.sql`, return the same on both. It also checks
the file modes, the retention, a failed dump and the settings' validation, and validates every
line the script prints against its published schema (the cases are in
[the programs' output test plan](../../topics/program-output/test-plan.md#the-backup-job)). Those cases name Bun.SQL,
so CI's Postgres gate fails a run in which they skipped (`server/testing/postgres-gate.ts`).
Step 6's role creation is drilled, not tested.
