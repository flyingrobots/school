---
title: "Upgrade a compose deployment"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-23
updated: 2026-11-23
status: "How-to. Describes upgrading a School deployment under server/compose.yaml, including the first upgrade to the migrate job (flyingrobots/school#91) and moving the secrets into the Keychain (flyingrobots/school#123)."
---

# Upgrade a compose deployment

This page is a how-to for the operator of a School deployment under `docker compose`. It covers
taking a new version of School into a deployment that already holds a learner's record. It also
covers two one-time steps: the first upgrade after flyingrobots/school#91, which needs one new
secret, and the first after flyingrobots/school#123, which moves every secret out of
`server/.env` into the macOS Keychain. [School's secrets](../../topics/secrets/README.md) says
where they live now.

## What happens on `./school up`

`./school up` reads the three secrets from the Keychain and runs `docker compose up --detach --build`
with them in compose's environment only; compose mounts each into the services that need it.

Then `server/compose.yaml` runs four services. `migrate` and `school` are built from the checkout
(`build: .`) with `pull_policy: build`, so every `docker compose up` rebuilds them from the files
you have. Cached layers make that quick when nothing changed. A new checkout never runs beside an
old image.

1. `postgres` starts and reports healthy.
2. `migrate`, a one-shot job, applies any pending migrations as the owner. It also gives
   `school_app` its login and the password `SCHOOL_APP_PASSWORD`, clears the role's settings, and
   exits.
3. `school` starts only once `migrate` has exited 0. It logs in as `school_app` and runs its login
   check before it serves.
4. `backup` keeps dumping on its schedule (see
   [back up and restore](../backup-and-restore/README.md)).

## Before you start

Run every command from the checkout's root, with the deployment's `server/.env` in place. `docker
compose` commands that create or start a container (`up`, `run`, `start`) need the secrets, so run
them as `./school compose ...`; the others (`exec`, `logs`, `ps`, `cp`, `stop`, `down`) need none
and can also run as plain `docker compose` from `server/`, as in
[back up and restore](../backup-and-restore/README.md#before-you-start). This page runs them all
through `./school compose`.

## 1. Take a dump and copy it off the volume

A migration can fail halfway through a file; the file then rolls back. Still, keep a dump from just
before the upgrade, outside the volume, so the upgrade can always be undone
([back up and restore](../backup-and-restore/README.md), steps 2 and 3):

```sh
./school compose exec backup /bin/sh /backup/backup.sh once
./school compose exec backup ls -1t /backups
./school compose cp backup:/backups/<newest file> ./
```

## 2. Take the new version

```sh
git pull
```

## 3. Move the secrets into the Keychain (once, the first time)

Since flyingrobots/school#123, `./school up` refuses to start while `server/.env` still holds
`SCHOOL_POSTGRES_PASSWORD`, `SCHOOL_APP_PASSWORD` or `SCHOOL_BRIDGE_TOKEN`:

```text
{"kind":"school.up","event":"error","code":2,"message":"/path/to/school/server/.env still holds SCHOOL_POSTGRES_PASSWORD, SCHOOL_APP_PASSWORD: run `school import` to move them into the Keychain, then `school up` again","keys":["SCHOOL_POSTGRES_PASSWORD","SCHOOL_APP_PASSWORD"]}
```

Install the launcher's packages, then move them:

```sh
(cd host && bun install)
./school import
```

`import` stores each secret it finds in the Keychain (account `school`), then removes exactly
those lines from `server/.env` and keeps every other line. It changes nothing if a value cannot be
stored as it is, or if the Keychain already holds a different value for the same name; it says
which. It prints names, never values:

```text
{"kind":"school.import","event":"keychain","account":"school"}
{"kind":"school.import","event":"imported","name":"SCHOOL_POSTGRES_PASSWORD","account":"school"}
{"kind":"school.import","event":"imported","name":"SCHOOL_APP_PASSWORD","account":"school"}
{"kind":"school.import","event":"done","ok":true,"imported":["SCHOOL_POSTGRES_PASSWORD","SCHOOL_APP_PASSWORD"]}
```

That transcript is from the drill with a throwaway account, so its account read `school-test-...`.
If `server/.env` never had `SCHOOL_APP_PASSWORD` (a deployment from before
flyingrobots/school#91) or `SCHOOL_BRIDGE_TOKEN`, step 4 generates them. If the superuser's
password is in neither, step 4 asks for it at the terminal: type the password the database was
created with. Pressing Enter there generates a new one, which a database that already exists will
refuse; see the table below.

If you started the bridge with `SCHOOL_BRIDGE_TOKEN` in its environment, start it with plain
`bun bridge/bridge.ts` from now on: it reads the token from the Keychain.

## 4. Start it

```sh
./school up
```

It always rebuilds `migrate` and `school` (`--build`), so it also covers a `compose.yaml` that
predates `pull_policy: build`. Plain `docker compose up` no longer works: compose stops with
`environment variable "SCHOOL_POSTGRES_PASSWORD" required by secret ... is not set`.

## 5. Check

```sh
./school compose ps -a
./school compose logs migrate school
```

What a good upgrade shows (from the drill below):

```text
SERVICE    STATE     STATUS
backup     running   Up 1 second
migrate    exited    Exited (0) 1 second ago
postgres   running   Up 17 seconds (healthy)
school     running   Up Less than a second

migrate-1  | {"kind":"school.migrate","event":"start","where":"postgres://postgres:5432/school","role":"school_app"}
migrate-1  | {"kind":"school.migrate","event":"done","ok":true,"where":"postgres://postgres:5432/school","applied":[],"role":"school_app"}
school-1   | school: record in Postgres at postgres://postgres:5432/school as school_app
```

`applied` lists the migrations this run applied; `[]` means the record was already current.

## When it fails

`./school up` can exit 0 while a service that started is failing. Always do step 5.

| What you see | What it means | What to do |
| --- | --- | --- |
| `./school up` exits 2: `server/.env still holds ...` | Step 3 was skipped | Do step 3, then step 4 |
| `./school up` exits 2: `SCHOOL_POSTGRES_PASSWORD ... there is no terminal to ask at` | It was run without a terminal, and the Keychain has no superuser password | Do step 3, or run `./school up` once at a terminal |
| `migrate` is `Exited (1)` with `password authentication failed for user "postgres"` | The Keychain's superuser password is not the one the database was created with, for example one generated at the prompt | Store the right one: `security delete-generic-password -a school -s SCHOOL_POSTGRES_PASSWORD`, then `./school up` at a terminal and type it |
| `environment variable "SCHOOL_POSTGRES_PASSWORD" required by secret ... is not set` | `docker compose up` was run directly | Run `./school up` |
| `migrate` is `Exited (2)`, with an `error` line in `./school compose logs migrate` | A setting is missing or invalid, for example `SCHOOL_APP_PASSWORD` too short or with other characters than letters and digits. The line says which | Fix it in the Keychain (delete the item and let `./school up` generate it), then step 4 |
| `migrate` is `Exited (1)`, with an `error` line | The database refused, for example a migration failed (the line names the file, which was rolled back) or the superuser password is wrong | Read the message. Compose does not start the new server while the job fails; whether a server container already running keeps serving was not drilled |
| `school` restarts over and over, and its log says `the server logs into Postgres only as school_app ... this one ...` | The login check refused: it names each reason. For example `school_app` was granted something by hand, or the record's database lacks the job's `REVOKE` | Undo the hand grant (never grant `school_app` anything by hand), or run step 4 so the job runs again |
| `school` restarts over and over, and its log says `permission denied for schema public` | An old server image, from before flyingrobots/school#91, is running beside the new settings (seen in review, with a `compose.yaml` without `pull_policy: build`) | Run `./school up` |
| `No such image: <project>-migrate:latest` | `up` ran with `--no-build`, so nothing was built | Run `./school up` |
| `school` is not listed, or is `Created` but never started | `migrate` did not exit 0 | See the `migrate` rows above |

To go back, restore the dump from step 1 with
[back up and restore](../backup-and-restore/README.md), "Restore over the live database", after
checking out the previous version.

## What the drills printed

`./school import` (step 3) was drilled on 2026-11-23 for flyingrobots/school#123, with random
values in a scratch `server/.env` and a throwaway Keychain account deleted afterwards; `./school up`
was drilled from a clean Keychain on a new deployment. Neither was drilled on a deployment holding a
learner's record. The transcripts, with no secret in them, are in flyingrobots/school#132.

The upgrade to the migrate job was drilled on 2026-11-23 for flyingrobots/school#112, before the
launcher existed, so it ran `docker compose` with the passwords in `server/.env`, and its "step 3"
was adding `SCHOOL_APP_PASSWORD` there. The starting point was a deployment at `1a7c021`, the last
layout in which the server migrated as the superuser. It held one answer written through School's
API. `up` was run first without `--build`, to check that `pull_policy: build` replaces the old
server image, and then with it. The full transcript, with no password in it, is in that pull
request. Abridged:

```text
$ docker compose up -d            # before adding SCHOOL_APP_PASSWORD
error while interpolating services.migrate.environment.SCHOOL_APP_PASSWORD: required variable SCHOOL_APP_PASSWORD is missing a value: ...
$ docker compose up -d            # after adding it, without --build: the school image is rebuilt
image id of school91up-school before: sha256:4ab60f5d1846
image id of school91up-school after: sha256:fbb4869b6b8a
migrate-1  | {"kind":"school.migrate","event":"done","ok":true,"where":"postgres://postgres:5432/school","applied":[],"role":"school_app"}
school-1   | school: record in Postgres at postgres://postgres:5432/school as school_app
$ docker compose up -d --build    # with --build: the same result
$ docker compose exec -T postgres psql -U postgres -d school -Atc "SELECT submission_id, choice_id, first_try FROM school.answers ORDER BY seq"
8473769c-bfcd-46da-b386-6bf824485898|a|t
```
