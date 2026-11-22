# 2. Write the server in TypeScript on Bun, with no dependencies

Date: 2026-11-18 · Status: Accepted

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
