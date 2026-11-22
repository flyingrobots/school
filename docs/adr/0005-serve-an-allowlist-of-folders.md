# 5. Serve only an allowlist of folders

Date: 2026-11-18 · Status: Accepted, amended by [ADR 6](0006-separate-framework-lessons-and-learner-state.md): the four prefixes become a configured map of named mounts; only `assets` is supplied by the framework.

## Context
Lessons linked to the AIΩN papers with `file:///Users/j/...` URLs, which do not open on a phone. The workspace also holds files that should not be served, such as `progress/` and `server/`.

## Decision
The server maps exactly four URL prefixes: `/lessons`, `/reference`, `/assets` and `/aion` (the sibling `../aion` repository). Every other path returns 404, and resolved paths that leave their folder return 403. `/` lists the lessons and reference sheets. Lesson links to the papers use `/aion/...`.

## Consequences
- Lessons must use server-relative links (`/aion/...`) for source material. Those links do not work when a lesson is opened as a file.
- Adding a new served folder is a deliberate code change.
