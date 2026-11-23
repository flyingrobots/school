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
