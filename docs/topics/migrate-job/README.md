---
title: "The migrate job's output"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-23
updated: 2026-11-23
status: "Reference. Describes what server/migrate.ts prints on the default branch (flyingrobots/school#120)."
---

# The migrate job's output

Reference: what the migrate job, `server/migrate.ts`, prints, and the contract its output keeps.
The job itself (what it does to the database, and why only it holds the superuser's URL) is in
[the architecture](../architecture/README.md); running it in a deployment is in
[upgrade a compose deployment](../../workflows/upgrade/README.md). The cases that pin this page
are in its [test plan](test-plan.md).

## The contract

- **JSON Lines by default, on both streams.** Every line on stdout and on stderr is one JSON object.
- **Every line names its schema.** `_schema: {"id": ..., "version": ...}` is the id and version of a
  JSON Schema (draft 2020-12) published in `server/schemas/<id>.schema.json`. Each message type is
  versioned on its own, never with School's version. Each schema admits no field it does not list.
- **Every line stands alone.** Besides `_schema` it carries `kind: "school.migrate"`, an `event`
  (the discriminator), `run` (one UUID per invocation, on every line it prints) and `at` (UTC, ms).
- **Progress streams.** A run prints `start`, then one `applied` line per migration as soon as its
  transaction commits, then `done`. Nothing is buffered to the end.
- **Errors are lines.** Each failure is one `error` line on stderr, then the exit code. A top-level
  handler turns any uncaught throw or rejection into an `error.failed` line.
- **Library output is wrapped.** While the job runs, anything printed through `console` or
  `process.stdout`/`process.stderr` (a driver's notice, say) becomes a `captured` line on the same
  stream instead of raw text.
- **No password, ever.** A database is named by scheme, host, port and database only (the `where`
  schema refuses user info), and every string in every line is scrubbed of both passwords.
- **Prose only on request.** `--human` (alias `--humanize`) prints the same messages as prose.
  Nothing else changes the format: there is no TTY detection.

## Usage

```text
SCHOOL_MIGRATE_URL=postgres://... SCHOOL_APP_PASSWORD=... bun migrate.ts
bun migrate.ts --rename-course <from>=<to>
bun migrate.ts --help | --schema [--human]
```

| Option | Does |
| --- | --- |
| `--help`, `-h` | Prints a `help` line, then a `schema` line for every message type; exit 0. Reads no setting, touches no database |
| `--schema` | Prints a `schema` line for every message type; exit 0. Reads no setting, touches no database |
| `--rename-course <from>=<to>` | After the migrations, renames course `<from>` to `<to>` in the record and prints a `renamed` line and a `renamed_installs` line (below) |
| `--human`, `--humanize` | Prose instead of JSON Lines. With `--help`, the prose names the message types rather than printing their schemas; `--schema --human` prints each schema indented |

Any other argument, or `--rename-course` without one `<from>=<to>` pair or given twice, is an
`error.usage` line and exit 2, before any setting is read.

| Exit | Means |
| --- | --- |
| 0 | Every pending migration applied (or none was pending) and `school_app` may log in; or `--help` or `--schema` printed |
| 1 | The database refused, a migration failed (that file rolled back; earlier files stay applied), or anything else was thrown |
| 2 | An unknown argument, or `SCHOOL_MIGRATE_URL` or `SCHOOL_APP_PASSWORD` missing or invalid. Nothing was changed |

## Message types

All at version `1.0.0`. The files in `server/schemas/` are the authority; `bun migrate.ts --schema`
prints them.

| `_schema.id` | `event` | Stream | Fields beyond the envelope | When |
| --- | --- | --- | --- | --- |
| `school.migrate.help` | `help` | stdout | `command`, `usage`, `summary`, `options`, `environment`, `exit`, `output` (every message type id) | First line of `--help` |
| `school.migrate.schema` | `schema` | stdout | `id`, `version`, `schema` (the published file) | `--schema`, and `--help` after its help line |
| `school.migrate.start` | `start` | stdout | `where`, `role` | Settings accepted, before connecting |
| `school.migrate.applied` | `applied` | stdout | `version`, `name` | Each migration, once committed |
| `school.migrate.renamed` | `renamed` | stdout | `from`, `to`, `rows` (`encounters`, `views`, `decision_notes`) | `--rename-course`, once the rename commits |
| `school.migrate.renamed.installs` | `renamed_installs` | stdout | `course_installs`, `course_removals` | `--rename-course`, right after `renamed` |
| `school.migrate.done` | `done` | stdout | `ok: true`, `where`, `applied` (versions, in order), `role` | Last line of a good run |
| `school.migrate.captured` | `captured` | either | `stream`, `text` | A library printed something |
| `school.migrate.error.usage` | `error` | stderr | `error: "usage"`, `code: 2`, `message` | Unknown argument |
| `school.migrate.error.settings` | `error` | stderr | `error: "settings"`, `code: 2`, `message` | A missing or invalid setting |
| `school.migrate.error.failed` | `error` | stderr | `error: "failed"`, `code: 1`, `message` | Anything else |

A short `SCHOOL_APP_PASSWORD` is caught by the job itself, after `start`, so that case prints a
`start` line before its `error.settings` line. Every other settings error comes before `start`.

Before flyingrobots/school#120 the lines had `kind`, `event`, `where`, `role`, `ok`, `applied`,
`code` and `message` as they are now, with no `_schema`, `run`, `at` or `error`, and no `applied`
line per migration. A consumer that matched on `kind` and `event` still matches.

## What it prints

From `server/`, against a scratch Postgres 18.7 on 127.0.0.1:55420 (the same image as compose),
on 2026-11-23. A first run on an empty database, then a second:

```text
$ bun migrate.ts
{"_schema":{"id":"school.migrate.start","version":"1.0.0"},"kind":"school.migrate","event":"start","where":"postgres://127.0.0.1:55420/school","role":"school_app","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.350Z"}
{"_schema":{"id":"school.migrate.applied","version":"1.0.0"},"kind":"school.migrate","event":"applied","version":1,"name":"0001_init.sql","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.445Z"}
{"_schema":{"id":"school.migrate.applied","version":"1.0.0"},"kind":"school.migrate","event":"applied","version":2,"name":"0002_exposures.sql","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.464Z"}
{"_schema":{"id":"school.migrate.applied","version":"1.0.0"},"kind":"school.migrate","event":"applied","version":3,"name":"0003_last_studied.sql","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.478Z"}
{"_schema":{"id":"school.migrate.applied","version":"1.0.0"},"kind":"school.migrate","event":"applied","version":4,"name":"0004_decision_notes.sql","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.504Z"}
{"_schema":{"id":"school.migrate.applied","version":"1.0.0"},"kind":"school.migrate","event":"applied","version":5,"name":"0005_read_committed.sql","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.529Z"}
{"_schema":{"id":"school.migrate.applied","version":"1.0.0"},"kind":"school.migrate","event":"applied","version":6,"name":"0006_due_review.sql","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.581Z"}
{"_schema":{"id":"school.migrate.done","version":"1.0.0"},"kind":"school.migrate","event":"done","ok":true,"where":"postgres://127.0.0.1:55420/school","applied":[1,2,3,4,5,6],"role":"school_app","run":"c9e655ac-51f5-4026-b44c-b5ae6bff8379","at":"2026-11-23T07:24:07.606Z"}
exit=0
$ bun migrate.ts   # again
{"_schema":{"id":"school.migrate.start","version":"1.0.0"},"kind":"school.migrate","event":"start","where":"postgres://127.0.0.1:55420/school","role":"school_app","run":"bbf5ca4b-985b-40bf-a79d-a17a9170d84b","at":"2026-11-23T07:24:07.654Z"}
{"_schema":{"id":"school.migrate.done","version":"1.0.0"},"kind":"school.migrate","event":"done","ok":true,"where":"postgres://127.0.0.1:55420/school","applied":[],"role":"school_app","run":"bbf5ca4b-985b-40bf-a79d-a17a9170d84b","at":"2026-11-23T07:24:07.731Z"}
exit=0
```

The same with `--human`, then three errors (stderr shown inline):

```text
$ bun migrate.ts --human   # a third run
migrating postgres://127.0.0.1:55420/school for school_app (run 033e7186-96f5-4a05-8cfe-2edf48baa22b)
done: nothing to apply; school_app may log in
exit=0
$ bun migrate.ts   # SCHOOL_APP_PASSWORD unset
{"_schema":{"id":"school.migrate.error.settings","version":"1.0.0"},"kind":"school.migrate","event":"error","error":"settings","code":2,"message":"SCHOOL_APP_PASSWORD is not set: it is the password school_app logs in with, the one in the server's SCHOOL_DATABASE_URL","run":"b39b7ba0-501e-4851-a304-b5fe25231080","at":"2026-11-23T07:24:07.869Z"}
exit=2
$ bun migrate.ts --dry-run
{"_schema":{"id":"school.migrate.error.usage","version":"1.0.0"},"kind":"school.migrate","event":"error","error":"usage","code":2,"message":"unknown argument --dry-run; usage: bun migrate.ts [--help | --schema] [--human]","run":"58609d89-a618-442e-959b-f4155b36096a","at":"2026-11-23T07:24:07.909Z"}
exit=2
$ bun migrate.ts   # wrong superuser password
{"_schema":{"id":"school.migrate.start","version":"1.0.0"},"kind":"school.migrate","event":"start","where":"postgres://127.0.0.1:55420/school","role":"school_app","run":"f4888b59-86f9-4f33-b3c6-3ed603f42b77","at":"2026-11-23T07:24:07.960Z"}
{"_schema":{"id":"school.migrate.error.failed","version":"1.0.0"},"kind":"school.migrate","event":"error","error":"failed","code":1,"message":"password authentication failed for user \"postgres\"","run":"f4888b59-86f9-4f33-b3c6-3ed603f42b77","at":"2026-11-23T07:24:07.988Z"}
exit=1
```

To check a run in a script, read the last line and its `event`, for example with `jq`:
`bun migrate.ts | tail -n 1 | jq -e '.event == "done"'`.

## Renaming a course

A course's name files the learner's progress in the record: every encounter, view and decision
note names its course, and so does every install and removal of an installed course (RFC 7 §7,
flyingrobots/school#232). A trust choice names its install by id, so it follows the install. A deployment names its main course after the folder it is mounted at
(`/course`, so `course`) unless `SCHOOL_COURSES` names it. Renaming one changes where that progress
is filed, so School must be stopped while it happens: a running server goes on writing under the
name it started with. From `server/`:

1. Stop School, leaving the database up: `../school compose stop school`.
2. Take a backup and copy it out (docs/workflows/backup-and-restore, steps 2 and 3).
3. Rename: `../school compose run --rm migrate bun migrate.ts --rename-course course=aion`. It
   prints `start`, `renamed` with the rows moved per table, `renamed_installs` with the install and
   removal rows moved (a message of its own, so `renamed` is the 1.0.0 line it always was), then `done`.
4. Name the course in `server/.env`: `SCHOOL_COMPOSE_COURSE=` (empty) and
   `SCHOOL_COURSES=aion=/course,...` with any other courses.
5. Start School again: `../school up`.

The rename (`server/db/rename-course.ts`) is one transaction, as `school_owner`, holding both of the
migrate job's advisory locks, so it waits for a migration run and none starts during it. It refuses:

- while any `school_app` session is open on the database ("stop it first"), checked after the
  tables are locked and again just before committing;
- a name config would refuse: not a lowercase letter or digit followed by lowercase letters, digits
  and hyphens, or a reserved name (`api`, `assets`, `courses`, `lessons`, `reference`); this one
  before anything runs, as a usage error, exit 2;
- a `<from>` the record has nothing for;
- a `<to>` it already has, since that would merge two courses.

It first takes away `school_app`'s login, committed on its own, so School cannot log in while the
rename runs. Then it locks every record table against writes until it commits, checks, and checks
for `school_app` sessions again just before committing. After a rename `school_app` cannot log in
until the next migrate run, which `../school up` (step 5) starts with the new configuration; a
refusal gives the login back. `school_app` is a role of the whole Postgres server, so this covers
every database on it: rehearsing on a restored copy beside the live record (the backup drill's
`school_restore`) also keeps the live School from logging in until `../school up`, so stop School
for a rehearsal too. It lifts the
append-only trigger on the five tables that name a course only inside the transaction, and commits
only if every record table's row count is unchanged, every trigger is enabled again and no row names
`<from>`. A refusal or failure rolls all of it back, triggers included, and exits 1 with the reason.
Snapshots hold page content and name no course, so they are not touched. Links to the old course's
lessons stop working.

If it refused because `<to>` already has rows, nothing changed: find out where those rows came from
before choosing another name. To check the outcome, compare each table's count per course before and
after (`SELECT course, count(*) FROM school.encounters GROUP BY 1`, and the same for `views`,
`decision_notes`, `course_installs` and `course_removals`), through `../school compose exec postgres psql -U postgres -d school`.

## What the contract cannot cover

These are outside what the job can turn into a line. A consumer must treat a stream that ends
without `done` or an `error` line as a failure and go by the exit status.

- **A signal kill.** `SIGKILL`, or `SIGTERM`/`SIGINT` (the job installs no handler), ends the
  process with no last line; the exit status is 128 plus the signal. A `SIGTERM` while the job
  waited on the migration lock left only its `start` line, exit status 143 (seen 2026-11-23). Postgres rolls back the file
  that was running when its connection drops; files committed before it stay applied, each
  already announced by its `applied` line.
- **A hard crash.** A crash inside Bun or a native module (a segfault, an abort, running out of
  memory) can print Bun's own crash report on stderr, which is not JSON.
- **Writes below `console` and `process.stdout`/`stderr`.** Output that Bun or a native module
  writes straight to file descriptor 1 or 2 is not captured. None is known today: the tests see
  empty stderr on every good run.
- **Failures before `server/migrate.ts` runs.** Bun failing to load the module (a syntax error,
  a missing import or schema file) prints Bun's error, not a line. `server/docker.test.ts` checks
  that the image ships every module and schema the job reads.
- **A closed stream.** If stdout is closed early (`bun migrate.ts --help | head -c 20`), the
  write fails and the job prints one `error.failed` line, `"message":"EPIPE: broken pipe, write"`,
  on stderr and exits 1 (seen 2026-11-23). If stderr is closed too, nothing can be written.
