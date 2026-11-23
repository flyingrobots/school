---
title: "School's architecture"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-22
updated: 2026-11-22
version: 1.1.0
status: "Living reference. Describes flyingrobots/school at commit a959505, with the record on Postgres since flyingrobots/school#47; proposals are in RFCs 2 and 3."
---

# School's architecture

This page is a reference for how School is built **today**. It describes nothing that is only
proposed; for that, read [RFC 2](../../rfc/0002-lessons-written-for-each-learner.md) and
[RFC 3](../../rfc/0003-postgres-functions-and-generated-types.md). Terms are defined in the
[glossary](../../glossary.md). Every claim was read from the code at commit `a959505`.

## Contents

| Section | Covers |
| --- | --- |
| [The three parts](#the-three-parts) | Framework, course, learner state, and the trust between them |
| [The server](#the-server) | Routes, the write guard, file serving |
| [The learning record](#the-learning-record) | Tables, rules, encounters, what the rules do and do not guarantee |
| [The bridge](#the-bridge) | How explanations are graded |
| [The web app](#the-web-app) | What exists of the interface |
| [Trust and known defects](#trust-and-known-defects) | What School assumes, and what is broken |
| [Configuration](#configuration) | Every environment variable |

## The three parts

School is split into three parts with different audiences and opposite privacy needs: the
framework, a course, and one learner's state[^adr6]. This section shows how they meet.

| Part | Holds | Visibility | Where |
| --- | --- | --- | --- |
| Framework | Server, block model, bridge, web app, docs | Public | This repository |
| Course | Objectives, resources, lessons as block JSON, reference documents | Public by default | Its own repository |
| Learner state | Mission, notes, learning records, `settings.json` (the record is in Postgres) | Private | Its own folder; the server refuses to start if it, or a PGlite record, is inside a course |

**Figure 1. How the three parts meet at run time**

```mermaid
flowchart LR
    subgraph course["Course (public)"]
        lessons["lessons/*.json"]
        reference["reference/"]
    end
    subgraph framework["Framework"]
        server["Server (Bun)"]
        bridge["Bridge (host process)"]
    end
    subgraph state["Learner state (private)"]
        db[("record: PGlite db/ or Postgres")]
        settings["settings.json"]
    end
    lessons -- "read, validated at load" --> server
    reference -- "served read-only" --> server
    server -- "appends evidence" --> db
    server -- "bridge address and token" --> settings
    server -- "POST /run with a bearer token" --> bridge
```

*Figure 1. How the three parts meet at run time. The server reads the course and never writes to
it, and writes evidence only to the learner's private state. It reaches the bridge, which runs on
the host outside Docker, with a shared token.*

Today a course ships finished lessons, and every learner sees the same lesson. In short: course
content flows in read-only, evidence flows out to private state, and the bridge is the only path
to a model.

## The server

The server is one Bun program, run directly with no build step[^adr2]. Its packages are Zod and
PGlite; `Bun.SQL` is built in. It serves the built web app, course reference documents and named mounts, and a
JSON API.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/courses` | Lists installed courses with lesson and reference counts |
| GET | `/api/courses/:c` | One course: lessons with correct-quiz counts, reference documents |
| GET | `/api/courses/:c/lessons/:id` | One lesson; `?view=web` opens or resumes an encounter, `?view=slides` records nothing. `?aid=1` declares that the client records every exposure it shows, so the encounter is opened with aid tracking 1; absent, it is untracked and its aid unknown. Any other `aid` value is refused (400) |
| POST | `/api/answer` | Records a quiz answer |
| POST | `/api/explanation` | Saves an explanation, before any grading |
| POST | `/api/grade` | One grading attempt through the bridge |
| POST | `/api/view` | Records a view |
| POST | `/api/exposure` | Records help shown for a block: `{ exposureId, encounterId, blockId, kind }`, kind `hint`, `model-answer`, `feedback` or `reference`. A stored or resent id answers 200 (`stored`, `duplicate`); the id naming something else is a conflict (409); no such encounter, an untracked one, or a block that is not a quiz or explain block in its snapshot is rejected (400). An adapter that records no exposures (SQLite, no longer used by the server) answers unsupported (501) |
| GET | `/api/aid/:submissionId` | One answer's or explanation's derived aid: `{ submissionId, aid }`, aid `aided`, `no-recorded-aid` or `unknown`. No such submission is 404; an id that is not a UUID is refused (400) |
| GET | `/api/settings/status` | Whether the bridge answers |
| GET, POST | `/api/settings/bridge` | The bridge address and token; the token is never returned except once when generated. A new address clears a saved token, and is refused (409) while the token comes from the environment |
| GET, POST | `/api/settings/agents` | The bridge's agents as its file declares them; a POST only reorders them and switches them on or off |
| POST | `/api/settings/agents/test` | Runs one declared agent for real |
| GET | `/courses/:c/reference/*`, `/<mount>/*` | Files, contained in their folder after resolving symlinks |

Before any route, the server refuses with a 403 every request whose `Host` header is not one of
its names: `127.0.0.1`, `localhost`, `::1`, `HOST` when it is a real name, and the names in
`SCHOOL_ALLOWED_HOSTS`. The port is not compared. This stops a page that becomes same-origin
through DNS rebinding, which still sends its own name as the Host
([flyingrobots/school#18](https://github.com/flyingrobots/school/issues/18)).

Every `POST` under `/api/` must also carry `Content-Type: application/json` and is refused when
the browser says it is cross-site. That forces a CORS preflight the server never answers, which
stops an ordinary cross-site page from writing.

No endpoint can set an agent's command. `POST /api/settings/agents` forwards only each agent's
name and on/off switch, and the bridge's `PUT /config` accepts only a reordering of the agents
its file already declares; commands are written by editing that file on the host.

In short: the server is thin. It answers only to its own names, serves files safely, guards
writes against ordinary cross-site requests, and hands learning-record work to Postgres functions.

## The learning record

The record is Postgres, built by the numbered migrations in `server/db/migrations/` (`0001_init.sql`,
`0002_exposures.sql`, `0003_decision_notes.sql`) and reached only through the functions they define[^rfc3]. Its rules are SQL so
that server code does not have to be trusted to keep them[^adr9]. This section states what those
rules guarantee, and what they do not.

`SCHOOL_DATABASE_URL` picks where the record is, and the server refuses to start without it.
`postgres://` is a real Postgres server through `Bun.SQL`, which is where a learner's record
belongs; `server/compose.yaml` runs one beside the server. `pglite:<dir>` is PGlite, a whole
Postgres inside the server's process, on disk in one folder, for development and tests: it does
not `fsync`, so the server warns at startup that it is not crash-durable. A PGlite folder is
locked (`flock` on `<dir>.lock`) while a server has it open, so a second server on it refuses to
start rather than serve from its own copy.

| Step at startup | What happens |
| --- | --- |
| 1. The SQLite check | If `DB_PATH` (default `<SCHOOL_STATE>/progress.db`, the old SQLite record) exists and holds any answer, explanation or view, or cannot be read as SQLite, the server exits with code 2 and names the file, before it opens Postgres. Nothing migrates from SQLite (RFC 3 §3.3). |
| 2. Migrations, as the owner | The connecting role, which must be able to create roles (in practice the superuser), runs `server/db/migrate.ts`. On `Bun.SQL` it runs on one reserved connection; on PGlite, on its one session. |
| 3. Requests, as `school_app` | PGlite's session runs `SET ROLE school_app` once. On `Bun.SQL`, every statement runs in its own transaction that starts with `SET LOCAL ROLE school_app`, so no pooled connection keeps the role. The server checks that `current_user` is `school_app` before it serves. |
| 4. Function calls only | The server's record accepts only `SELECT * FROM school.<function>($1, ...)`; anything else is refused before the driver sees it. |

Both drivers log in as the superuser and then take `school_app`'s role. A statement that resets
the role would get the superuser back, which is why step 4 exists. That is a guard rail, not
tamper-proofing: the server holds the superuser URL anyway, because it runs the migrations.

Only the Postgres record observes aid (RFC 2 §3). Migration 0002 records exposures through
`record_exposure`, idempotent by the client's exposure id, and derives each answer's and
explanation's aid in `submission_aid`: **unknown** when the encounter's `aid_tracking` is NULL,
**aided** when an exposure to the same block in the same encounter has a smaller `seq`, and
**no recorded aid** otherwise. Aid is never stored, and `seq`, not `at`, decides before and after.
The server runs on this record, so `POST /api/exposure` stores exposures. The SQLite adapter,
no longer used by the server, declares that it records none: it refuses them and reports every aid
as unknown. The lesson page opens lessons with `?aid=1` and posts each exposure it shows (see
[the lesson page](../lesson-page/README.md#the-help-it-records)).

Decisions are notes that name their evidence (RFC 2 §3 and §5). Migration 0003 adds
`decision_notes`: what School chose (a course, a lesson, or a block of a lesson), the rule that
chose it as a stable id of the form `<selector>/<rule>` (for example `due-review/wrong-first-try`),
a reason a person can read, optionally the encounter the choice was made for, and the rows it
cites as `seq` values. `record_decision_note` stores a note once per note id and refuses one that
cites a row that does not exist, a row that is not evidence (a snapshot, or another note), or
evidence of another course than the choice's; an encounter it names must be of the choice's course
and lesson and hold its block. The table checks that a note cites at least one row and that every
cited `seq` is smaller than its own. Notes cite rows, never judgments, so a later regrading leaves
a note pointing at the grading it named. `encounter_evidence` lists the rows of an encounter a
note may cite; `choice_decision_notes` and `encounter_decision_notes` read notes back. Nothing
writes notes yet: the due-review selector will ([flyingrobots/school#32](https://github.com/flyingrobots/school/issues/32)).
The SQLite adapter keeps no notes, and the contract's note cases do not run on it.

**Figure 2. The learning record's tables**

```mermaid
erDiagram
    SNAPSHOTS ||--o{ ENCOUNTERS : "is shown in"
    ENCOUNTERS ||--o{ ANSWERS : "collects"
    ENCOUNTERS ||--o{ EXPLANATIONS : "collects"
    ENCOUNTERS ||--o{ EXPOSURES : "collects"
    EXPLANATIONS ||--o{ GRADINGS : "is judged by"
    SNAPSHOTS {
        text hash PK "SHA-256 of canonical JSON, checked"
        text content
        timestamptz at
    }
    ENCOUNTERS {
        uuid id PK
        text course
        text lesson
        text snapshot_hash FK
        integer aid_tracking "NULL: aid not observed"
        timestamptz at
    }
    ANSWERS {
        bigint seq PK
        uuid submission_id UK "client UUID"
        uuid encounter_id FK
        text block_id
        text choice_id
        boolean correct
        boolean first_try
        timestamptz at
    }
    EXPLANATIONS {
        uuid submission_id PK
        uuid encounter_id FK
        text block_id
        text text
        timestamptz at
    }
    GRADINGS {
        bigint seq PK
        uuid submission_id FK
        text status "succeeded or failed"
        text rubric_version
        text model
        bigint supersedes FK
        timestamptz at
    }
    EXPOSURES {
        bigint seq PK
        uuid exposure_id UK "client UUID"
        uuid encounter_id FK
        text block_id
        text kind "hint, model-answer, feedback, reference"
        timestamptz at
    }
    ENCOUNTERS |o--o{ DECISION_NOTES : "is chosen for"
    DECISION_NOTES {
        bigint seq PK
        uuid note_id UK "caller UUID"
        text course
        text lesson "NULL for a course"
        text block_id "NULL for a course or lesson"
        uuid encounter_id FK "nullable"
        text rule "selector/rule"
        text reason
        bigint_array evidence "cited seqs, each smaller than seq"
        timestamptz at
    }
```

*Figure 2. The learning record's tables, in schema `school`. Every row takes its `seq` from one
shared sequence, so "before" and "after" across tables compare `seq`, never `at`. `VIEWS` is
omitted; it records page views only. `EXPOSURES` is written only by `POST /api/exposure`, and the
web pages do not call it yet.*

| Rule | How it is enforced | What it does not cover |
| --- | --- | --- |
| Rows are never updated, deleted or truncated | `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers on every table | The owner or the superuser can drop a trigger. Guard rails, not tamper-proofing. |
| The server can only call the public functions | `school_app` has `EXECUTE` on them by name and no table privilege; `EXECUTE` is revoked from `PUBLIC`; the server's record refuses any other statement | A process holding the superuser URL |
| A resent submission stores nothing | Unique `answers.submission_id`; `school.submit` answers `duplicate`, or `conflict` for a different answer under the same id | Nothing further |
| `correct` and `first_try` come from the snapshot | `school.submit` derives them from the encounter's stored snapshot; the client's are ignored. A partial unique index allows one first try per block and encounter, even under concurrent answers | A direct `INSERT` by the owner |
| An acknowledged answer survives the server's crash | The 200 is sent after the function's transaction commits; a test kills the server hard and reads the answer back | On PGlite, an operating-system crash or power cut: PGlite writes through to its folder but does not `fsync`, so the last commits may be lost. Real Postgres `fsync`s each commit. Nothing makes scheduled backups yet. |

An encounter resumes when the learner reopens the same lesson with the same snapshot, it is that
lesson's latest encounter, its aid tracking is unchanged, and its **opening, latest answer or
latest explanation** is within six hours. A grading is not the learner's activity and does not
count.

**Listing 1. The resume rule**

```sql
  SELECT l.id INTO v_id
  FROM (SELECT e.id, e.at, e.aid_tracking FROM school.encounters e
        WHERE e.course = p_course AND e.lesson = p_lesson AND e.view = 'web' AND e.snapshot_hash = v_hash
        ORDER BY e.seq DESC LIMIT 1) l
  WHERE l.aid_tracking IS NOT DISTINCT FROM p_aid_tracking
    AND greatest(l.at,
                 (SELECT max(a.at) FROM school.answers a WHERE a.encounter_id = l.id),
                 (SELECT max(x.at) FROM school.explanations x WHERE x.encounter_id = l.id)) >= p_at - interval '6 hours';
```

*Listing 1. The resume rule, inside `school.open_encounter`. Real source code from
flyingrobots/school, `<server/db/migrations/0001_init.sql#L213-L220@eb70a31>`.*

The SQLite record (`server/record.ts`, `server/explain.ts`, `server/adapters/sqlite.ts`,
`server/migrate.ts`) is still in the repository but the server no longer uses it; it goes with
[flyingrobots/school#49](https://github.com/flyingrobots/school/issues/49).

The record can observe assistance, but nothing in the web app reports it yet. RFC 1 requires that a
submission made after a hint or a model-answer reveal is recorded as aided[^rfc1]. The API records
exposures and derives aid for tracked encounters, but the pages open every encounter untracked and
post no exposure (flyingrobots/school#51), so in practice every learner's aid is unknown today.

In short: the record derives correctness and first try from what was shown, refuses every update,
delete and truncate, and lets the server do nothing but call its functions. Its guarantees stop at
the owner and the superuser, and the web app does not yet report assistance to it.

## The bridge

Explanations are graded by agent programs the learner already uses, run by the bridge on the host
outside Docker, so their credentials never enter the container the network can reach[^rfc1].

**Figure 3. One grading**

```mermaid
sequenceDiagram
    actor L as Learner
    participant S as Server
    participant D as Record
    participant B as Bridge
    L->>S: POST /api/explanation
    S->>D: Save the explanation
    S-->>L: Saved
    L->>S: POST /api/grade
    S->>B: POST /run: prompt and response schema
    B->>B: Try each agent in order until one returns valid JSON
    B-->>S: Output and every attempt, or a failure
    S->>S: Check quoted contradictions against their sources
    S->>D: Store the grading, succeeded or failed
    S-->>L: Feedback, or "feedback is unavailable" and Retry
```

*Figure 3. One grading. The explanation is saved before any model is called, and every attempt is
stored whether it succeeds or fails. One gap: a bridge reply that is valid JSON but the wrong shape
throws before the failure is stored ([flyingrobots/school#17](https://github.com/flyingrobots/school/issues/17)).*

| Property | Today |
| --- | --- |
| Agents | Command templates, tried in order; output must match the response schema. Declared, commands included, only in the bridge's file on the host. |
| Isolation | No shell, an empty working folder, the process tree killed on timeout. This is not filesystem confinement: an agent can do whatever its own command allows. |
| Local or hosted | Agents are launched locally; whether inference is local depends on the agent. A hosted CLI sends the prompt and the explanation over the network. |
| Grading | Fidelity, completeness, accessibility, each `meets`, `partly` or `misses`, or insufficient evidence; quoted contradictions are checked to exist in the source, not to support the criticism |

In short: the bridge confines model work to the host and records every outcome, with one known
gap in handling a malformed reply.

## The web app

`web/` is a stock shadcn/ui app on Vite and React, themed from theme-book through the
`@flyingrobots` registry. A test enforces that its stylesheet holds only stock shadcn tokens, and
another that every component in `web/src/components/ui/` hashes to a fresh `shadcn add`
(`web/test/fixtures/README.md` says how to regenerate the hashes). What
exists: the theme, a light, dark and system toggle, a component sandbox at `/demo`, and three
homepage mockups. School's pages are not built yet
([flyingrobots/school#15](https://github.com/flyingrobots/school/issues/15)). ADR 9 describes a
browser outbox for unsent answers; it belonged to the deleted server-rendered pages and must be
rebuilt in the new app.

## Trust and known defects

School is private by network rather than by login. This section states what that trusts, and what
is currently broken.

| School trusts | Consequence |
| --- | --- |
| Everyone who can reach it | No login: anyone on the tailnet or localhost can use the API, including settings |
| Installed courses | Course HTML renders on School's origin with School's authority. RFC 1 decided installed courses are trusted code. |
| Configured agents | They run with the learner's account on the host, under their own commands' limits |

| Defect | Effect | Issue |
| --- | --- | --- |
| Bridge reply shape not validated | A malformed reply throws and stores no failed grading | [#17](https://github.com/flyingrobots/school/issues/17) |
| Explanations ignored by resume | An explanation does not keep its encounter open | [#19](https://github.com/flyingrobots/school/issues/19) |
| Phone over the tailnet | Never verified end to end | [#3](https://github.com/flyingrobots/school/issues/3) |

## Configuration

| Variable | Program | Meaning | Default |
| --- | --- | --- | --- |
| `SCHOOL_COURSES` | Server | `name=path` pairs, one per course | none |
| `SCHOOL_COURSE` | Server | One unnamed course | none |
| `SCHOOL_STATE` | Server | Learner state; must not be inside a course | `state/` |
| `SCHOOL_DATABASE_URL` | Server | The record: `postgres://user:password@host:port/db` (`Bun.SQL`; the user must be able to create roles) or `pglite:<dir>` (PGlite on disk, not inside a course) | none: required |
| `DB_PATH` | Server | The old SQLite record, only read: startup refuses while it holds learner work | `<SCHOOL_STATE>/progress.db` |
| `SCHOOL_MOUNTS` | Server | `name=path` pairs served read-only | none |
| `SCHOOL_WEB` | Server | The built web app | `web/dist` |
| `HOST`, `PORT` | Server | Listen address | `127.0.0.1:4747` |
| `SCHOOL_ALLOWED_HOSTS` | Server | Host names answered besides `127.0.0.1`, `localhost`, `::1` and `HOST`, comma-separated; the tailnet name | none |
| `SCHOOL_BRIDGE_URL`, `SCHOOL_BRIDGE_TOKEN` | Server | Override the saved bridge settings | none |
| `SCHOOL_BRIDGE_TOKEN` | Bridge | Shared secret, 16 characters or more | required |
| `SCHOOL_BRIDGE_CONFIG` | Bridge | Agents file, re-read per request | `~/.config/school/bridge.json` |
| `SCHOOL_BRIDGE_HOST`, `SCHOOL_BRIDGE_PORT` | Bridge | Listen address; port `0` lets the OS choose, reported in the `bridge.listening` log line | `127.0.0.1:4748` |

[^adr2]: flyingrobots/school, `docs/adr/0002-typescript-on-bun.md` at `a959505`.
[^adr6]: flyingrobots/school, `docs/adr/0006-separate-framework-lessons-and-learner-state.md` at `a959505`.
[^adr9]: flyingrobots/school, `docs/adr/0009-the-learning-record-is-enforced-by-the-database.md` at `a959505`.
[^rfc1]: flyingrobots/school, `docs/rfc/0001-school.md` at `a959505`.
[^rfc3]: flyingrobots/school, `docs/rfc/0003-postgres-functions-and-generated-types.md` at `eb70a31`.
