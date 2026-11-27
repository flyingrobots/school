---
title: "The backup job's, the Postgres gate's and the bridge's output"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-23
updated: 2026-11-27
status: "Reference. Describes what server/backup/backup.sh, server/testing/postgres-gate.ts and bridge/bridge.ts print on the default branch (flyingrobots/school#135; the bridge's questions, flyingrobots/school#226; its drafts, flyingrobots/school#259)."
---

# The backup job's, the Postgres gate's and the bridge's output

Reference: what three of School's programs print, and the contract their output keeps. The
contract is the one [the migrate job's output](../migrate-job/README.md) keeps; this page states
where each program differs from it. What each program does is elsewhere: the backup job in
[back up and restore](../../workflows/backup-and-restore/README.md), the bridge in
[the architecture](../architecture/README.md), the gate in [the working notes](../../working-notes.md).
The cases that pin this page are in its [test plan](test-plan.md).
`school check` keeps the same contract; its message types are in
[a course's folder](../course-format/README.md#checking-a-course).
The launcher (`./school`) keeps it too; its message types are in
[secrets](../secrets/README.md) and `host/schemas/`.

## The contract

- **JSON Lines by default.** Every line each program prints is one JSON object.
- **Every line names its schema.** `_schema: {"id": ..., "version": ...}` names a JSON Schema
  (draft 2020-12) published as `<id>.schema.json`. Each message type is versioned on its own, at
  `1.0.0` today. Each schema admits no field it does not list.
- **Every line stands alone.** Besides `_schema` it carries `kind` and `run`, one UUID per
  invocation (per process, for the bridge), on every line: a random (version 4) UUID, which
  the schemas require.
- **`--help` and `--schema`** print JSON Lines and exit 0, reading no setting and changing nothing.
  `--help` prints a `help` line (summary, usage, options, settings, exit codes, and the id of
  every message type), then one `schema` line per message type. `--schema` prints only the
  `schema` lines.
- **Prose only on request.** `--human` (alias `--humanize`) prints the same messages as prose.
  Nothing else changes the format.
- **No secret, ever.** The backup job scrubs `PGPASSWORD` (read from `PGPASSWORD_FILE` under
  compose) from every message; the bridge scrubs its token, from the environment or the Keychain,
  from every line. Either is replaced by `(redacted)`.
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

`server/backup/backup.sh` from `server/`, under the host's `/bin/sh`, on 2026-11-23: a bad setting,
the same as prose, and an empty argument. Each command's stdout and stderr are shown together.
These paths stop before the script touches the folder or the database, so they run outside the
image; the lines a dump prints (`started`, `dumped`, `pruned`, `waiting`, `failed`, `stopped`) are
checked by the tests in the image, and their fields are in the table above.

```text
$ backup.sh once   # SCHOOL_BACKUP_KEEP=0
{"_schema":{"id":"school.backup.error.refused","version":"1.0.0"},"kind":"backup","event":"error","error":"refused","code":2,"message":"SCHOOL_BACKUP_KEEP must be a positive whole number, not \"0\"","run":"a9896083-23e8-4a18-ad6c-53828c5bb34c"}
exit=2
$ backup.sh once --human   # SCHOOL_BACKUP_KEEP=0
error (refused): SCHOOL_BACKUP_KEEP must be a positive whole number, not "0"
exit=2
$ backup.sh ''   # an empty argument
{"_schema":{"id":"school.backup.error.usage","version":"1.0.0"},"kind":"backup","event":"error","error":"usage","code":2,"message":"unknown argument \"\"; usage: backup.sh [once] | --help | --schema [--human]","run":"5bad2295-f786-4e8c-acf7-a4d34c8e4e11"}
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
| `school.bridge.listening` | `bridge.listening` | `host`, `port`, `tokenFrom` (`environment` or `keychain`) | Once it listens |
| `school.bridge.run.start` | `bridge.run.start` | `id` | A `POST /run` accepted |
| `school.bridge.attempt` | `bridge.attempt` | `id`, `agent`, `status`, `ms`, `exit_code`, `error` | Each agent tried in that run |
| `school.bridge.run.end` | `bridge.run.end` | `id`, `status`, `agent` | How the run ended |
| `school.bridge.ask.start` | `bridge.ask.start` | `id` | A `POST /ask` accepted, before any agent runs |
| `school.bridge.ask.attempt` | `bridge.ask.attempt` | `id`, `agent`, `status` (`succeeded`, `failed` or `skipped`), `ms`, `exit_code`, `error`, `deltas` (how many pieces of the answer it passed on) | After the question, each ask agent tried for it |
| `school.bridge.ask.end` | `bridge.ask.end` | `id`, `status`, `agent` (whose words the caller received; null if none), `deltas`, `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, each an integer or null; null for an agent whose output kind reports none) | How the question ended |
| `school.bridge.author.start` | `bridge.author.start` | `id`, `files` and `guide_files` (how many files the request sent under `course/` and `guide/`) | A `POST /author` accepted, before any agent runs |
| `school.bridge.author.attempt` | `bridge.author.attempt` | `id`, `agent`, `status` (`succeeded`, `failed`, `skipped` or `refused`), `ms`, `exit_code`, `error` (why it failed; for a refused draft the refusal's reason alone, never a path), `steps` (how many tool uses it passed on) | After the draft, each author agent tried for it |
| `school.bridge.author.end` | `bridge.author.end` | `id`, `status` (`succeeded`, `refused` or `failed`), `agent`, `steps`, `files` and `bytes` (what came back; null unless it succeeded), `refusal` (the reason, such as `symlink`, `unreadable` or `file-too-large`; null unless refused), `guide_sha256` (the digest of the guide as written into the agent's folder; null when no agent ran), `usage` | How the draft ended |
| `school.bridge.test` | `bridge.test` | `agent`, `status` | A `POST /test` |
| `school.bridge.config.saved` | `bridge.config.saved` | `config`, `agents` (names, in order) | An accepted `PUT /config` |
| `school.bridge.speak.submit` | `bridge.speak.submit` | `id`, `state`, `segments` | A `POST /speak` the daemon accepted ([reading aloud](../reading-aloud/README.md)) |
| `school.bridge.speak.cancel` | `bridge.speak.cancel` | `id`, `state` | A `POST /speak/:id/cancel` |
| `school.bridge.speak.failed` | `bridge.speak.failed` | `op` (`submit`, `get`, `segment` or `cancel`), `status` (`unavailable` or `refused`), `message` | A `/speak` request the daemon could not serve |
| `school.bridge.error` | `bridge.error` | `message`; for a port it cannot listen on also `host`, `port` and `code` (`EADDRINUSE` for a taken port, else the system's code or null) | A refusal to start, an uncaught throw or rejection, or a request handler's throw (answered 500). For a draft that throws, `message` names only the error's kind and code, never a path |

No line holds a prompt, an answer, a file or text to speak: a question's lines count the answer's
pieces and tokens, never its words, and a draft's lines count its steps, files and bytes, never a
path or a file's content. Before flyingrobots/school#135 the lines had no `_schema` and no
`run`, and arguments were ignored.

### What the bridge printed

`bun bridge/bridge.ts` from the repository on 2026-11-23, the token in the environment, with a configuration of two agents, one
missing and one a script that answers `{"ok": true}`: one `POST /run`, one `POST /test` and one
`PUT /config`, then stopped. The temporary folder holding the configuration is shown as `$DIR`;
nothing else is changed. Then a refusal, as JSON and as prose.

```text
{"_schema":{"id":"school.bridge.start","version":"1.0.0"},"kind":"bridge.start","at":"2026-11-23T10:57:25.808Z","host":"127.0.0.1","port":47135,"config":"$DIR/bridge.json","agents":[{"name":"missing","enabled":true,"program":"no-such-cli-qqq"},{"name":"good","enabled":true,"program":"$DIR/good"}],"run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
{"_schema":{"id":"school.bridge.listening","version":"1.0.0"},"kind":"bridge.listening","at":"2026-11-23T10:57:25.809Z","host":"127.0.0.1","port":47135,"tokenFrom":"environment","run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
{"_schema":{"id":"school.bridge.run.start","version":"1.0.0"},"kind":"bridge.run.start","at":"2026-11-23T10:57:25.815Z","id":"3b85662c-704a-4139-aac5-079ba7ae5cb7","run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
{"_schema":{"id":"school.bridge.attempt","version":"1.0.0"},"kind":"bridge.attempt","at":"2026-11-23T10:57:25.981Z","id":"3b85662c-704a-4139-aac5-079ba7ae5cb7","agent":"missing","status":"skipped","ms":0,"exit_code":null,"error":"no-such-cli-qqq: not found on PATH","run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
{"_schema":{"id":"school.bridge.attempt","version":"1.0.0"},"kind":"bridge.attempt","at":"2026-11-23T10:57:25.981Z","id":"3b85662c-704a-4139-aac5-079ba7ae5cb7","agent":"good","status":"succeeded","ms":165,"exit_code":0,"error":null,"run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
{"_schema":{"id":"school.bridge.run.end","version":"1.0.0"},"kind":"bridge.run.end","at":"2026-11-23T10:57:25.981Z","id":"3b85662c-704a-4139-aac5-079ba7ae5cb7","status":"succeeded","agent":"good","run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
{"_schema":{"id":"school.bridge.test","version":"1.0.0"},"kind":"bridge.test","at":"2026-11-23T10:57:25.996Z","agent":"good","status":"succeeded","run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
{"_schema":{"id":"school.bridge.config.saved","version":"1.0.0"},"kind":"bridge.config.saved","at":"2026-11-23T10:57:26.004Z","config":"$DIR/bridge.json","agents":["good","missing"],"run":"1c73fe6a-2e1c-4176-b147-a18fb671da53"}
$ SCHOOL_BRIDGE_TOKEN=short bun bridge/bridge.ts
{"_schema":{"id":"school.bridge.error","version":"1.0.0"},"kind":"bridge.error","at":"2026-11-23T10:57:26.020Z","message":"set SCHOOL_BRIDGE_TOKEN to a shared secret of at least 16 characters; the server sends the same one","run":"1bdfc7b1-e39f-4cb3-9874-cc7191a15924"}
exit=2
$ SCHOOL_BRIDGE_TOKEN=short bun bridge/bridge.ts --human
error: set SCHOOL_BRIDGE_TOKEN to a shared secret of at least 16 characters; the server sends the same one
exit=2
```

### What the bridge printed for a question

`bun bridge/bridge.ts` from the repository on 2026-11-26, the token in the environment, with an
`ask` list of two agents. The first is missing. The second is a script that prints two text
deltas and a result in Claude Code's stream-json shapes; it is not a real model. The listing
shows one `POST /ask` with the prompt `What is a passage?`: first the bridge's log, then the NDJSON
reply the caller received. The temporary folder holding the configuration is shown as `$DIR`;
nothing else is changed. The log counts the answer's two pieces and its tokens, and holds neither
the question nor the answer.

```text
{"_schema":{"id":"school.bridge.start","version":"1.0.0"},"kind":"bridge.start","at":"2026-11-26T23:20:04.349Z","host":"127.0.0.1","port":0,"config":"$DIR/bridge.json","agents":[{"name":"grader","enabled":true,"program":"true"}],"run":"8eb2eadf-f519-40ae-a7a2-b83e60956044"}
{"_schema":{"id":"school.bridge.listening","version":"1.0.0"},"kind":"bridge.listening","at":"2026-11-26T23:20:04.353Z","host":"127.0.0.1","port":61775,"tokenFrom":"environment","run":"8eb2eadf-f519-40ae-a7a2-b83e60956044"}
{"_schema":{"id":"school.bridge.ask.start","version":"1.0.0"},"kind":"bridge.ask.start","at":"2026-11-26T23:20:04.455Z","id":"94563c77-f15c-4b6a-a98d-fba48934f91c","run":"8eb2eadf-f519-40ae-a7a2-b83e60956044"}
{"_schema":{"id":"school.bridge.ask.attempt","version":"1.0.0"},"kind":"bridge.ask.attempt","at":"2026-11-26T23:20:04.864Z","id":"94563c77-f15c-4b6a-a98d-fba48934f91c","agent":"missing","status":"skipped","ms":0,"exit_code":null,"error":"no-such-cli-qqq: not found on PATH","deltas":0,"run":"8eb2eadf-f519-40ae-a7a2-b83e60956044"}
{"_schema":{"id":"school.bridge.ask.attempt","version":"1.0.0"},"kind":"bridge.ask.attempt","at":"2026-11-26T23:20:04.864Z","id":"94563c77-f15c-4b6a-a98d-fba48934f91c","agent":"claude","status":"succeeded","ms":408,"exit_code":0,"error":null,"deltas":2,"run":"8eb2eadf-f519-40ae-a7a2-b83e60956044"}
{"_schema":{"id":"school.bridge.ask.end","version":"1.0.0"},"kind":"bridge.ask.end","at":"2026-11-26T23:20:04.864Z","id":"94563c77-f15c-4b6a-a98d-fba48934f91c","status":"succeeded","agent":"claude","deltas":2,"usage":{"input_tokens":12,"output_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"run":"8eb2eadf-f519-40ae-a7a2-b83e60956044"}
```

```text
{"type":"delta","text":"A passage "}
{"type":"delta","text":"is a short piece of a text."}
{"type":"end","status":"succeeded","agent":"claude","usage":{"input_tokens":12,"output_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"error":null,"attempts":[{"agent":"missing","status":"skipped","ms":0,"exit_code":null,"error":"no-such-cli-qqq: not found on PATH","deltas":0},{"agent":"claude","status":"succeeded","ms":408,"exit_code":0,"error":null,"deltas":2}]}
```

### What the bridge printed for a draft

`bun bridge/bridge.ts` from the branch of flyingrobots/school#259 on 2026-11-27, the token in the
environment, with an `author` list of two agents. The first is missing. The second is a script that
prints three tool uses and a result in Claude Code's stream-json shapes and rewrites
`course/lessons/01.json`; it is not a real model. The listing shows one `POST /author` with a
two-file course and a one-file guide: first the bridge's log, then the NDJSON reply the caller
received. The temporary folder holding the configuration is shown as `$DIR`; nothing else is
changed. The log counts the steps, files and bytes, and holds neither the prompt, a path nor a file.

```text
{"_schema":{"id":"school.bridge.start","version":"1.0.0"},"kind":"bridge.start","at":"2026-11-27T05:38:27.239Z","host":"127.0.0.1","port":0,"config":"$DIR/bridge.json","agents":[{"name":"grader","enabled":true,"program":"true"}],"run":"a1029689-cb4b-48e8-b01c-39c504934e2c"}
{"_schema":{"id":"school.bridge.listening","version":"1.0.0"},"kind":"bridge.listening","at":"2026-11-27T05:38:27.240Z","host":"127.0.0.1","port":55274,"tokenFrom":"environment","run":"a1029689-cb4b-48e8-b01c-39c504934e2c"}
{"_schema":{"id":"school.bridge.author.start","version":"1.0.0"},"kind":"bridge.author.start","at":"2026-11-27T05:38:27.369Z","id":"10c074a6-b18a-4033-b2ae-20580426fef4","files":2,"guide_files":1,"run":"a1029689-cb4b-48e8-b01c-39c504934e2c"}
{"_schema":{"id":"school.bridge.author.attempt","version":"1.0.0"},"kind":"bridge.author.attempt","at":"2026-11-27T05:38:27.600Z","id":"10c074a6-b18a-4033-b2ae-20580426fef4","agent":"missing","status":"skipped","ms":0,"exit_code":null,"error":"no-such-cli-qqq: not found on PATH","steps":0,"run":"a1029689-cb4b-48e8-b01c-39c504934e2c"}
{"_schema":{"id":"school.bridge.author.attempt","version":"1.0.0"},"kind":"bridge.author.attempt","at":"2026-11-27T05:38:27.600Z","id":"10c074a6-b18a-4033-b2ae-20580426fef4","agent":"claude","status":"succeeded","ms":230,"exit_code":0,"error":null,"steps":3,"run":"a1029689-cb4b-48e8-b01c-39c504934e2c"}
{"_schema":{"id":"school.bridge.author.end","version":"1.0.0"},"kind":"bridge.author.end","at":"2026-11-27T05:38:27.600Z","id":"10c074a6-b18a-4033-b2ae-20580426fef4","status":"succeeded","agent":"claude","steps":3,"files":2,"bytes":61,"refusal":null,"guide_sha256":"2a4e9ea6bdc5709a9976ef0e7f30a47c2be0a81850dbfb79d97c7ccac94f8aa8","usage":{"input_tokens":120,"output_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"run":"a1029689-cb4b-48e8-b01c-39c504934e2c"}
```

```text
{"type":"step","tool":"Read","path":"guide/SKILL.md"}
{"type":"step","tool":"Read","path":"course/lessons/01.json"}
{"type":"step","tool":"Edit","path":"course/lessons/01.json"}
{"type":"files","files":[{"path":"course.json","base64":"eyJ0aXRsZSI6IkZpeHR1cmUifQ=="},{"path":"lessons/01.json","base64":"eyJpZCI6Im9uZSIsInRpdGxlIjoiQSBwYXNzYWdlLCByZXZpc2VkIn0K"}]}
{"type":"end","status":"succeeded","agent":"claude","usage":{"input_tokens":120,"output_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"error":null,"refusal":null,"guide_sha256":"2a4e9ea6bdc5709a9976ef0e7f30a47c2be0a81850dbfb79d97c7ccac94f8aa8","attempts":[{"agent":"missing","status":"skipped","ms":0,"exit_code":null,"error":"no-such-cli-qqq: not found on PATH","steps":0},{"agent":"claude","status":"succeeded","ms":230,"exit_code":0,"error":null,"steps":3}]}
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
