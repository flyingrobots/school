---
title: "Upgrade a compose deployment"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-23
updated: 2026-11-23
status: "How-to. Describes upgrading a School deployment under server/compose.yaml, including the first upgrade to the migrate job (flyingrobots/school#91)."
---

# Upgrade a compose deployment

This page is a how-to for the operator of a School deployment under `docker compose`. It covers
taking a new version of School into a deployment that already holds a learner's record. It also
covers the first such upgrade after flyingrobots/school#91, which needs one new setting.

## What happens on `docker compose up`

`server/compose.yaml` runs four services. `migrate` and `school` are built from the checkout
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

Run every command from `server/`, with the deployment's `server/.env` in place, as in
[back up and restore](../backup-and-restore/README.md#before-you-start).

## 1. Take a dump and copy it off the volume

A migration can fail halfway through a file; the file then rolls back. Still, keep a dump from just
before the upgrade, outside the volume, so the upgrade can always be undone
([back up and restore](../backup-and-restore/README.md), steps 2 and 3):

```sh
docker compose exec backup /bin/sh /backup/backup.sh once
docker compose exec backup ls -1t /backups
docker compose cp backup:/backups/<newest file> ./
```

## 2. Take the new version

```sh
git pull
```

## 3. Set `SCHOOL_APP_PASSWORD` (once, the first time)

Since flyingrobots/school#91, the server logs in as `school_app`, and the `migrate` service sets
that role's password. Add it to `server/.env`. It must be at least 20 letters and digits, because
compose puts it into a URL as written:

```sh
echo "SCHOOL_APP_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')" >> .env
```

Keep it. Changing it later and running step 4 again changes the role's password. Without it,
`docker compose up` stops before it starts anything:

```text
error while interpolating services.migrate.environment.SCHOOL_APP_PASSWORD: required variable SCHOOL_APP_PASSWORD is missing a value: set SCHOOL_APP_PASSWORD to a long random secret of letters and digits
```

## 4. Start it

```sh
docker compose up -d --build
```

`--build` is redundant with `pull_policy: build`, but it is harmless, and it also covers a
`compose.yaml` that predates that setting.

## 5. Check

```sh
docker compose ps -a
docker compose logs migrate school
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

`docker compose up -d` can exit 0 while a service that started is failing. Always do step 5.

| What you see | What it means | What to do |
| --- | --- | --- |
| `required variable SCHOOL_APP_PASSWORD is missing a value`, and nothing starts | Step 3 was skipped | Do step 3, then step 4 |
| `migrate` is `Exited (2)`, with an `error` line in `docker compose logs migrate` | A setting is missing or invalid, for example `SCHOOL_APP_PASSWORD` too short or with other characters than letters and digits. The line says which | Fix `server/.env`, then step 4 |
| `migrate` is `Exited (1)`, with an `error` line | The database refused, for example a migration failed (the line names the file, which was rolled back) or the superuser password is wrong | Read the message. Compose does not start the new server while the job fails; whether a server container already running keeps serving was not drilled |
| `school` restarts over and over, and its log says `the server logs into Postgres only as school_app ... this one ...` | The login check refused: it names each reason. For example `school_app` was granted something by hand, or the record's database lacks the job's `REVOKE` | Undo the hand grant (never grant `school_app` anything by hand), or run step 4 so the job runs again |
| `school` restarts over and over, and its log says `permission denied for schema public` | An old server image, from before flyingrobots/school#91, is running beside the new settings (seen in review, with a `compose.yaml` without `pull_policy: build`) | Run `docker compose up -d --build` |
| `No such image: <project>-migrate:latest` | `up` ran with `--no-build`, so nothing was built | Run `docker compose up -d --build` |
| `school` is not listed, or is `Created` but never started | `migrate` did not exit 0 | See the `migrate` rows above |

To go back, restore the dump from step 1 with
[back up and restore](../backup-and-restore/README.md), "Restore over the live database", after
checking out the previous version.

## What the drill printed

The upgrade above was drilled on 2026-11-23 for flyingrobots/school#112. The starting point was a
deployment at `1a7c021`, the last layout in which the server migrated as the superuser. It held one
answer written through School's API. The full transcript, with no password in it, is in that pull
request. Abridged:

```text
$ docker compose up -d            # step 4 before step 3
error while interpolating services.migrate.environment.SCHOOL_APP_PASSWORD: required variable SCHOOL_APP_PASSWORD is missing a value: ...
$ docker compose up -d --build    # after step 3
$ docker compose ps -a
migrate    exited    Exited (0) 1 second ago
school     running   Up Less than a second
$ docker compose exec -T postgres psql -U postgres -d school -Atc "SELECT submission_id, choice_id, first_try FROM school.answers ORDER BY seq"
d12281cd-27e7-4aac-b336-2f2cf50de0c8|a|t
```
