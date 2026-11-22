# 3. Store progress in SQLite

Date: 2026-11-18 · Status: Accepted, amended by [ADR 6](0006-separate-framework-lessons-and-learner-state.md): the path is configured, and the database holds one learner's private state outside any lesson pack.

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
