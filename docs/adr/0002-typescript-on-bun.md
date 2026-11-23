# 2. Write the server in TypeScript on Bun, with no dependencies

Date: 2026-11-18 · Status: Accepted, amended by [ADR 7](0007-lesson-file-schema-in-graphql-compiled-by-wesley.md): the project gains a build step and a Rust-based schema compiler. The server runtime is unchanged — still Bun with built-ins only. Amended 2026-11-22, see below.

> **Amended 2026-11-22.** The server is still TypeScript run directly by Bun, but no longer one file or built-ins only. [RFC 3](../rfc/0003-postgres-functions-and-generated-types.md) made it a hexagon of modules under `server/`, with a `package.json` and lockfile and two dependencies, Zod and PGlite; its record is Postgres through the built-in `Bun.SQL`. `bun:sqlite` is used in one place only, read-only: the startup refusal of an old `progress.db` that still holds learner work (`server/legacy.ts`; flyingrobots/school#49).

## Context
The learner ruled out Python and asked for TypeScript and Rust. The server only serves files and stores a handful of answers.

## Decision
One TypeScript file, `server/server.ts`, run directly by Bun, using only built-ins (`Bun.serve`, `Bun.file`, `bun:sqlite`). No Rust for now.

## Alternatives
- Node 26: also runs TypeScript directly and has `node:sqlite`, but its SQLite driver is newer and its `http` module needs more code. Node's advantage, being installed nearly everywhere, does not matter on one machine.
- TypeScript plus Rust: two toolchains and an interface between them for no extra capability.

## Consequences
- No `package.json`, lockfile or build step.
- Revisit Rust if this grows into a shared or performance-sensitive tool, such as a spaced-repetition scheduler across topics.
