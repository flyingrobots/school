# Program output test plan

The contract ledger for [the backup job's, the Postgres gate's and the bridge's output](README.md)
(flyingrobots/school#135). Every case runs in `bun test`. Every line a case reads from a program is
checked against the published schema it names by Ajv (draft 2020-12), an independent validator,
through `server/testing/schemas.ts`, so a line that does not validate fails the case. The cases
marked "real Postgres" need `SCHOOL_TEST_POSTGRES_URL` and Docker; they name Bun.SQL, so CI's gate
fails a run that skips them.

## The backup job

In `server/backup/backup.test.ts`. The cases without Postgres run the script under the host's
`/bin/sh` (dash on CI), since each finishes before it touches the folder or the database.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| BK-S1 | One schema per message type | `server/backup/schemas/` holds exactly the 11 message types; each is draft 2020-12, `$id` is `<id>/<version>`, `_schema` pins both, `kind` is `backup`, the envelope is required, no other field admitted | implemented | `backup schemas: one file per message type, each well formed, kind backup` |
| BK-S2 | Mounted | compose mounts `./backup/schemas` at `/backup/schemas`, read-only | implemented | `runs backup.sh on the database's own image, pinned by the same digest` |
| BK-H1 | `--help` | Exit 0, nothing on stderr, no settings: a `help` line naming every message type, the exit codes and the settings, then one `schema` line per file, each equal to it; one run id; `-h` the same | implemented | `backup --help: a help line, then every schema, as JSON Lines, exit 0, nothing on stderr, no settings needed` |
| BK-H2 | `--schema` | Exit 0; one valid `schema` line per file, with its id and version; each run its own id | implemented | `backup --schema: every published schema, one schema line each, exit 0, each run its own id` |
| BK-H3 | In the image (real Postgres) | In `postgres:18.7`, `--schema` and `--help` print the mounted files; the folder is left as it was | implemented | `Bun.SQL: in the image, --schema prints every published schema from /backup/schemas and --help the same after its help line` |
| BK-H4 | No schemas | The script alone, without its schemas: `--help` is one `error.refused` line, exit 2 | implemented | `backup --help with no published schemas beside the script: one valid refused line, exit 2` |
| BK-R1 | Golden (real Postgres) | A real dump with one dump to prune: `dumped` then `pruned` on stdout, stderr empty, `bytes` is the file's size, one run id | implemented | `Bun.SQL: a real dump's lines all name a published schema and validate: dumped on stdout, nothing on stderr, one run id` |
| BK-R2 | Every existing case validates (real Postgres) | The restore, file-mode, retention, failed-dump, put-in-place, same-second and settings cases read every line through the validator | implemented | `Bun.SQL: a dump and its folder are readable by their owner only, and nothing it prints names the password`, and the other cases of that describe |
| BK-R3 | Failed pg_dump (real Postgres) | A `pg_dump` that prints the password and a second line, then fails: one `failed` line on stderr, its message `pg_dump`'s words with the password `(redacted)`, exit 1, no file left | implemented | `Bun.SQL: a failed pg_dump is one valid failed line on stderr carrying pg_dump's message, scrubbed of the password, exit 1` |
| BK-R4 | pg_dump's stderr never leaks (real Postgres) | A `pg_dump` that warns, then dumps: one `captured` line on stderr with the warning, password redacted; `dumped` on stdout | implemented | `Bun.SQL: what pg_dump prints on stderr during a good dump is a captured line on stderr, scrubbed of the password, never raw text` |
| BK-R5 | Stopped mid-dump (real Postgres) | The schedule with a slow `pg_dump`, TERM while its `.partial` file exists: `started` then `stopped`, exit 0, stderr empty, the folder empty | implemented | `Bun.SQL: stopped mid-dump, the schedule prints a valid stopped line, exits 0 and leaves no temporary file` |
| BK-E1 | Bad settings | `SCHOOL_BACKUP_KEEP` 0 or with a quote, backslash and the password in it, `SCHOOL_BACKUP_INTERVAL_SECONDS` -5: one `error.refused` line on stderr naming the setting, exit 2, the password never printed | implemented | `backup, a bad setting: one valid refused error line on stderr naming it, exit 2, the password never printed` |
| BK-E2 | Usage | An unknown argument: one `error.usage` line naming it, exit 2 | implemented | `backup, an unknown argument: one valid usage error line on stderr, exit 2` |
| BK-P1 | Prose | `--help --human` names the settings and `--schema`, `--humanize` prints the same; a refusal is `error (refused): ...`; `--schema --human` prints each schema; no line is JSON | implemented | `backup --human and --humanize: the help, a bad setting and the schemas are prose, no line JSON` |

## The Postgres gate

In `server/testing/postgres-gate.test.ts`, running the gate as CI runs it on report files.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| PG-S1 | One schema per message type | `server/schemas/postgres-gate/` holds exactly the 6 message types, each well formed, `kind` `postgres-gate`, `at` required | implemented | `gate schemas: one file per message type, each well formed, kind postgres-gate` |
| PG-S2 | Problem shapes | `skipped`/`failed` need `name` and `file`, `missing` needs `name` and `counterpart`, `none-ran` takes neither; the wrong field is refused | implemented | `gate problem schema: each kind of problem carries exactly its own fields` |
| PG-R1 | Clean | A clean report: one `verdict` line, `ok: true`, exit 0, stderr empty | implemented | `gate, a clean report: problem-free verdict line, exit 0, every line valid, one run id` |
| PG-R2 | Problems | A skipped Bun.SQL case and a PGlite case with no counterpart: two `problem` lines then the verdict, exit 1, one run id | implemented | `gate, a failing report: a problem line for each, then the verdict, exit 1, every line valid, one run id` |
| PG-R3 | None ran | `none-ran`, then the verdict, exit 1 | implemented | `gate, a report in which nothing ran on Bun.SQL: a none-ran problem, exit 1` |
| PG-E1 | Errors | No report or an unknown option: one `error.usage` line, exit 1; an unreadable report: one `error.failed` line, exit 1 | implemented | `gate, no report named or an unknown option: one usage error line, exit 1; an unreadable report: one failed error line, exit 1` |
| PG-H1 | `--help`, `--schema` | Help line naming every type, then every schema, exit 0; `--schema` every schema | implemented | `gate --help: a help line, then every schema, as JSON Lines, exit 0, reading no report; --schema: every schema` |
| PG-P1 | Prose | Help and a verdict with `--human`: prose, no line JSON | implemented | `gate --human: the help and a verdict are prose, no line JSON` |

## The bridge

In `bridge/output.test.ts`, running the real process.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| BR-S1 | One schema per message type | `bridge/schemas/` holds exactly the 10 message types, each well formed, `kind` `bridge.<type>` | implemented | `bridge schemas: one file per message type, each well formed, kind bridge.<type>` |
| BR-R1 | A session | A run (one agent skipped, one succeeding), a test and a saved configuration: `start`, `listening`, `run.start`, two `attempt`, `run.end`, `test`, `config.saved`, each `_schema.id` `school.<kind>`, one run id, one request id, stderr empty, neither the token nor the prompt printed | implemented | `bridge, a session: start, listening, a run with its attempts, a test and a saved configuration, every line valid, one run id, no token, no prompt` |
| BR-E1 | Refusals | A short token, a bad port, an unreadable configuration, an unknown argument: one `bridge.error` line last, exit 2, no token | implemented | `bridge, a refusal to start (short token, bad port, unreadable configuration, unknown argument): one valid bridge.error line, exit 2, no token` |
| BR-H1 | `--help`, `--schema` | Without a token: a help line naming every type and the four settings, then every schema, exit 0; `-h` the same; `--schema` every schema | implemented | `bridge --help: a help line, then every schema, exit 0, without a token or listening; --schema: every schema` |
| BR-P1 | Prose | Help with `--human` names the token setting and `--schema`; a refusal with `--humanize` is `error: ...`; no line JSON, no token | implemented | `bridge --human: the help and a refusal are prose, no line JSON, and the token is never printed` |

## The writer

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| W-1 | `lineWriter` | `_schema` first, then the body as given, scrubbed; nothing added; an unpublished type throws and prints nothing | implemented | `server/jsonl.test.ts`: `lineWriter: a line is _schema first, then the body as given, scrubbed; no kind, run or time is added; an unpublished type is refused` |
