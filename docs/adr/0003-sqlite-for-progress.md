# 3. Store progress in SQLite

Date: 2026-11-18 · Status: Accepted, amended by [ADR 6](0006-separate-framework-lessons-and-learner-state.md): the path is configured, and the database holds one learner's private state outside any course. Amended by [ADR 9](0009-the-learning-record-is-enforced-by-the-database.md): progress is append-only and its rules are enforced by the database itself; the schema is no longer two plain tables. Amended 2026-11-22: replaced by Postgres ([RFC 3](../rfc/0003-postgres-functions-and-generated-types.md)).

> **Amended 2026-11-22: SQLite is replaced by Postgres.** The record now lives in Postgres, in schema `school`, built by the numbered migrations in `server/db/migrations/` and reached only through the functions they define ([RFC 3](../rfc/0003-postgres-functions-and-generated-types.md); flyingrobots/school#47 moved the server, flyingrobots/school#49 deleted the SQLite code). `SCHOOL_DATABASE_URL` names it: a Postgres server through `Bun.SQL` for a learner's record (`server/compose.yaml` runs one), or PGlite on disk for development and tests. The alternative rejected below won once its costs were worth paying: a second concurrent writer and more than one learner were in sight, and every rule wanted to be a database function. Nothing was migrated, because SQLite held no learner data; the server checks that at every start, refusing to start while a `progress.db` holds any answer, explanation or view (`server/legacy.ts`, the one module that still reads SQLite, read-only). "Backup is copying one file" no longer holds: a Postgres record is backed up with `pg_dump`, which the `backup` service in `server/compose.yaml` runs on a schedule ([backup and restore](../workflows/backup-and-restore/README.md), flyingrobots/school#48). The agent's `sqlite3` access in the decision below is gone; nothing yet replaces it with a read-only Postgres role. The rest of this ADR is the original decision, kept as it was.

## Context
One learner, a few hundred rows a week. The agent needs to ask questions such as "which questions have not been seen for 5 days?" and "what is first-try accuracy per lesson?".

## Decision
SQLite at `progress/progress.db`, with tables `answers` and `views`, in WAL mode. The agent queries it with the `sqlite3` CLI on the host.

## Alternatives
- JSONL append log: simplest, but every query becomes a script.
- Postgres: a server to run, a client dependency and `pg_dump` backups, with no benefit for a single local writer.

## Consequences
- Backup is copying one file.
- Moving to Postgres later is easy: two plain tables and standard SQL.
