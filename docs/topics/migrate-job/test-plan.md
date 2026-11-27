# Migrate job output test plan

The contract ledger for [the migrate job's output](README.md) (flyingrobots/school#120). Every case
runs in `bun test`. The cases marked "real Postgres" run on the server in
`SCHOOL_TEST_POSTGRES_URL` through `Bun.SQL`; CI's gate (`server/testing/postgres-gate.ts`) fails a
run that skips them. Every line a case reads from the command is checked against the published
schema it names by Ajv (draft 2020-12), an independent validator, so a line that does not validate
fails the case.

## Schemas

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MJ-S1 | One schema per message type | `server/schemas/` holds exactly one `<id>.schema.json` per message type; each is draft 2020-12, its `$id` is `<id>/<version>`, its `_schema` pins that id and version, `kind` is `school.migrate`, and it admits no other fields | implemented | `server/migrate.test.ts`: `every message type has one schema file, named for its id, whose $id is id/version and whose _schema pins both` |
| MJ-S2 | No user info in `where` | The `start` schema accepts `postgres://db:5432/school` and refuses a URL with a user and password | implemented | `a line naming a database cannot carry a user or password: \`where\` admits no user info` |
| MJ-S3 | Shipped | Every schema file is in the image's build context, beside `migrate.ts` and `jsonl.ts` | implemented | `server/docker.test.ts`: `every published output schema is shipped, beside the migrate command that reads them` |

## Help and schemas

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MJ-H1 | `--help` | Exit 0, nothing on stderr, no settings needed. A `help` line listing every message type, the exit codes and the settings, then one `schema` line per message type, each the published file; one run id; `-h` is the same | implemented | `--help prints a help line, then the schema of every message type, as JSON Lines; exit 0, nothing on stderr, no settings needed` |
| MJ-H2 | `--schema` | Exit 0; one valid `schema` line per published file, each equal to the file | implemented | `--schema prints every published schema, one schema line each, and exits 0` |
| MJ-H3 | Side-effect free (real Postgres) | With both settings pointing at a real, empty database, `--help`, `--schema` and both with `--human` exit 0 with empty stderr, and the database has neither schema `school` nor the ledger | implemented | `--help and --schema, with every setting in place, exit 0 and change nothing in the database` |

## A run

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MJ-R1 | Streams each step (real Postgres) | `start`, one `applied` line per migration in file order, then `done`, every line valid, one run id, neither password on either stream; the next run prints `start` and `done` only, under a new run id | implemented | `a run streams start, one applied line per migration in order, then done, every line valid, one run id, no password` |
| MJ-R2 | Failure (real Postgres) | A wrong superuser password: `start` on stdout, one `error.failed` line on stderr, exit 1, neither password printed, nothing created | implemented | `a database that refuses the login is a failed error line on stderr, exit 1, naming neither password` |
| MJ-R3 | Settings | A missing URL, a missing password, or a URL that is not `postgres://`: one `error.settings` line on stderr, exit 2, nothing on stdout, no password | implemented | `a missing or invalid setting is a settings error line on stderr, exit 2, naming no password` |
| MJ-R5 | The runner tells of each file after COMMIT | `migrate(db, dir, onApplied)` hears each file in order, not a failing one, nothing on a second run; a listener that throws stops the run but its file stays applied (watched failing with the call moved inside the transaction) | implemented | `server/db/migrate.test.ts`: `onApplied hears of each file once its transaction commits, in order; not of a failing file; nothing on a second run` |
| MJ-R4 | Usage | An unknown argument: one `error.usage` line naming it, exit 2, even with valid settings | implemented | `an unknown argument is a usage error line on stderr, exit 2` |

## Prose

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MJ-P1 | `--human` help | Prose, no line parses as JSON; names the settings and `--schema`; `--humanize` prints the same | implemented | `--human and --humanize print the help as prose, not JSON, and the same prose` |
| MJ-P2 | `--human` error | A settings error is `error (settings): ...` on stderr, not JSON | implemented | `an error with --human is prose on stderr` |
| MJ-P3 | `--human` run (real Postgres) | `migrating postgres://...`, one `applied <file>` per migration, then `done: applied N migrations; school_app may log in` | implemented | `a run with --human prints prose: what it applied, and that it is done` |

## The writer

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MJ-W1 | Envelope | A line carries `_schema` with the file's version, `kind`, `run`, `at`, and ends in exactly one newline | implemented | `server/jsonl.test.ts`: `a line carries its schema's id and version, the kind, the run id and the time, and ends in one newline` |
| MJ-W2 | Unknown type | A message type with no published schema throws and prints nothing | implemented | `a message type with no published schema is refused, not printed` |
| MJ-W3 | Scrubbing | Every secret is replaced by `(redacted)` in every string, before the line is written | implemented | `every secret is replaced in every string of a line, nested ones too, before it is written` |
| MJ-W4 | Prose | With `human`, the prose is written instead, scrubbed the same way | implemented | `with human, a line is its prose instead, scrubbed the same way` |
| MJ-W5 | Captured output | `console.log`, `info`, `debug`, `warn`, `error` and `process.stdout/stderr.write` each become a `captured` line on their stream; restoring puts the originals back | implemented | `captured: what a library prints through console or process.stdout/stderr becomes a captured line on the same stream, until restored` |
| MJ-W6 | Crash | An uncaught throw or rejection becomes one `error.failed` line on stderr, then exit 1 | implemented | `crash: an uncaught throw or rejection becomes one error line on stderr, then the exit code` |
| MJ-R1 | Rename keeps every row | A record with two courses, renamed, has every row of every table unchanged but the course name, and the same triggers enabled | implemented | `renameCourse > moves every row of the old course to the new name, and nothing else` |
| MJ-R2 | Progress follows the name | After the rename, due review and lesson progress answer under the new name and nothing under the old | implemented | `renameCourse > the learner's progress reads under the new name, and none is left under the old` |
| MJ-R3 | Append-only again | After the rename an owner's update of each renamed table is refused by its trigger | implemented | `renameCourse > afterwards the record is append-only again` |
| MJ-R4 | Refusals | A bad name, a reserved name, a rename to itself, a course with no record and a name already in use are each refused, the record unchanged | implemented | `renameCourse > refuses a bad name, a course with no record, and a name that already has one, changing nothing` |
| MJ-R5 | CLI usage | `--rename-course` without one pair, twice, or with a name config refuses, is a usage error, exit 2 | implemented | `--rename-course without a from=to pair is a usage error line on stderr, exit 2` |
| MJ-R6 | CLI run | `--rename-course course=aion` prints start, renamed, done; a second run fails naming the missing course | implemented | `--rename-course from=to applies the migrations, then renames the course in the record: a renamed line before done` |
| MJ-R7 | School stopped | With a `school_app` session open, the rename is refused naming the stop command, and the record is unchanged | implemented | `--rename-course refuses while School is connected, and changes nothing` |
| MJ-R8 | Runner's lock | The rename waits while another session holds the migration runner's advisory lock, then completes | implemented | `the rename itself waits for a migration run holding the runner's lock` |
| MJ-R9 | Login closed until the next run | A committed rename leaves `school_app` NOLOGIN until the next migrate run; a refusal leaves its login as it was | implemented | `renameCourse > leaves school_app unable to log in until the next migrate run, and a refusal leaves its login as it was` |
| MJ-R10 | Names match config | The `renamed` line's `from` and `to` patterns are config.ts's course-name rule, and a trailing or doubled hyphen renames | implemented | `the renamed line admits exactly the course names config.ts accepts`; `renameCourse > accepts every name config accepts, such as a trailing or doubled hyphen` |
| MJ-R11 | No login during a rename | While a rename waits on a table lock, a new `school_app` login is refused; after the rename is refused, School can log in again | implemented | `while a rename runs, School cannot log in; once it is refused, School can again` |
| MJ-R12 | Authoring requests follow the name | An authoring request's course is renamed with the rest; its drafts and decisions, which name it by id, are unchanged; `course_authoring` answers under the new name only; the CLI prints `renamed_authoring` with the count after `renamed_installs`, and both earlier lines keep their 1.0.0 schemas | implemented | `renameCourse > moves a course's authoring requests to the new name, and its drafts and decisions follow them`; `the authoring request count is a message of its own, and the install line is still exactly as it was`; `--rename-course from=to applies the migrations, then renames the course in the record: a renamed line before done` |

## The owner's attributes

Every migrate job, one that applies nothing included, forces `school_owner` back to a `NOLOGIN`
role without `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS`, beside its update
of `school_app` (flyingrobots/school#359); it prints nothing new. The cases are in
`server/adapters/migrate-owner.test.ts`, on real Postgres. Each runs the job (`migrateRecord`) with
its optional `owner` set to a role name of the test's own, which it drops, because `school_owner` is
shared by every test on the server.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MJ-O1 | Already migrated, then `SUPERUSER LOGIN` | On a migrated database whose owner is then made `SUPERUSER LOGIN`, the next job applies nothing and the owner has none of the six attributes | implemented | `on a database already migrated, an owner since made SUPERUSER LOGIN has neither once the next job ends` |
| MJ-O2 | `SUPERUSER LOGIN` before the first job | After the first job the owner has none of the six | implemented | `an owner that already exists with SUPERUSER LOGIN before the first job has neither, nor any other, once it ends` |
| MJ-O3 | Each attribute alone | An owner made with only `SUPERUSER`, `LOGIN`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS` has none of the six after a job | implemented | `an owner that already exists with %s alone has it no longer once a job ends` |
| MJ-O4 | A correct owner is left alone | Its attributes and its `pg_authid` row's `xmin` are unchanged, so the row was not rewritten (watched failing with the attribute condition removed) | implemented | `an owner that already exists with the right attributes is left as it was: its catalog row is not rewritten` |
| MJ-O5 | No such role | The job succeeds and creates no role of that name | implemented | `with no such owner, the job's check does not fail and creates nothing` |
