# 9. The learning record is enforced by the database

Date: 2026-11-21 · Status: Accepted, amended 2026-11-22

> **Amended 2026-11-22: the rules moved from SQLite to Postgres, and the decision stands.** The record is Postgres ([RFC 3](../rfc/0003-postgres-functions-and-generated-types.md); flyingrobots/school#47, flyingrobots/school#49), which is the alternative below "Postgres, with every operation a database function", taken. What replaced each SQLite mechanism:
>
> | SQLite, as decided below | Postgres, as built |
> | --- | --- |
> | Triggers aborting `UPDATE` and `DELETE` on `answers`, `encounters`, `snapshots` | `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers on every record table, in `server/db/migrations/0001_init.sql` |
> | One `INSERT … SELECT` over `json_tree` deriving `correct` and `first_try` | The function `school.submit`, which derives both from the stored snapshot; a partial unique index allows one first try per block and encounter under concurrent answers |
> | A trigger refusing a submission without its encounter or choice | `NOT NULL` columns and foreign keys; the pre-version-5 `NULL` columns are gone, since no data was migrated |
> | Any code holding the file could write | The server takes the role `school_app`, which may only `EXECUTE` the public functions and holds no table privilege |
> | `PRAGMA synchronous = FULL` | Postgres's `fsync` on commit; PGlite, for development and tests only, does not `fsync` and the server warns so |
> | Resume in `server/record.ts` | Resume in `school.open_encounter`, with the same six-hour rule and the encounter's aid tracking |
> | Backup by `VACUUM INTO` | `pg_dump`; nothing makes one on a schedule yet |
>
> The SQLite record, `server/record.ts`, `server/explain.ts` and `server/migrate.ts`, is deleted; so are `server/record.test.ts` and its siblings. These rules are now tested by the `LearningRecord` contract suite on PGlite and real Postgres (`server/contract/learning-record.ts`), the migration tests (`server/db/init.test.ts`), and the HTTP tests, including the hard kill (`server/server.test.ts`). Where the text below says SQLite, `sqlite3`, `json_tree` or `PRAGMA`, read it as the decision as first made.

## Context
RFC 1's learning record contract asks that every answer identify what the learner was shown, where and when they answered it, which choice they picked, and which submission it was. It also asks that the server, not the browser, decide first try.

The learner then set a harder requirement: **the student must never lose their progress, and progress is saved in School's SQLite database.** That rules out the first proposal for resuming an encounter after a reload, which kept the encounter id in the browser's `sessionStorage`. A phone clears that and a second device never has it.

A rule that only the server enforces is broken by the next bug in the server. So the question was where these rules should live, as well as what they are.

## Decision

### The database holds the rules, and the server passes inputs through
- **Append-only.** Triggers abort any `UPDATE` or `DELETE` on `answers`, `encounters` or `snapshots`. No code path, including a hand-typed `sqlite3` session, can rewrite or remove progress. A future migration that must rebuild one of these tables drops the triggers inside its own transaction and recreates them before commit.
- **Derived in the INSERT.** One statement records a submission. It finds the quiz and the choice inside the encounter's stored snapshot (`json_tree`), takes `correct` and the displayed wording from there, and sets `first_try` when the encounter holds no earlier answer to that block. A choice that is not in the snapshot yields no row. Anything the browser says about correctness is ignored.
- **Complete or refused.** A trigger refuses a submission that lacks its encounter or choice. Foreign keys tie each answer to a real encounter and each encounter to a real snapshot.
- **Durable before acknowledged.** `PRAGMA synchronous = FULL`. A 200 from `/api/answer` is sent only after the commit, so an acknowledged answer survives a power cut.

### Identities
| Identity | Where |
| --- | --- |
| Snapshot | `snapshots.hash`: SHA-256 of the resolved page as canonical JSON (keys sorted at every depth), stored once per distinct content |
| Encounter | `encounters.id`: a UUID, created when the web view of a lesson is served |
| Submission | `answers.submission_id`: a client-generated UUID, unique. A resend stores nothing and reports `duplicate` |
| Choice | `answers.choice_id`, the stable id from the lesson (flyingrobots/school#1), with the displayed text beside it |

Answers recorded before schema version 5 keep these columns NULL: unknown, not invented.

### Encounters resume on the server
Serving the web view of a lesson resumes the latest encounter of that lesson with **the same snapshot**, as long as its last activity (its creation, its latest answer or its latest explanation) is within `RESUME_WINDOW_MS`, six hours. Otherwise a new encounter starts. So:
- a reload, a dropped connection, or a phone tab coming back keeps the encounter, and first try does not reset;
- a different device continues the same encounter, because nothing lives in the browser;
- coming back the next day is a new encounter, whose first answers are first tries again. That is the spaced retrieval School is built for;
- an edited lesson has a new snapshot, so it gets a new encounter. Earlier answers still point at what the learner actually saw;
- grading an explanation is not the learner's activity, so a grading that lands, or is retried, hours later does not keep the encounter open.

The page is rendered with the encounter's recorded answers already shown. The course index counts, for each lesson, the quizzes it still shows that have been answered correctly.

### The browser carries an answer only until it is committed
`assets/quiz.js` puts each answer in a `localStorage` outbox **before** sending it. It retries with the same submission id, with backoff and on `online` and on visibility change, and removes it only on a 200, or on a 400 or 409, which retrying cannot fix. Until then the page says "Not saved yet", and it says "Saved." only once the server has confirmed. That outbox is transport, not progress: an answer given in a tunnel survives the tab closing, and the database stays the only record.

The slides view opens no encounter and records nothing (RFC 1, "Views").

## Alternatives
- **Encounter id in `sessionStorage` or a cookie.** Rejected by the requirement above: the progress, or the key to it, would live where it can be lost.
- **Rules in server code only.** Simpler SQL, but every rule then holds only while the server has no bug, and the agent's `sqlite3` access (ADR 3) could still rewrite history.
- **Postgres, with every operation a database function, and the server and browser as thin clients.** The learner raised this, and it is the same direction as this ADR taken further. Not adopted yet, because on one Mac it adds a second service to run under Docker, turns "backup is copying one file" into `pg_dump` and a restore drill, and needs a live database for every test run. It stays open. The rules here are triggers, constraints and one `INSERT … SELECT`, and they port to PL/pgSQL with little change, so this ADR does not make that move harder. The trigger for revisiting it is a second concurrent writer, such as the grading sidecar writing from another process, or more than one learner.

## Consequences
- An `UPDATE` or `DELETE` against progress fails loudly, including when the teacher means well. Corrections are additions (RFC 1, "Rules").
- Backup is still copying one file, but it must be a consistent copy (`VACUUM INTO`), and nothing yet makes one on a schedule. Losing the disk would still lose everything; that is the one remaining way to lose progress.
- `server/record.test.ts` and `server/server.test.ts` exercise these rules, including a hard kill and restart of the server.
