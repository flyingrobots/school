---
title: "The backup job's, the Postgres gate's and the bridge's output"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-23
updated: 2026-11-23
status: "Reference. Describes what server/backup/backup.sh, server/testing/postgres-gate.ts and bridge/bridge.ts print on the default branch (flyingrobots/school#135)."
---

# The backup job's, the Postgres gate's and the bridge's output

Reference: what three of School's programs print, and the contract their output keeps. The
contract is the one [the migrate job's output](../migrate-job/README.md) keeps; this page states
where each program differs from it. What each program does is elsewhere: the backup job in
[back up and restore](../../workflows/backup-and-restore/README.md), the bridge in
[the architecture](../architecture/README.md), the gate in [the working notes](../../working-notes.md).
The cases that pin this page are in its [test plan](test-plan.md).

## The contract

- **JSON Lines by default.** Every line each program prints is one JSON object.
- **Every line names its schema.** `_schema: {"id": ..., "version": ...}` names a JSON Schema
  (draft 2020-12) published as `<id>.schema.json`. Each message type is versioned on its own, at
  `1.0.0` today. Each schema admits no field it does not list.
- **Every line stands alone.** Besides `_schema` it carries `kind` and `run`, one UUID per
  invocation (per process, for the bridge), on every line.
- **`--help` and `--schema`** print JSON Lines and exit 0, reading no setting and changing nothing.
  `--help` prints a `help` line (summary, usage, options, settings, exit codes, and the id of
  every message type), then one `schema` line per message type. `--schema` prints only the
  `schema` lines.
- **Prose only on request.** `--human` (alias `--humanize`) prints the same messages as prose.
  Nothing else changes the format.
- **No secret, ever.** The backup job scrubs `PGPASSWORD` from every message; the bridge scrubs
  `SCHOOL_BRIDGE_TOKEN` from every line. Either is replaced by `(redacted)`.
- **Additive.** Each line keeps every field it had before flyingrobots/school#135: a consumer that
  matched on `kind` and `event` still matches.

| | The backup job | The Postgres gate | The bridge |
| --- | --- | --- | --- |
| Program | `server/backup/backup.sh` (POSIX sh) | `server/testing/postgres-gate.ts` | `bridge/bridge.ts` |
| Schemas | `server/backup/schemas/` | `server/schemas/postgres-gate/` | `bridge/schemas/` |
| `kind` | `backup` | `postgres-gate` | `bridge.<type>`, the message type |
| Discriminator | `event` | `event` | `kind` |
| `at` (UTC time) | no: `docker compose logs -t` gives the time | yes | yes |
| Streams | stdout; `captured`, `failed` and `error` on stderr | all on stdout, so CI's log keeps them in order | all on stdout |
| Writer | `say` and `warn` in the script | `jsonLines` in `server/jsonl.ts` | `lineWriter` in `server/jsonl.ts` |

The backup job stays in sh because it runs in the database's own image, `postgres:18.7`, which
has no Bun. Its schemas sit beside the script, and compose mounts them at `/backup/schemas`, so
`--help` and `--schema` in the container print the files in the repository. Which version each
message type has is a table in the script (`version()`); the tests validate its real output
against the files, so the two cannot drift apart unnoticed.

## The backup job

```text
backup.sh [once] | --help | --schema [--human]
```

| Exit | Means |
| --- | --- |
| 0 | `once`: the dump succeeded. The schedule: stopped. Or `--help` or `--schema` printed |
| 1 | `once`: the dump failed. Nothing was deleted and no file left behind |
| 2 | An unknown argument, a setting that is not a positive whole number, a folder it cannot close, or no published schemas for `--help` or `--schema`. Nothing was run |

| `_schema.id` | `event` | Stream | Fields beyond the envelope | When |
| --- | --- | --- | --- | --- |
| `school.backup.help` | `help` | stdout | `command`, `usage`, `summary`, `options`, `environment`, `exit`, `output` | First line of `--help` |
| `school.backup.schema` | `schema` | stdout | `id`, `version`, `schema` | `--schema`, and `--help` after its help line |
| `school.backup.started` | `started` | stdout | `intervalSeconds`, `keep` | The schedule starts (not with `once`) |
| `school.backup.dumped` | `dumped` | stdout | `file`, `bytes` | A dump was put in place |
| `school.backup.pruned` | `pruned` | stdout | `file` | The retention deleted an older dump |
| `school.backup.waiting` | `waiting` | stdout | `seconds` | The schedule waits for the next dump |
| `school.backup.stopped` | `stopped` | stdout | none | TERM or INT; this run's temporary files removed; exit 0 |
| `school.backup.captured` | `captured` | stderr | `stream: "stderr"`, `command: "pg_dump"`, `text` | `pg_dump` printed on stderr during a dump that succeeded |
| `school.backup.failed` | `failed` | stderr | `file`, `message` | A dump failed; `message` holds `pg_dump`'s or `ln`'s own words |
| `school.backup.error.usage` | `error` | stderr | `error: "usage"`, `code: 2`, `message` | An unknown argument |
| `school.backup.error.refused` | `error` | stderr | `error: "refused"`, `code: 2`, `message` | A bad setting, a folder it cannot close, or no schemas for `--help` |

Before flyingrobots/school#135 the lines had no `_schema` and no `run`; there were no `captured`,
`help` or `schema` lines; the refusals were `{"event":"error","message":...}` with no `error` or
`code`; an unknown argument started the schedule; and `pg_dump`'s stderr from a dump that
succeeded was dropped.

### What the backup job printed

`server/backup/backup.sh` run as compose runs it (its schemas mounted at `/backup/schemas`), in the
service's image, against a scratch Postgres 18.7, on 2026-11-23. The schedule, then `docker stop`;
then `once --human`; then a dump of a database that does not exist; then a bad setting. Each
command's stdout and stderr are shown together.

```text
$ backup.sh   # the schedule, then docker stop
{"_schema":{"id":"school.backup.started","version":"1.0.0"},"kind":"backup","event":"started","intervalSeconds":21600,"keep":28,"run":"62bcc427-530c-dc96-2b3f-5abec5ade945"}
{"_schema":{"id":"school.backup.dumped","version":"1.0.0"},"kind":"backup","event":"dumped","file":"school-20261123T082433Z.dump","bytes":1105,"run":"62bcc427-530c-dc96-2b3f-5abec5ade945"}
{"_schema":{"id":"school.backup.waiting","version":"1.0.0"},"kind":"backup","event":"waiting","seconds":21600,"run":"62bcc427-530c-dc96-2b3f-5abec5ade945"}
{"_schema":{"id":"school.backup.stopped","version":"1.0.0"},"kind":"backup","event":"stopped","run":"62bcc427-530c-dc96-2b3f-5abec5ade945"}
$ backup.sh once --human
dumped school-20261123T082437Z.dump (1105 bytes)
exit=0
$ backup.sh once   # PGDATABASE=no_such_database
{"_schema":{"id":"school.backup.failed","version":"1.0.0"},"kind":"backup","event":"failed","file":"school-20261123T082437Z.dump","message":"pg_dump: error: connection to server at \"host.docker.internal\" (0.250.250.254), port 55435 failed: FATAL:  database \"no_such_database\" does not exist","run":"5b3e3d22-e539-d7f7-edb7-746f10693b78"}
exit=1
$ backup.sh once   # SCHOOL_BACKUP_KEEP=0
{"_schema":{"id":"school.backup.error.refused","version":"1.0.0"},"kind":"backup","event":"error","error":"refused","code":2,"message":"SCHOOL_BACKUP_KEEP must be a positive whole number, not \"0\"","run":"856d00d1-d2f0-464b-3a2d-71caf2eda8b9"}
exit=2
```

## The Postgres gate

```text
bun run server/testing/postgres-gate.ts <junit.xml> | --help | --schema [--human]
```

| Exit | Means |
| --- | --- |
| 0 | The Postgres suite ran in full; or `--help` or `--schema` printed |
| 1 | A problem was found, no report or an unknown option was given, or the report could not be read |

| `_schema.id` | `event` | Fields beyond the envelope | When |
| --- | --- | --- | --- |
| `school.postgres-gate.help` | `help` | `command`, `usage`, `summary`, `options`, `environment` (empty), `exit`, `output` | First line of `--help` |
| `school.postgres-gate.schema` | `schema` | `id`, `version`, `schema` | `--schema`, and `--help` after its help line |
| `school.postgres-gate.problem` | `problem` | `problem`, and for `skipped` or `failed` `name` and `file`, for `missing` `name` and `counterpart`, for `none-ran` nothing more | One thing wrong with the run, before the verdict |
| `school.postgres-gate.verdict` | `verdict` | `ok`, `ranOnBunSql`, `cases` | Last line of a run |
| `school.postgres-gate.error.usage` | `error` | `error: "usage"`, `code: 1`, `message` | No report named, more than one, or an unknown option |
| `school.postgres-gate.error.failed` | `error` | `error: "failed"`, `code: 1`, `message` | The report could not be read, or anything else was thrown |

Before flyingrobots/school#135 the lines had no `_schema`, `run` or `at`, and an error was
`{"event":"error","message":...}` with no `error` or `code`. The exit codes are unchanged.

### What the gate printed

On the JUnit report of a full local `bun test` against a scratch Postgres 18.7, on 2026-11-23:

```text
$ bun run server/testing/postgres-gate.ts junit.xml
{"_schema":{"id":"school.postgres-gate.verdict","version":"1.0.0"},"kind":"postgres-gate","event":"verdict","ok":true,"ranOnBunSql":116,"cases":731,"run":"e60967ee-18e7-46f4-9aca-b815de34d594","at":"2026-11-23T08:28:04.637Z"}
exit=0
```

## The bridge

```text
SCHOOL_BRIDGE_TOKEN=<shared secret> bun bridge/bridge.ts [--help | --schema] [--human]
```

`--help` and `--schema` need no token. Any other argument is a `bridge.error` line and exit 2.

| Exit | Means |
| --- | --- |
| 0 | `--help` or `--schema` printed; or stopped |
| 1 | An uncaught throw or rejection after start-up: one `bridge.error` line, its message only |
| 2 | Refused to start: an unknown argument, a bad setting, an unreadable configuration file, or a port it cannot listen on |

| `_schema.id` | `kind` | Fields beyond `_schema`, `kind`, `at` and `run` | When |
| --- | --- | --- | --- |
| `school.bridge.help` | `bridge.help` | `command`, `usage`, `summary`, `options`, `environment`, `exit`, `output` | First line of `--help` |
| `school.bridge.schema` | `bridge.schema` | `id`, `version`, `schema` | `--schema`, and `--help` after its help line |
| `school.bridge.start` | `bridge.start` | `host`, `port`, `config`, `agents` (name, enabled, program; null with no file yet) | Once, the settings accepted |
| `school.bridge.listening` | `bridge.listening` | `host`, `port` | Once it listens |
| `school.bridge.run.start` | `bridge.run.start` | `id` | A `POST /run` accepted |
| `school.bridge.attempt` | `bridge.attempt` | `id`, `agent`, `status`, `ms`, `exit_code`, `error` | Each agent tried in that run |
| `school.bridge.run.end` | `bridge.run.end` | `id`, `status`, `agent` | How the run ended |
| `school.bridge.test` | `bridge.test` | `agent`, `status` | A `POST /test` |
| `school.bridge.config.saved` | `bridge.config.saved` | `config`, `agents` (names, in order) | An accepted `PUT /config` |
| `school.bridge.error` | `bridge.error` | `message`; for a port it cannot listen on also `host`, `port` and `code` (`EADDRINUSE` for a taken port, else the system's code or null) | A refusal to start, an uncaught throw or rejection, or a request handler's throw (answered 500) |

No line holds a prompt or an answer. Before flyingrobots/school#135 the lines had no `_schema`
and no `run`, and arguments were ignored.

### What the bridge printed

`bun bridge/bridge.ts` from the repository on 2026-11-23, with a configuration of two agents, one
missing and one a script that answers `{"ok": true}`: one `POST /run`, one `POST /test` and one
`PUT /config`, then stopped. The temporary folder holding the configuration is shown as `$DIR`;
nothing else is changed. Then a refusal, as JSON and as prose.

```text
{"_schema":{"id":"school.bridge.start","version":"1.0.0"},"kind":"bridge.start","at":"2026-11-23T08:28:11.387Z","host":"127.0.0.1","port":47135,"config":"$DIR/bridge.json","agents":[{"name":"missing","enabled":true,"program":"no-such-cli-qqq"},{"name":"good","enabled":true,"program":"$DIR/good"}],"run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
{"_schema":{"id":"school.bridge.listening","version":"1.0.0"},"kind":"bridge.listening","at":"2026-11-23T08:28:11.387Z","host":"127.0.0.1","port":47135,"run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
{"_schema":{"id":"school.bridge.run.start","version":"1.0.0"},"kind":"bridge.run.start","at":"2026-11-23T08:28:11.513Z","id":"587123e3-f1f1-44f7-83ec-9a90c83f11ff","run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
{"_schema":{"id":"school.bridge.attempt","version":"1.0.0"},"kind":"bridge.attempt","at":"2026-11-23T08:28:11.910Z","id":"587123e3-f1f1-44f7-83ec-9a90c83f11ff","agent":"missing","status":"skipped","ms":0,"exit_code":null,"error":"no-such-cli-qqq: not found on PATH","run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
{"_schema":{"id":"school.bridge.attempt","version":"1.0.0"},"kind":"bridge.attempt","at":"2026-11-23T08:28:11.910Z","id":"587123e3-f1f1-44f7-83ec-9a90c83f11ff","agent":"good","status":"succeeded","ms":395,"exit_code":0,"error":null,"run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
{"_schema":{"id":"school.bridge.run.end","version":"1.0.0"},"kind":"bridge.run.end","at":"2026-11-23T08:28:11.910Z","id":"587123e3-f1f1-44f7-83ec-9a90c83f11ff","status":"succeeded","agent":"good","run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
{"_schema":{"id":"school.bridge.test","version":"1.0.0"},"kind":"bridge.test","at":"2026-11-23T08:28:11.930Z","agent":"good","status":"succeeded","run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
{"_schema":{"id":"school.bridge.config.saved","version":"1.0.0"},"kind":"bridge.config.saved","at":"2026-11-23T08:28:11.940Z","config":"$DIR/bridge.json","agents":["good","missing"],"run":"ca39b5a7-04f7-4e0f-abad-1298478acc84"}
$ SCHOOL_BRIDGE_TOKEN=short bun bridge/bridge.ts
{"_schema":{"id":"school.bridge.error","version":"1.0.0"},"kind":"bridge.error","at":"2026-11-23T08:28:11.955Z","message":"set SCHOOL_BRIDGE_TOKEN to a shared secret of at least 16 characters; the server sends the same one","run":"9bb0153d-eaa6-4697-b3d9-3f9f350f722e"}
exit=2
$ SCHOOL_BRIDGE_TOKEN=short bun bridge/bridge.ts --human
error: set SCHOOL_BRIDGE_TOKEN to a shared secret of at least 16 characters; the server sends the same one
exit=2
```

## What the contract cannot cover

A consumer must go by the exit status when a stream ends without the line it expected.

- **A signal kill.** `SIGKILL` ends any of them with no last line. The backup job handles `TERM`
  and `INT` (a `stopped` line); the gate and the bridge install no handler for them.
- **The backup job's own tools.** The script redirects or captures the stderr of `pg_dump`, `ln`,
  `mktemp`, `chmod`, `ls` and `rm`. If `sh` itself, `od`, `sed`, `awk`, `tr`, `date` or `wc` failed
  (a broken image), their own messages would reach stderr as raw text. A failed `rm` during the
  retention prints nothing: that dump is simply not pruned.
- **The gate's crash line.** An uncaught throw in the gate is an `error.failed` line, but on stderr
  (it is `server/jsonl.ts`'s handler), unlike its other lines.
- **A hard crash, or writes below `console`.** A crash inside Bun or a native module, or output
  Bun writes straight to file descriptor 1 or 2, is not a line, in the gate or the bridge. The
  bridge's agents print into pipes the bridge reads, never into its own output.
