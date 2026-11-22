# 1. Record quiz results on a local server

Date: 2026-11-18 · Status: Accepted

## Context
Lessons are static HTML. Quiz answers were shown in the browser and then lost, so the teaching agent had no evidence of what the learner got right or wrong when planning the next lesson.

## Decision
Run a small server that serves the lessons and records every quiz answer and lesson view. The agent reads the records at the start of each `/teach` session.

## Alternatives
- Learner reports results in chat: no setup, but easy to skip and loses detail such as first-try correctness and timing.
- "Copy results" button: cheap, but still needs a manual paste every time.

## Consequences
- Lessons stay usable without the server: opened as `file://`, `quiz.js` does not try to record anything.
- The agent gets first-try accuracy and timing per question, which spaced repetition needs later.
