---
title: "School's architecture"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-22
updated: 2026-11-27
version: 1.5.2
status: "Living reference. Describes flyingrobots/school as read at commit a959505, plus the bridge's `POST /ask` (flyingrobots/school#226), with the record on Postgres since flyingrobots/school#47 and SQLite deleted by flyingrobots/school#49; proposals are in RFCs 2 and 3."
---

# School's architecture

This page is a reference for how School is built **today**. It describes nothing that is only
proposed; for that, read [RFC 2](../../rfc/0002-lessons-written-for-each-learner.md) and
[RFC 3](../../rfc/0003-postgres-functions-and-generated-types.md). Terms are defined in the
[glossary](../../glossary.md). Every claim was read from the code at commit `a959505`, except the bridge's `POST /ask` paragraph, which was read from `bridge/ask.ts` on the branch of flyingrobots/school#226.

## Contents

| Section | Covers |
| --- | --- |
| [The three parts](#the-three-parts) | Framework, course, learner state, and the trust between them |
| [The server](#the-server) | Routes, the write guard, file serving, the course list |
| [The pinned skill](#the-pinned-skill) | The `school` skill an authoring agent is given, its manifest digest, and when authoring is off |
| [The hexagon](#the-hexagon) | The core, its ports and the adapters that implement them |
| [The learning record](#the-learning-record) | Tables, rules, encounters, what the rules do and do not guarantee |
| [The bridge](#the-bridge) | How explanations are graded |
| [The web app](#the-web-app) | What exists of the interface |
| [Trust and known defects](#trust-and-known-defects) | What School assumes, and what is broken; fetching a course repository, previewing an install and installing it |
| [Configuration](#configuration) | Every environment variable |
| [Secrets](../secrets/README.md) | Where the three secrets live (the macOS Keychain) and how each reaches its process; its own page |

## The three parts

School is split into three parts with different audiences and opposite privacy needs: the
framework, a course, and one learner's state[^adr6]. This section shows how they meet.

| Part | Holds | Visibility | Where |
| --- | --- | --- | --- |
| Framework | Server, block model, bridge, web app, docs | Public | This repository |
| Course | Objectives, resources, an optional `course.json` with its title, lessons as block JSON, reference documents ([a course's folder](../course-format/README.md)) | Public by default | Its own repository |
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
| GET | `/api/courses` | Lists every course in [the course list](#the-course-list), configured or installed, each with its `name` (the slug in addresses), `title`, `trusted` (false for a course in [safe mode](#trust-and-known-defects)), and `summary`, `author`, `license` and `format`, each null when the course does not declare it ([a course's folder](../course-format/README.md)), with lesson and reference counts, and each course's `quizzes` and `answeredCorrectly`; the counts are `null` for a course whose lessons cannot be read. An installed course that is listed but not served has `lessons`, `quizzes` and `answeredCorrectly` `null`, `reference` 0, and its reason in `lessonsError` |
| GET | `/api/resume` | What to study now, from where the learner left off: `continue`, `next`, `start`, `finished` or `nothing` ([the home page](../home-page/README.md)); each but `nothing` names its course and gives its `trusted` |
| GET | `/api/feedback` | The newest succeeded grading: its course, the course's `trusted`, lesson, the prompt it answered and the findings; `null` before any. A course no longer served gives `trusted: false` |
| GET | `/api/review?tz=` | The questions due for review now, across courses, each with its course's `trusted`, its lesson, question and reason ([due review](../due-review/README.md)); the reason names its day in `tz` |
| GET | `/api/activity?days=14&tz=` | Each course's `trusted`, its study days in the last `days` (1 to 60), and how many questions come back on each day ahead, as days in `tz`; and its `quizzes` and `mastery`, how many of them are `notStarted`, `settling`, `holding` and `faded` at the server's clock ([the home page](../home-page/README.md#how-each-course-is-holding)) |
| GET | `/api/showcase` | What's ahead: every lesson with a quiz not yet answered correctly, with its hook ([a course's folder](../course-format/README.md#a-lessons-hook)) and its course's `trusted` |
| GET | `/api/courses/:c` | One course: its `name`, `title`, `trusted`, `summary`, `author`, `license` and `format` (null when not declared), lessons with correct-quiz counts and `mastery`, how many of each lesson's quizzes are `notStarted`, `settling`, `holding` and `faded` at the server's clock ([the course page](../course-page/README.md#each-lessons-mastery)), reference documents. Lessons that cannot be read are `lessons: null` with the reason in `lessonsError`, still a 200 with the reference documents. An installed course that is listed but not served answers the same shape with `reference: []`, and its lessons and reference files answer 404 |
| GET | `/api/courses/:c/lessons/:id` | One lesson; `?view=web` (the default) opens or resumes an encounter, `?view=slides` records nothing. The web view answers only School's own `fetch()`: a request whose `Sec-Fetch-Site` is not `same-origin` or whose `Sec-Fetch-Dest` is not `empty`, such as an image or a link from another page, is refused (403) and opens nothing; one with neither header, as over plain HTTP on a name other than localhost, is answered ([trust](#trust-and-known-defects)). `?aid=1` declares that the client records every exposure it shows, so the encounter is opened with aid tracking 1; absent, it is untracked and its aid unknown. Any other `aid` value is refused (400). `?tz=` is the zone a review reason names its day in |
| POST | `/api/answer` | Records a quiz answer |
| POST | `/api/explanation` | Saves an explanation, before any grading |
| POST | `/api/grade` | One grading attempt through the bridge |
| POST | `/api/view` | Records a view |
| POST | `/api/exposure` | Records help shown for a block: `{ exposureId, encounterId, blockId, kind }`, kind `hint`, `model-answer`, `feedback` or `reference`; `ai-help` is refused (400), since only the server records help for a whole encounter. A stored or resent id answers 200 (`stored`, `duplicate`); the id naming something else is a conflict (409); no such encounter, an untracked one, or a block that is not a quiz or explain block in its snapshot is rejected (400) |
| GET | `/api/aid/:submissionId` | One answer's or explanation's derived aid: `{ submissionId, aid }`, aid `aided`, `no-recorded-aid` or `unknown`. No such submission is 404; an id that is not a UUID is refused (400) |
| GET | `/api/settings/status` | Whether the bridge answers |
| GET | `/api/settings/authoring` | Whether authoring is on: `{ authoring: "on", skill: { digest, files } }`, the [pinned skill](#the-pinned-skill)'s manifest digest and file count, or `{ authoring: "off", reason }`. Nothing authors a course yet |
| GET, POST | `/api/settings/bridge` | The bridge address and token; the token is never returned except once when generated. A new address clears a saved token, and is refused (409) while the token comes from the environment |
| GET, POST | `/api/settings/agents` | The bridge's agents as its file declares them; a POST only reorders them and switches them on or off |
| POST | `/api/settings/agents/test` | Runs one declared agent for real |
| POST | `/api/installs/preview` | `{url, commit}`: fetches, extracts and checks one commit of a course repository in the course store's `staging/`, and answers what was found, the suggested name and any progress already under it; `courses/` and the record are unchanged ([previewing an install](#previewing-an-install)). A refusal is a 422 with its stage and reason, a malformed body 400, and no course store 503. Refused when `Sec-Fetch-Site` is present and is not `same-origin`: 403 `{ status: "forbidden", error }`. A failure that is not a refusal (the store or the record) is 500 `{ status: "failed", error }`, with the reason in School's log and the preview's folder deleted |
| POST | `/api/installs` | `{preview, name}`: installs a preview under a name, untrusted, and answers 201 `{ status: "installed", install, course, url, commit, trusted: false }`; the course is served from the next request ([installing a previewed course](#installing-a-previewed-course)). A refusal is `{ status: "refused", reason, message }`: 409 for `name-taken`, `changed` or `not-recorded`, 404 `unknown-preview`, 410 `expired`, 422 `bad-name`, `over-limit` or `invalid-course`. A malformed body is 400, no course store 503, a `Sec-Fetch-Site` other than `same-origin` 403, and a failure of the store or the record 500 `{ status: "failed", error }`, with the reason in School's log and any moved folder deleted |
| POST | `/api/speak` | `{ course, lesson }` or `{ feedback: true }`, never text: the server builds the text and submits it to AI-TTS through the bridge; `{ id, state, segments }`. No bridge, or no daemon, is a 503 with the reason ([reading aloud](../reading-aloud/README.md)) |
| GET | `/api/speak/:id` | That reading's progress, each segment ready or not |
| GET | `/api/speak/:id/segments/:n` | One segment's WAV, with byte ranges |
| POST | `/api/speak/:id/cancel` | Stops that reading at the daemon |
| GET, PUT | `/api/settings/time-zone` | The time zone the learner chose, `{zone}`, or `null` for automatic; a PUT appends a choice (an IANA zone or `null`; anything else is 400) |
| GET | `/courses/:c/reference/*` | A course's reference files, contained in its folder after resolving symlinks. An untrusted course's are sandboxed ([trust](#trust-and-known-defects)) |
| GET | `/<mount>/*` | A mount's files, contained in its folder after resolving symlinks. Never sandboxed, so no mount may reach an untrusted course's folder: startup refuses one that does ([trust](#trust-and-known-defects)) |

`tz` (flyingrobots/school#178) is the learner's IANA time zone, which the web app sends from the browser on every request whose answer names a day: `/api/activity`, `/api/review` and a lesson opened in the web view. A zone chosen in Settings (`/api/settings/time-zone`, flyingrobots/school#181) wins over `tz`. Without either, the server uses its own zone, which is UTC under Docker. A `tz` that is not a zone is refused (400).

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
its file already declares, in the grading list, the ask list or both; commands are written by
editing that file on the host.

### The course list

The server serves configured and installed courses together, under one set of names (RFC 7 §5.2 and
§7, flyingrobots/school#234). `server/course-registry.ts` builds the list:

- **Configured courses** come from `SCHOOL_COURSES`, `SCHOOL_COURSE` and `SCHOOL_UNTRUSTED_COURSES`,
  each with its `course.json`, read once at start.
- **Installed courses** come from `school.installed_courses()`, read again by every request that
  uses the list. An install, a removal or a trust choice in the record is therefore served on the
  next request, with no restart. Each is served from `<SCHOOL_COURSE_STORE>/courses/<install id>/`,
  with the record's title. It is untrusted, and so in [safe mode](#trust-and-known-defects),
  unless the record's latest trust choice for that install trusts it.
- **An install that is listed but not served.** The first time the list sees an install, it
  computes the folder's content digest and compares it with the record's `content_sha256`
  ([a course's folder](../course-format/README.md#an-installed-courses-folder)). Then, on every
  request, it checks that the folder still exists and is unchanged (below). A folder that is
  missing, holds other files, or holds anything but regular files and folders is still listed,
  with `lessons: null` and its reason
  in `lessonsError`, and none of its files are served. So is a folder the file system cannot read
  (an unreadable subfolder, or one that vanishes while it is read): only that install is affected,
  every other course is still served, and the failure is not remembered, so the install is served
  again once its folder is fixed. A reason names the install by id and says what failed; it never
  holds an absolute path of the course store. With no `SCHOOL_COURSE_STORE`, every install is
  listed this way. The start logs each such course to stderr.
- **A name both configured and installed** stops the start with exit code 2. The message names the
  configured folder and the install id. If such a row is written while School runs, School logs
  it to stderr once and the configured course keeps the name.
- **When the record cannot be reached.** A configured course is found by name without reading the
  record, so its lessons and reference files never wait on `installed_courses()`. If a read of the
  list cannot reach the record, the configured courses are still served, and each install the list
  last saw is listed with `lessons: null` and a reason saying the record cannot be reached; none of
  its files are served until the record answers. The server logs the outage once, and again when
  the record answers.

An install's folder is written once and never changed, so its digest is not computed on every
request (flyingrobots/school#322). Just before computing it, the list takes a **fingerprint** of the
folder: the device, inode, size, and modification and change times, in nanoseconds, of every file
and folder in it, the folder itself included. Every request compares the fingerprint, one `lstat`
per entry and no hashing. A file added, removed or renamed changes its folder's times, so the
entries already listed are enough. On any difference the list computes the digest again: a folder
whose digest is still the record's is served, with a new fingerprint, and one whose digest is not is
listed as not served, trusted or not, with a reason naming the install id. So a file changed while
School runs is checked at each request, and one put back as it was recorded is served again. The
check is not a lock: a file can change in the small window between the check and the read, which
takes write access to the course store. A filesystem with coarse timestamps could also miss a
change made in the same tick as the one before it.

`POST /api/installs` is the only writer of `courses/`
([installing a previewed course](#installing-a-previewed-course)). It moves a checked course into
its install's folder and makes every file read-only before it records the install, so the list
fingerprints an install's folder only once it is complete. At start, before serving, School deletes
every entry of `courses/` that is not a current install's folder: the folder of an install a later
one replaced, or one a crash left between moving it there and recording it. A symlink there is
removed, never followed, and a `courses/` that is not a real folder is not swept.

A request that fails, most often because the record cannot be reached, answers `503` with
`{ error }` in JSON, a neutral sentence with no stack trace, and the server logs the error's message
to stderr.

In short: the server is thin. It answers only to its own names, serves files safely, guards
writes against ordinary cross-site requests, and hands learning-record work to Postgres functions.

## The pinned skill

An authoring agent will be given the `school` skill from this checkout, `.agents/skills/school/`, with the two references it links, `docs/topics/course-format/` and `docs/topics/voice/`, never a copy installed on the host, so the skill that writes a draft and the check that judges it are one version (RFC 9 §5.3, flyingrobots/school#257). The image is built from `server/` alone, so compose mounts the three folders read-only at `/framework/skills/school`, `/framework/docs/course-format` and `/framework/docs/voice`. `SCHOOL_SKILL` and `SCHOOL_SKILL_DOCS` name them; outside compose they default to the checkout's own. Nothing authors a course yet: this is the first step of RFC 9.

At start the server hashes them into one **manifest digest** (`server/skill.ts`), laid out as the agent's `guide/` folder will be: the skill's files at its root and each reference under `docs/<name>/`.

```text
<sha256 of SKILL.md's bytes> SKILL.md
<sha256 of README.md's bytes> docs/course-format/README.md
...
<sha256 of glossary.html's bytes> example/reference/glossary.html
```

_Listing 1. The manifest. One line per regular file: the file's SHA-256 in lowercase hex, one space, its path under `guide/` with `/` between parts, and a line feed. Lines are sorted by path as UTF-8 bytes, so `Z` sorts before `a`. The digest is the SHA-256 of the whole text, in lowercase hex._

The server logs `school: authoring on: the school skill's manifest digest is <digest> (<n> files)` and reports the same at `GET /api/settings/authoring`. The digest is computed, not stored: the record will carry it with each authoring request when those exist (RFC 9 §5.5).

Authoring is **off**, and School still serves, when `SCHOOL_SKILL` is empty, the skill folder is missing or is not a folder, it has no `SKILL.md`, a reference folder is missing, or any folder holds a symlink, a special file or a name with a line break. The server then logs `school: authoring off: <reason>`, and the API gives the same reason, naming the path and the checkout folder to mount there.

In short: one skill, from the checkout, mounted read-only and hashed at start; without it, authoring says it is off and why.

## The hexagon

The server is built as a hexagon[^rfc3]: the **core** holds School's use cases and talks only to
**ports**, interfaces it defines; **adapters** implement the ports, one technology each. This
section names each piece as it is in the code.

| Piece | Where | Does |
| --- | --- | --- |
| Model | `server/core/model.ts` | Zod schemas for every value that crosses a port or the HTTP API |
| Ports | `server/core/ports.ts` | `LearningRecord` (the record), `Grader` (an explanation to findings or a failure) and `Clock` |
| Use cases | `server/core/school.ts` | `createSchool`: open a lesson, submit an answer, save, grade and read explanations, record views and exposures, read aid, choose an explanation's pitch from mastery (`server/core/explain-pitch.ts`, [mastery](../mastery/README.md#pitching-an-explanation)) |
| HTTP adapter and composition root | `server/server.ts` | Parses each request with the model, calls one use case, and wires the core to its adapters; it also reads the course folders itself (`server/blocks.ts`), which are not behind a port |
| Postgres adapter | `server/adapters/postgres.ts` | `LearningRecord` as one call of a `school.*` function per method, every result parsed by the model |
| `Sql` port and its drivers | `server/adapters/sql.ts`, `pglite.ts`, `bunsql.ts` | One `query(text, params)`; PGlite in process, or `Bun.SQL` on a pool |
| Opening the record | `server/adapters/database.ts`, `lock.ts` | Reads `SCHOOL_DATABASE_URL`; on Postgres, refuses a login that fails any of [the login check](#the-login-check)'s listed checks; on PGlite, runs the migrations as the owner and takes `school_app`'s role; refuses any statement but a function call, and locks a PGlite folder |
| The migrate job | `server/migrate.ts` | With `SCHOOL_MIGRATE_URL` (the owner's or superuser's URL), runs the migrations as the owner, makes `school_app` a login with `SCHOOL_APP_PASSWORD`, clears its role settings, and exits; prints schema'd JSON Lines on stdout and stderr through `server/jsonl.ts`, each line's schema in `server/schemas/` ([the migrate job's output](../migrate-job/README.md)) |
| Grader | `server/server.ts`, `server/grade.ts` | The bridge client; with no bridge connected, an attempt fails and says so |
| Clock | `server/server.ts` | The system clock; tests pass a fixed one |

**Figure 2. The server's hexagon**

```mermaid
flowchart LR
  http["HTTP adapter<br/>server.ts: Bun.serve + Zod"] --> core
  subgraph core["Core: server/core/"]
    uc["createSchool: openLesson · submitAnswer<br/>saveExplanation · gradeExplanation · recordExposure"]
  end
  core --> lr["LearningRecord port"]
  core --> gr["Grader port"]
  core --> cl["Clock port"]
  lr --> pg["Postgres adapter<br/>school.* function calls"]
  pg --> sql["Sql port"]
  sql --> pglite["PGlite driver<br/>tests and development"]
  sql --> bunsql["Bun.SQL driver<br/>a Postgres server"]
  gr --> bridge["Bridge client"]
  cl --> sys["System clock"]
```

*Figure 2. The server's hexagon. One driving adapter, three driven ports, and two drivers under
the one SQL port, so tests and production run the same functions.*

| Rule | Enforced by |
| --- | --- |
| The core imports nothing but itself and Zod | `server/core/boundary.test.ts` |
| Every `LearningRecord` adapter behaves the same | The contract suite, `server/contract/learning-record.ts`, and the learner-history story beside it, registered for the Postgres adapter on PGlite (`server/adapters/postgres.test.ts`) and on `Bun.SQL` against a real Postgres when `SCHOOL_TEST_POSTGRES_URL` is set (`server/adapters/bunsql.test.ts`) |
| The Postgres adapter issues only function calls | Its test refuses any other statement, and so does the server's record at run time |

In short: the use cases know only their ports, there is one record adapter, Postgres, and the
contract suite holds every driver under it to the same behaviour.

## The learning record

The record is Postgres, built by the numbered migrations in `server/db/migrations/` (`0001_init.sql`,
`0002_exposures.sql`, `0003_last_studied.sql`, `0004_decision_notes.sql`, `0005_read_committed.sql`,
`0006_due_review.sql`, `0007_since_last_here.sql`, `0008_study_days.sql`, `0009_time_zone_choices.sql`,
`0010_course_installs.sql`, `0011_mastery.sql`, `0012_ai_help.sql`, `0013_mastery_rollup.sql`,
`0014_faded_review.sql`, `0015_course_progress.sql`, `0016_authoring.sql`, `0017_conversations.sql`) and reached only through the functions they define[^rfc3]. Its rules are SQL so
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
| 2. Migrations, as the owner | On Postgres, not in the server: the migrate job (`server/migrate.ts`; the one-shot `migrate` service in `server/compose.yaml`, which the server waits for with `service_completed_successfully`) connects with `SCHOOL_MIGRATE_URL`, runs `server/db/migrate.ts` on one reserved connection, gives `school_app` `LOGIN` and the password `SCHOOL_APP_PASSWORD` (sent as a SCRAM verifier), clears every setting on the role (`ALTER ROLE school_app RESET ALL`, also per database), revokes `CREATE` and `TEMPORARY` on the database from `PUBLIC`, and exits. Jobs on several databases of one Postgres cluster may run at once ([below](#migrate-jobs-on-one-cluster)). On PGlite the server runs the migrations itself, on its one session, which is the superuser. |
| 3. The login check | On Postgres the server logs in with `school_app`'s URL and refuses to start (exit 2, naming each reason, and the host, never a password) unless every check in [the login check](#the-login-check) holds. PGlite has no login and skips this. |
| 4. Requests, as `school_app` | PGlite's session runs `SET ROLE school_app` once. On `Bun.SQL`, every statement still runs in its own transaction that starts with `SET LOCAL ROLE school_app`. The server checks that `current_user` is `school_app` before it serves. |
| 5. Function calls only | The server's record accepts only `SELECT * FROM school.<function>($1, ...)`; anything else is refused before the driver sees it. |

On Postgres the server holds only `school_app`'s credentials (flyingrobots/school#91). Steps 4 and 5
stay as defence in depth. PGlite's session is the superuser and takes `school_app`'s role, so there a
statement that resets the role would get the superuser back; step 5 is what stops it, a guard
rail, not tamper-proofing. PGlite is for development and tests only.

### Migrate jobs on one cluster

A Postgres server (a cluster) can hold more than one School record, each in a database of its own:
the test server does, and so could a host that serves more than one learner. Jobs on different
databases may run at once and all succeed (flyingrobots/school#356). The job's advisory locks cover
only its own database, while `school_owner`, `school_app` and the server's connection limit
belong to the whole cluster, so the job handles three things that cross databases:

| Shared by the cluster | What the job does | Before flyingrobots/school#356 |
| --- | --- | --- |
| `max_connections` | Opens one connection, and runs the whole job on it | It held ten (Bun.SQL's default pool), so a few jobs at once failed with 53300, `too_many_connections` |
| The roles, created if absent | When a job on another database creates a role between this job's check and its `CREATE ROLE`, the job waits for that job's transaction and takes the role as created: it catches `unique_violation` (23505) and `duplicate_object` (42710) from that statement only | On a cluster without the roles, every job but one failed with 23505 on `pg_authid_rolname_index` |
| `school_app`'s catalog row | The role update waits for another transaction's change to the row, then retries on Postgres's `tuple concurrently updated`, up to 20 times with a short random pause. It throws any other error at once | Unchanged |

_Table 1. What a migrate job shares with jobs on other databases of the same cluster, and how it
handles each. Jobs on different clusters share nothing, and none waits on another._

The cases are in `server/adapters/migrate-cluster.test.ts` (the [test plan](test-plan.md#migrate-jobs-on-one-cluster-flyingrobotsschool356)).

### The login check

`loginRefusals` in `server/adapters/database.ts` runs once, at startup, on the server's own
connection, in the record's database. The server refuses to start if any of these fails:

| # | Check | Covers |
| --- | --- | --- |
| 1 | `session_user` and `current_user` are both `school_app` | the superuser's or owner's URL, any other login |
| 2 | Not `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS` | role attributes |
| 3 | A member of no role (`pg_auth_members`) | `school_owner`, `pg_execute_server_program`, `pg_read_all_data` and every other role |
| 4 | Owns no schema (schema `school` included), relation, function, type or database | the owner's login, objects it created |
| 5 | Outside `pg_catalog` and `information_schema`: no privilege on any table, view, materialized view or foreign table (`SELECT` to `MAINTAIN`), no `USAGE`, `SELECT` or `UPDATE` on any sequence, no column privilege | table, column, sequence and `MAINTAIN` grants |
| 6 | In `pg_catalog` and `information_schema`: no write privilege on any relation (except `UPDATE` on `pg_settings`, which Postgres grants `PUBLIC` and which is `SET`), and no `SELECT` on the relations Postgres withholds from an ordinary role (`RESTRICTED_RELATIONS`: `pg_authid`, `pg_statistic`, `pg_shadow` and 20 more) | catalog grants to it or to `PUBLIC` |
| 7 | It may execute no function outside `pg_catalog` and `information_schema` but the 37 in `GRANTED_FUNCTIONS` (the migrations' grants), and none of the 55 built-ins Postgres withholds from an ordinary role (`RESTRICTED_FUNCTIONS`: `lo_import`, `lo_export`, `pg_read_file`, `pg_ls_dir`, `pg_reload_conf` and the rest), whether granted to it or to `PUBLIC` | function grants, helpers in `school`, functions in `public` |
| 8 | No privilege granted to it by name on any relation, column, function (but the granted ones), schema (but `USAGE` on `school`), database, type, language, large object, foreign-data wrapper, foreign server or tablespace; no parameter privilege (`pg_parameter_acl`) granted to it or to `PUBLIC` | direct grants, `GRANT SET ON PARAMETER` |
| 9 | No default privileges (`pg_default_acl`) granting to it or to `PUBLIC`, and none set by it | future grants |
| 10 | No `CREATE` on any schema; no `CREATE` or `TEMPORARY` on the record's database | creating objects there |
| 11 | Schema `school` exists | a database the migrate job has not run on |
| 12 | Only if 1 to 11 find nothing: creating a table, inserting, truncating and `COPY ... TO PROGRAM` each fail with `insufficient_privilege`, in a transaction that is always rolled back | anything the catalog checks missed that those four statements would reach |

`GRANTED_FUNCTIONS`, `RESTRICTED_FUNCTIONS` and `RESTRICTED_RELATIONS` are lists in the code; a test
checks the first against the migrations' grants and the other two against the Postgres server the
tests run on (18.7). Another major version may withhold a different set, and `MAINTAIN` needs 17
or later: on an older server the check's query fails and the server exits 1 without serving.

What the check cannot detect:

- a grant to `PUBLIC` on a built-in object outside the two restricted lists, for example a column
  of a catalog;
- anything in the cluster's other databases, except what lives in the shared catalogs (roles,
  databases, tablespaces, parameters);
- what the granted functions themselves do with their arguments (they are `SECURITY DEFINER`);
- authentication and network settings (`pg_hba.conf`, who can reach the port);
- anything granted after the server started: it checks once.

What `school_app` can still do, with the shipped grants, including:

- call the 18 granted functions;
- run every built-in function and read every catalog that Postgres lets any role use;
- create, read, write and delete large objects it owns (`lo_create`, `lo_put`), in any database it
  can connect to: Postgres has no privilege that withholds them;
- change its own password and its own role settings (`ALTER ROLE school_app ...`); the next run of
  the migrate job sets the password back to `SCHOOL_APP_PASSWORD` and clears every setting;
- connect to the cluster's other databases (`postgres`, `template1`), which `PUBLIC` may, and
  create temporary tables in `postgres`, where `PUBLIC` keeps `TEMPORARY`;
- take advisory locks, `LISTEN` and `NOTIFY`, set user-level parameters, and use up connections and
  time.

**Never grant `school_app` anything by hand.** The migrations grant what it needs. A hand grant of
a kind listed above stops the server at its next start; one of a kind the check cannot detect widens
what a compromised server can do without anyone being told.

The record observes aid (RFC 2 §3). Migration 0002 records exposures through
`record_exposure`, idempotent by the client's exposure id, and derives each answer's and
explanation's aid in `submission_aid`: **unknown** when the encounter's `aid_tracking` is NULL,
**aided** when an exposure to the same block in the same encounter has a smaller `seq`, and
**no recorded aid** otherwise. Aid is never stored, and `seq`, not `at`, decides before and after.
`POST /api/exposure` stores them. The lesson page opens lessons with `?aid=1` and posts each
exposure it shows (see [the lesson page](../lesson-page/README.md#the-help-it-records)).

Whenever a model shows the learner more about a lesson, the rule is the same: the server records one
exposure of kind `ai-help` for the whole encounter, before the model is asked, and every quiz answer
or explanation in that encounter with a larger `seq` is aided, whichever block it belongs to (RFC 6
§5.1). Migration 0012 adds it. `ai-help` is the only kind whose `block_id` is NULL, and the table
checks that it is NULL exactly then (`exposures_block`). `record_lesson_help(exposure_id,
encounter_id, kind, at)` stores one, idempotent by its id, and rejects an encounter that does not
exist or does not track aid; it is the port's `recordLessonHelp`. `submission_aid`, `due_review` and
`quiz_episodes` (so mastery too) read an exposure with no block as one to every block of its
encounter. `POST /api/exposure` refuses the kind: the browser cannot record it or skip it. The rule
errs toward marking aid: a lesson with five quizzes and one question to the model brings up to five
items back for review.

Decisions are notes that name their evidence (RFC 2 §3 and §5). Migration 0004 adds
`decision_notes`: what School chose (a course, a lesson, or a block of a lesson), the rule that
chose it as a stable id of the form `<selector>/<rule>` (for example `due-review/wrong-first-try`),
a reason a person can read, optionally the encounter the choice was made for, and the rows it
cites as `seq` values. `record_decision_note` stores a note once per note id and refuses one that
cites a row that does not exist, a row that is not evidence (a snapshot, or another note), or
evidence of another course than the choice's; an encounter it names must be of the choice's course
and lesson and hold its block. The table checks that a note cites at least one row and that every
cited `seq` is smaller than its own. Notes cite rows, never judgments, so a later regrading leaves
a note pointing at the grading it named. `encounter_evidence` lists the rows of an encounter a
note may cite; `choice_decision_notes` and `encounter_decision_notes` read notes back. The
due-review selector writes them, one per item it brings back (see [due review](../due-review/README.md)).

Delayed review is migration 0006 (RFC 2 §5). `due_review` reads quiz answers, first tries,
exposures and the time each block was last answered, by `seq`, and returns the blocks due with the
rule that chose each and the rows it cites; it writes nothing. `open_lesson_encounter` opens a
lesson with the items chosen at its top, snapshotted with it, and stores their decision notes with
the new encounter in the same transaction. It finds an encounter to resume by the lesson as written
(`encounters.lesson_hash`, or the snapshot's hash when no review was added), so a reload inside the
resume window shows the review it opened with. The rule, the reasons and the page are in
[due review](../due-review/README.md).

Where the learner left off is the port's `lastStudied()`: the course, lesson and time of the latest
encounter opened, answer or explanation stored, or view recorded. It is `school.last_studied()`
from migration 0003, ordered by `seq`. The core's `resumeFrom` (`server/core/school.ts`) turns it
and the courses as served into `GET /api/resume`.

What happened since the learner was last here comes from two more read-only functions in migration
0007 (flyingrobots/school#165). `school.study_days(from, to, tz)` is each course's local study days, in
time zone `tz`, in `[from, to)`; the port's `studyDays`. Since migration 0008
(flyingrobots/school#177) only an answer or a saved explanation makes a study day; an encounter opened
or a view is a visit, and still counts for `last_studied`.
Migration 0009 (flyingrobots/school#181) adds `time_zone_choices`, append-only like every record
table: each time zone the learner chooses in Settings, `NULL` for automatic, the newest by `seq` in
force. `school.choose_time_zone(zone, at)` appends one and `school.time_zone()` reads the zone in
force; the port's `chooseTimeZone` and `timeZone`.
Migration 0010 (RFC 7 §7, flyingrobots/school#232) records installed courses in three more
append-only tables: `course_installs` (each install under the name the learner chose, with its
source, `git` with an `https://` URL or `bundle` with the bundle's SHA-256, its commit, the SHA-256
of its files' manifest, and its title and format), `course_removals`, and `course_trust_choices`
(per install, so an update starts untrusted). `school.install_course(...)` answers `installed`,
`updated` (the name had a current install), `duplicate` or `conflict`;
`school.remove_installed_course(course, at)` answers `removed`, or `not-installed` and stores
nothing; `school.choose_course_trust(install_id, trusted, at)` answers `stored`, or `rejected` for no
such install; `school.installed_courses()` lists each name's latest install with no later removal,
and its latest trust choice (none is untrusted). They are the port's `installCourse`,
`removeInstalledCourse`, `chooseCourseTrust` and `installedCourses`. [The course list](#the-course-list)
serves each current install beside the configured courses.
Migration 0011 (RFC 5 §4.1, flyingrobots/school#217) adds `school.mastery(course, blocks, at, delay_ms)`,
the port's `mastery`: per quiz, its stability and its strength at `at`, read from the record each
time it is asked and never stored. It reads episodes through `school.quiz_episodes`, the same
episodes and weaknesses as due review, which only the record's own functions call. The measure is
in [mastery](../mastery/README.md).
Migration 0013 (RFC 5 §4.5, flyingrobots/school#218) adds
`school.mastery_rollup(course, groups, at, delay_ms)`, the port's `masteryRollup`: per group of quiz
blocks (a lesson, or a whole course), how many are not started, settling, holding and faded, and
their mean strength, from `school.mastery`. It is in [mastery](../mastery/README.md#rolling-up-to-lessons-and-courses).
Migration 0014 (RFC 5 §4.6, flyingrobots/school#219) replaces `due_review`, with its signature and
its three rules unchanged, to add `due-review/faded`: a settled quiz whose strength from
`school.mastery` is below one half, ranked after the weak rules and filling only what they leave of
the limit ([due review](../due-review/README.md#faded-quizzes)).
Migration 0015 (RFC 7 §5.2, flyingrobots/school#237) adds `school.course_progress(course)`, the
port's `courseProgress`: how many encounters were opened under a course name, how many answers and
explanations were given in them, and how many views were recorded under it, whether or not any
course is served under that name now. The [install preview](#previewing-an-install) reads it to say
whether a name already holds progress.
Migration 0016 (RFC 9 §5.5, flyingrobots/school#258) records authoring in three more append-only
tables, before any of RFC 9's routes use them: `authoring_requests` (what the learner asked of a
course, on which install, with the skill's digest and School's version; 1 to 20,000 characters),
`authoring_drafts` (each round of a request, at most two: `ready` or `refused` by the check with the
agent, the draft commit and its digest, or `failed` with no commit; a second round only after a
refused first that has no decision) and `authoring_decisions` (one per draft, `accepted` with its install and patch, or
`discarded`). `school.request_authoring(...)` answers `stored`, `duplicate`, `conflict`, or `refused`
when the base is not the course's current install; `school.record_draft(...)` answers `stored`,
`duplicate`, `conflict`, or `rejected` for no such request or a round out of turn (round 2 only follows a refused round 1 with no decision);
`school.decide_draft(...)` answers `stored`, `duplicate`, `conflict`, or, storing nothing,
`already-decided`, `not-ready` (an accept of a draft that is not `ready`), `stale` (the accepted
install is no longer current) or `rejected` (no such draft, an accept naming another install, or a discard of a draft an install already names); `school.course_authoring(course)` lists a course's
requests with their drafts and decisions. They are the port's `requestAuthoring`, `recordDraft`,
`decideDraft` and `courseAuthoring`. `course_installs` gains the source `authored`, with
`parent_install_id` and `draft_id`; `school.install_course` takes both and answers `stale` when an
authored install's parent is no longer current, or `rejected` when its draft is not an undecided
`ready` draft of a request on that parent whose commit and content digest the install names, and `school.installed_courses()` reports both.
One extension beyond RFC 9 Figure 5.2 stays: a `failed` draft may be discarded, so the 14-day sweep can close it.
`school.latest_feedback()` is the succeeded grading with the highest `seq` and where its explanation
was written; the port's `latestFeedback`. A failed attempt is never feedback.

Conversations about a passage are migration 0017 (RFC 6 §5.2, flyingrobots/school#225), in three
more append-only tables. `conversations` holds one row per passage asked about: the course and
lesson of the encounter it was opened in, the block where the passage begins (any block of the
lesson but the page itself), and the passage, at most 2,000 characters. `questions` holds each
question, at most 4,000 characters, with the encounter it was asked in and `exposure_seq`, its own
`ai-help` exposure of that encounter (`questions_exposure_encounter` holds the two to the same
encounter, and `questions_exposure` gives each exposure to one question). `replies` holds at most
one reply per question (`replies_question`): `succeeded` with the answer, or `failed` with the
reason and whatever text reached the learner, with the sources it quoted, the agent, the model, and
the token counts when the agent reports them.

`school.ask(conversation_id, question_id, encounter_id, block_id, passage, text, at)` is the port's
`ask`. In one transaction it opens the conversation on its first question, records the question's
`ai-help` exposure through `record_lesson_help`, and stores the question, so the exposure's `seq` is
smaller than that of any answer given after it. It answers `stored`; `duplicate` for the same id and
the same question; `conflict` for the same id and another question; or `rejected`, storing nothing,
when the encounter does not exist or does not track aid, when a new conversation has no passage or
its block is not in the encounter's snapshot, or when a later question gives a passage or is asked
in an encounter of another lesson. It serialises per conversation and per question on advisory
locks, so it refuses to run under anything but READ COMMITTED.
`school.record_reply(question_id, status, text, sources, agent, model, usage, error, at)`, the
port's `recordReply`, stores the one reply: `stored`, `duplicate`, `conflict`, or `rejected` for no
such question. `school.lesson_conversations(course, lesson)`, the port's `lessonConversations`,
reads a lesson's conversations in `seq` order, each with its questions in `seq` order and their
replies. Nothing calls them over HTTP yet.

**Figure 3. The learning record's tables**

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
        text lesson_hash "the lesson as written; NULL: the snapshot is"
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
        text block_id "NULL exactly for ai-help: the whole encounter"
        text kind "hint, model-answer, feedback, reference, ai-help"
        timestamptz at
    }
    CONVERSATIONS ||--o{ QUESTIONS : "collects"
    ENCOUNTERS ||--o{ QUESTIONS : "is asked in"
    QUESTIONS ||--|| EXPOSURES : "records, kind ai-help"
    QUESTIONS ||--o| REPLIES : "is answered by"
    CONVERSATIONS {
        bigint seq PK
        uuid conversation_id UK "caller UUID"
        text course
        text lesson
        text block_id "where the passage begins"
        text passage "at most 2,000 characters"
        timestamptz at
    }
    QUESTIONS {
        bigint seq PK
        uuid question_id UK "caller UUID"
        uuid conversation_id FK
        uuid encounter_id FK
        text text "at most 4,000 characters"
        bigint exposure_seq FK "its ai-help exposure, same encounter"
        timestamptz at
    }
    REPLIES {
        bigint seq PK
        uuid question_id FK "unique: one reply per question"
        text status "succeeded or failed"
        text text
        jsonb sources "quoted sources, checked"
        text agent
        text model
        jsonb usage "token counts, when reported"
        text error "set exactly when failed"
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
    COURSE_INSTALLS ||--o{ COURSE_TRUST_CHOICES : "is trusted by"
    COURSE_INSTALLS {
        bigint seq PK
        uuid id UK "caller UUID"
        text course "the name the learner chose"
        text source "git, bundle or authored"
        text url "https, set for git"
        text bundle_sha256 "set for bundle"
        text commit "the draft commit, for authored"
        text content_sha256 "the files' manifest"
        text title
        integer format "NULL when undeclared"
        uuid parent_install_id FK "set for authored"
        uuid draft_id FK "set for authored, once per draft"
        timestamptz at
    }
    COURSE_INSTALLS ||--o{ AUTHORING_REQUESTS : "is the base of"
    AUTHORING_REQUESTS ||--o{ AUTHORING_DRAFTS : "is drafted in"
    AUTHORING_DRAFTS ||--o| AUTHORING_DECISIONS : "is decided by"
    AUTHORING_DRAFTS ||--o| COURSE_INSTALLS : "becomes"
    AUTHORING_REQUESTS {
        bigint seq PK
        uuid id UK "caller UUID"
        text course
        uuid base_install_id FK "the current install when asked"
        text text "1 to 20,000 characters"
        text skill_sha256 "the skill's manifest"
        text school_version
        timestamptz at
    }
    AUTHORING_DRAFTS {
        bigint seq PK
        uuid id UK "caller UUID"
        uuid request_id FK
        integer round "1, or 2 after a refused 1"
        text status "ready, refused or failed"
        text agent "NULL only when failed"
        text commit "set unless failed"
        text content_sha256 "set unless failed"
        text check_message "set exactly when refused"
        integer input_tokens
        integer output_tokens
        timestamptz at
    }
    AUTHORING_DECISIONS {
        bigint seq PK
        uuid id UK "caller UUID"
        uuid draft_id FK "UK: one per draft"
        text decision "accepted or discarded"
        uuid install_id FK "set exactly when accepted"
        text patch "set exactly when accepted"
        timestamptz at
    }
    COURSE_REMOVALS {
        bigint seq PK
        uuid id UK
        text course
        timestamptz at
    }
    COURSE_TRUST_CHOICES {
        bigint seq PK
        uuid id UK
        uuid install_id FK
        boolean trusted
        timestamptz at
    }
```

*Figure 3. The learning record's tables, in schema `school`. Every row takes its `seq` from one
shared sequence, so "before" and "after" across tables compare `seq`, never `at`. `VIEWS` (page
views) and `TIME_ZONE_CHOICES` (the learner's time zone) are omitted. `EXPOSURES` is written by `POST /api/exposure`, which the
lesson page calls for each help it shows, and by `school.ask`, through `record_lesson_help`, for each question about a passage (RFC 6).*

| Rule | How it is enforced | What it does not cover |
| --- | --- | --- |
| Rows are never updated, deleted or truncated | `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers on every table | The owner or the superuser can drop a trigger. Guard rails, not tamper-proofing. |
| The server can only call the public functions | `school_app` has `EXECUTE` on them by name and no table privilege; `EXECUTE` is revoked from `PUBLIC`; the server's record refuses any other statement | A process holding the superuser or owner URL: on Postgres only the migrate job and the backup service do; on PGlite the server's own session is the superuser. A hand grant to `school_app` the login check cannot detect (see [the login check](#the-login-check)) |
| A question is stored with its aid, or not at all | `school.ask` writes the conversation, the `ai-help` exposure and the question in one transaction; `questions_exposure_encounter` holds the exposure to the question's encounter; advisory locks per conversation and question, so a resend at the same moment is a `duplicate` with no second exposure | A direct `INSERT` by the owner |
| A resent submission stores nothing | Unique `answers.submission_id`; `school.submit` answers `duplicate`, or `conflict` for a different answer under the same id | Nothing further |
| `correct` and `first_try` come from the snapshot | `school.submit` derives them from the encounter's stored snapshot; the client's are ignored. A partial unique index allows one first try per block and encounter, even under concurrent answers | A direct `INSERT` by the owner |
| An acknowledged answer survives the server's crash | The 200 is sent after the function's transaction commits; a test kills the server hard and reads the answer back | On PGlite, an operating-system crash or power cut: PGlite writes through to its folder but does not `fsync`, so the last commits may be lost. Real Postgres `fsync`s each commit. Under compose, the `backup` service dumps the record every six hours and keeps 28 dumps, on the same machine ([backup and restore](../../workflows/backup-and-restore/README.md)); an answer since the last dump is not in any dump. |

Every adapter of the record passes one contract suite (`server/contract/learning-record.ts`) and
replays one learner's history (`server/contract/learner-history.ts`). Both run on PGlite in every
test run, and in CI also on a real Postgres server through `Bun.SQL`, the driver the server uses;
CI fails the build if any of the real-Postgres cases skipped or a PGlite case has no `Bun.SQL`
counterpart (`server/testing/postgres-gate.ts`). The conversation tables' storage rules, no
direct access for `school_app` and no update, delete or truncate even by the owner, are checked on
both drivers too (`server/contract/conversation-tables.ts`).

The concurrent cases run against real Postgres too, in the same CI job and under the same gate
(`server/adapters/bunsql.concurrency.test.ts`). Each race is held inside the database: a
controller connection locks the table the function reaches first, the callers start on separate
connections, and the lock is released only once `pg_stat_activity` shows every caller's backend
waiting inside its call, which proves the calls overlapped. Each case runs 50 times:

| Race | Outcome |
| --- | --- |
| Two different first answers to one block | Exactly one is `first_try`; the other is stored as not first |
| 20 answers to one block | One `first_try` among 20 rows |
| The same submission twice | One row; one caller gets `stored`, the other `duplicate`, with the same `correct` and `first_try` |
| One submission id for two different answers | One is stored, the other is a `conflict` |
| Two opens of one lesson and snapshot | One encounter; one caller opened it, the other resumed it |
| Two gradings of one explanation | One chain: the second supersedes the first |
| Two opens of one lesson with review | One encounter, opened by one and resumed by the other, with one set of decision notes |

`school.open_encounter` and `school.record_grading` take an advisory lock and then read what the
previous holder committed, so they need READ COMMITTED, which takes a snapshot per statement.
Under REPEATABLE READ the snapshot predates the lock: two concurrent opens made two encounters
every time. `school.open_lesson_encounter` (migration 0006) works the same way. A function cannot
set its own isolation level, so all three refuse any other level with
`invalid_transaction_state` (migration 0005), and the Bun.SQL adapter begins every request READ
COMMITTED whatever the database's default. `school.submit` needs neither: its partial unique
index decides first try whatever the snapshot saw, and that case also holds under REPEATABLE READ.

An encounter resumes when the learner reopens the same lesson with the same snapshot, it is that
lesson's latest encounter, its aid tracking is unchanged, and its **opening, latest answer or
latest explanation** is within six hours. A grading is not the learner's activity and does not
count.

**Listing 2. The resume rule**

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

*Listing 2. The resume rule, inside `school.open_encounter`. Real source code from
flyingrobots/school, `<server/db/migrations/0001_init.sql#L213-L220@eb70a31>`.*

There is no SQLite record. Its code was deleted with
[flyingrobots/school#49](https://github.com/flyingrobots/school/issues/49); nothing was migrated
from it, because it held no learner data, and startup step 1 checks that this is still so. That
check, `server/legacy.ts`, is the only code that reads SQLite: read-only, through Bun's built-in
`bun:sqlite`, and `server/docker.test.ts` fails if any other module imports it.

The record observes assistance, and the lesson page reports it. RFC 1 requires that a submission
made after a hint or a model-answer reveal is recorded as aided[^rfc1]. The lesson page opens each
lesson with `?aid=1` and posts every exposure it shows (flyingrobots/school#51), so a submission in
an encounter it opened is aided or has no recorded aid. Only an encounter opened without `?aid=`,
by an older client or another tool, reads as unknown aid.

In short: the record derives correctness and first try from what was shown, refuses every update,
delete and truncate, and lets the server do nothing but call its functions. Its guarantees stop at
the owner and the superuser, and aid is known only for encounters a tracking client opened.

## The bridge

Explanations are graded by agent programs the learner already uses, run by the bridge on the host
outside Docker, so their credentials never enter the container the network can reach[^rfc1].

**Figure 4. One grading**

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

*Figure 4. One grading. The explanation is saved before any model is called, and every attempt is
stored whether it succeeds or fails. One gap: a bridge reply that is valid JSON but the wrong shape
throws before the failure is stored ([flyingrobots/school#17](https://github.com/flyingrobots/school/issues/17)).*

| Property | Today |
| --- | --- |
| Agents | Command templates, tried in order; output must match the response schema. One that is missing, cannot be started (its attempt says `could not start <program> (<code>)`), fails or answers off-schema hands over to the next. Declared, commands included, only in the bridge's file on the host. |
| Isolation | No shell, an empty working folder, the process tree killed on timeout and when the bridge is stopped (SIGTERM or SIGINT). A child that leaves the agent's process group (`setsid`) is outside that tree and survives both. This is not filesystem confinement: an agent can do whatever its own command allows. |
| Local or hosted | Agents are launched locally; whether inference is local depends on the agent. A hosted CLI sends the prompt and the explanation over the network. |
| Grading | Fidelity, completeness, accessibility, each `meets`, `partly` or `misses`, or insufficient evidence; quoted contradictions are checked to exist in the source, not to support the criticism |

The bridge also answers a learner's question about a passage, for the server route RFC 6 plans
(flyingrobots/school#227): `POST /ask` takes `{ prompt, deadline_ms }` and answers
`application/x-ndjson`, one `{"type":"delta","text"}` line for each piece of the answer as the
agent writes it, then one `{"type":"end"}` line with `status`, `agent`, `usage` (the token
counts), `error` and every attempt. Its agents are a separate `ask` list in the bridge's file,
`{ "timeout_seconds": 90, "agents": [...] }`, in a queue of their own, so a question never waits
behind a grading. An agent with output `claude-stream-json` (Claude Code's
`--output-format stream-json --include-partial-messages --verbose`) streams; any other answers as
one delta when it exits. The next agent is tried only before the first delta; after it, a failure
ends the reply as failed, so an answer never changes voice partway through. That includes Claude
Code retrying its request after the first delta (an `api_retry` line or a second `message_start`),
which would stream the answer again: the agent is killed and the reply fails; a retry before any
delta is ignored. A caller that hangs up stops the agent, and `agent` in the end line is null
unless the caller received some of that agent's words. After a kill the bridge waits 500 ms for
the agent's pipes to close, then stops reading them, so a child that left the process group cannot
hold the queue. The cases are in the [test plan](test-plan.md#asking-the-bridge-a-question).

Every kill, of a grading agent or a question's, sends SIGKILL to the agent's process group and
sends it again every 50 ms until the pipes close, for at most 500 ms. A child the agent forks just
as the first signal lands can miss it and hold the pipes; a later one ends it, so it cannot hold
either queue. The sweep stops by 500 ms because once the group is empty its number can be reused,
and a kill that lands after the pipes have closed starts no sweep: it ends the agent alone, never
its group. Group numbers 0 and 1 are never swept
(flyingrobots/school#285; the cases are in the [test plan](test-plan.md#killing-an-agent-flyingrobotsschool285)).

The bridge also reads aloud: it hands text the server built to the AI-TTS daemon on the host's
Unix socket, for synthesis only, and serves the audio back for the browser to play
([reading aloud](../reading-aloud/README.md)).

In short: the bridge confines model work to the host and records every outcome, with one known
gap in handling a malformed reply.

### The bridge's output

The bridge writes JSON Lines on stdout: one JSON object per line, each with a `kind` beginning
`bridge.` and the time `at`. No line contains a prompt or an answer.

| `kind` | When |
| --- | --- |
| `bridge.start` | Once at start-up: `host`, `port`, `config`, and the declared agents (null with no file yet) |
| `bridge.listening` | Once it listens: `host` and the `port` it got (the OS's choice for port `0`) |
| `bridge.run.start`, `bridge.attempt`, `bridge.run.end` | Each `POST /run`, its attempts, and its outcome |
| `bridge.ask.start`, `bridge.ask.attempt`, `bridge.ask.end` | Each `POST /ask`, its attempts with how many deltas each passed on, and its outcome with the token counts; never the question or the answer |
| `bridge.test` | Each `POST /test` |
| `bridge.config.saved` | Each accepted `PUT /config` |
| `bridge.speak.submit`, `bridge.speak.cancel` | Each text submitted to AI-TTS, and each cancelled ([reading aloud](../reading-aloud/README.md)); never the text |
| `bridge.speak.failed` | Each `/speak` request AI-TTS could not serve, `unavailable` or `refused`, with a `message` |
| `bridge.error` | Every failure, with a `message` |

A refusal to start is one `bridge.error` line and exit 2: a token under 16 characters, a port that
is not a port, an unreadable configuration file, or a port already in use, whose line also carries
`host`, `port` and `code: "EADDRINUSE"`. Any other uncaught throw or rejection is one `bridge.error`
line with only its message, never a stack, and exit 1. A request handler that throws logs a
`bridge.error` line and answers 500. The cases are in the [test plan](test-plan.md#the-bridges-output).
Output that Bun itself or a native module writes straight to the file descriptors, a hard crash
and a signal kill are outside this: they are not lines. Every line names its published schema in `bridge/schemas/`
and carries the process's `run` id; `--help`, `--schema` and `--human` are in
[the programs' output](../program-output/README.md#the-bridge) (flyingrobots/school#135).

## The web app

`web/` is a stock shadcn/ui app on Vite and React, themed from theme-book through the
`@flyingrobots` registry. The theme is the shadcn preset extended by School's theme book
(`themes/school/school.book.ts` in the registry, `school@1.1.0`), which sets the dark surfaces
lighter than the preset's near-black for long reading, and the dark button fill light enough that
its black label reaches APCA Lc 60 (Lc 63.2); the registry item's description records the exact
command and the book's SHA-256, and the colors pass theme-book's WCAG AAA and APCA audits in light
and dark. A test enforces that its stylesheet holds only stock shadcn tokens, and
another that every component in `web/src/components/ui/` hashes to a fresh `shadcn add`
(`web/test/fixtures/README.md` says how to regenerate the hashes). What
exists: the theme, a light, dark and system toggle, a component sandbox at `/demo`, and
School's pages as far as
[flyingrobots/school#15](https://github.com/flyingrobots/school/issues/15) has built them, among
them the lesson page. The lesson page sends every answer,
explanation and exposure through an outbox in IndexedDB (`web/src/lib/outbox.ts`,
[flyingrobots/school#28](https://github.com/flyingrobots/school/issues/28)): a delivery queue,
never read as progress, emptied only by School's acknowledgement or final refusal, and resent in
order with the original ids, so a submission made offline survives the tab closing. It replaces
the `localStorage` outbox ADR 9 describes, which belonged to the deleted server-rendered pages. The
[lesson page reference](../lesson-page/README.md#the-outbox) has the details.

## Trust and known defects

School is private by network rather than by login. This section states what that trusts, and what
is currently broken.

| School trusts | Consequence |
| --- | --- |
| Everyone who can reach it | No login: anyone on the tailnet or localhost can use the API, including settings |
| Trusted courses (`SCHOOL_COURSES`, `SCHOOL_COURSE`) | Their files render on School's origin with School's authority, which includes the settings API and the bridge that runs the learner's agents. RFC 1 decided installed courses are trusted code. |
| Untrusted courses (`SCHOOL_UNTRUSTED_COURSES`) | Not trusted with School's authority: they are served in safe mode, and their files cannot run script on School's origin (below) |
| Installed courses ([the course list](#the-course-list)) | Untrusted, and served in safe mode, unless the record's latest trust choice for that install trusts them; an update is a new install, so it starts untrusted |
| Configured agents | They run with the learner's account on the host, under their own commands' limits |

An untrusted course is served in safe mode (flyingrobots/school#210, RFC 4 step 2). Its reference files of any type (`/courses/:c/reference/*`) and its course and lesson JSON (`/api/courses/:c`, `/api/courses/:c/lessons/:l`) carry two headers a trusted course's responses do not:

| Header | Effect |
| --- | --- |
| `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'` | `sandbox` with no `allow-*` token, so a document opened from the course, HTML or SVG, runs no script, submits no form and has an opaque origin: it cannot read School's API replies or storage, and cannot send the JSON requests every state-changing endpoint requires. It can still make requests to School that read nothing back, such as a GET from `<img src="/api/...">`. The fetch directives (flyingrobots/school#271) let it load images and stylesheets only from School itself, inline styles, and `data:` images; anything from another site, and every frame, media file, font or connection, is blocked, so opening the document tells no other site What those requests can cause is below the table. |
| `X-Content-Type-Options: nosniff` | The browser takes the bytes as the type School names (`image/svg+xml` for SVG, never HTML), not as a type it guesses |

What a sandboxed document can still cause in School, with no script and no form:

- **GETs, which change nothing except one lesson open.** An `<img>`, a stylesheet link or a link the learner follows makes a GET to any School address, and School answers it, but the document cannot read the reply. Every GET is a read except the lesson in the web view, which opens an encounter. That one answers only School's own `fetch()`, `Sec-Fetch-Site: same-origin` with `Sec-Fetch-Dest: empty` (flyingrobots/school#306). A sandboxed document's requests are `cross-site`, since its origin is opaque, and an image's destination is `image`, so the request is refused (403) and the record gains nothing. The check protects School reached over `localhost` or HTTPS only. Browsers send `Sec-Fetch-*` only to potentially trustworthy origins, so over plain `http://` on another name, such as the phone reaching School by a tailnet name in `SCHOOL_ALLOWED_HOSTS`, the guard sees no headers and answers the request: it is inert there. A browser that sends no fetch metadata at all gets no check either; Chrome and Edge have sent it since 2020, Firefox since 2021 and Safari since 16.4 (2023). The complete fix is to open a lesson with a POST, which the write guard already covers; it is tracked as a follow-up issue. The work of answering a GET, such as reading the record or a lesson file, is still done.
- **A School page the learner opens.** A link the learner follows to one of School's pages, such as `/courses/:c/lessons/:l`, opens that page as a new document on School's origin, outside the sandbox. It then acts as it always does: the lesson page opens the learner's encounter. That encounter is one the learner opened by following the link, as from any other site.
- **Nothing that writes otherwise.** Every other change to the record or settings is a POST or PUT, which needs a JSON body the document cannot send.

Other JSON replies also carry course-written strings without those headers: `/api/showcase`, `/api/resume`, `/api/review`, `/api/feedback` and `/api/activity` hold course and lesson titles, questions, teasers and prompts, and `/api/showcase` holds hook figures. Each mixes several courses, so each item that carries a course's text gives that course's `trusted` (flyingrobots/school#272): every item of `/api/showcase` and `/api/review`, each course of `/api/activity`, the `/api/feedback` reply, and an `/api/resume` reply that names a course. An item whose course is no longer served gives `false`. A JSON reply runs nothing when opened, and the web app shows those strings as React text, never parsed as HTML. `web/test/home-untrusted.test.ts` checks that in Chrome: over an untrusted course whose every string holds the cross-site scripting corpus, each place on the home page that shows one (the hero, a lesson still ahead, the feedback, a question ready for another look and its popover, the timeline and a chosen day, the sidebar) shows every payload as plain text, no payload runs, and nothing on the page could run script. With one of them rendered as HTML instead (tried with a question ready for another look), every case fails and the payloads run.

Lesson blocks take the same path for every course: prose, card, quote and aside HTML goes through the markdown item's sanitiser (Streamdown: `rehype-sanitize` and `rehype-harden`). A hook's SVG figure goes through `safeFigure` (`web/src/lib/figure.ts`), which keeps only drawing: it drops script, embedded documents, links, animation, `style` elements, the raw-text elements a reparse could turn into markup (`noscript`, `noembed`, `noframes`, `xmp`, `plaintext`, `textarea`), every element outside the SVG namespace, event handlers, `href`s, and the `style` and `class` attributes. A trusted course's figure is then drawn inline. An untrusted course's figure is drawn as an `<img src="data:image/svg+xml,…">`, where nothing runs whatever it holds, with each `var(--token)` replaced by the theme's current value. `/api/showcase` gives each item's `trusted` for this.

`web/test/sanitise.test.tsx` runs 35 cross-site-scripting payloads through each block kind and 13 hostile figures through `safeFigure` (6 mutation-XSS payloads and a page overlay among them), and finds no script, handler, script URL, raw-text element or `style` left. For the mutation-XSS payloads the evidence is that no raw-text element survives: happy-dom never runs an `<img onerror>`, so no callback firing there proves nothing. The payloads were also checked by hand in Chrome, where nothing fired. The course page shows a note that the course is in safe mode ([the course page](../course-page/README.md)).

A course is trusted or untrusted, never both: the server refuses to start (exit 2) when a name is in `SCHOOL_COURSES` or `SCHOOL_COURSE` and in `SCHOOL_UNTRUSTED_COURSES`, or when an untrusted course's folder is, contains or sits inside a trusted course's, since the trusted course would serve the same bytes unsandboxed. It refuses in the same way a `SCHOOL_MOUNTS` or `SCHOOL_WEB` folder that is, contains or sits inside an untrusted course's folder, compared on real paths, naming both variables and both folders: mounts and the web app are never sandboxed.

Realpath cannot see a bind mount. Compose mounts `SCHOOL_COURSE_DIR` at `/course`, which is trusted, and, unless `SCHOOL_LIBRARY_DIR` is set, at `/library` as well, so `/library` is the trusted course under a second name. Every check above is therefore also made by filesystem identity, the `(st_dev, st_ino)` pair stat gives. For each untrusted course folder and each trusted root (a trusted course, a mount, the web folder), School collects the identity of the folder and of every ancestor that exists. It refuses at start (exit 2) when either folder's identity is among the other's, saying the two are the same folder under two names or that one holds the other, and naming both variables and folders. With compose's defaults, `SCHOOL_UNTRUSTED_COURSES=guest=/library` is refused; set `SCHOOL_LIBRARY_DIR` to a folder that does not hold the course. Inodes are read as exact integers (`bigint`), so none is rounded.

Part of a trusted folder mounted elsewhere is caught too (flyingrobots/school#298). At a bind mount's root, `..` leads into the container's tree, not the tree the folder came from, so the ancestors alone cannot show that `/library` is a trusted course's `reference/`. When `SCHOOL_UNTRUSTED_COURSES` is set, School therefore walks every folder and regular file below each trusted course, mount and the web folder at start, never following a symlink, and refuses (exit 2) an untrusted course whose folder or any ancestor has the identity of one of them. The refusal names the untrusted folder, the trusted root and the folder inside it. Symlinks are not followed because the server never serves through a symlink that leaves the folder it serves.

Part of an untrusted course mounted inside a trusted folder is caught as well (flyingrobots/school#315). School walks each untrusted course the same way, folders and regular files, and refuses (exit 2) when anything below it has the identity of anything below a trusted course, a mount or the web folder: one of its files or subfolders bind-mounted into a trusted folder, one of theirs bind-mounted into it, or a file hard-linked into both. The refusal names the untrusted course and its entry, and the trusted root and its entry. Two names for one file inside one course, or in two untrusted courses, keep one trust and are accepted. An entry School cannot list or stat is refused, naming it, rather than skipped, since what it hides could be such an alias.

A course, mount or web folder holding more than 10,000 folders (the folder cap, as before files were walked) or more than 100,000 regular files (the file cap, counted apart) is refused, naming it and the cap it passed, rather than walked; the message says how to start (unset `SCHOOL_UNTRUSTED_COURSES`, point the variable at a folder holding fewer, or remove the untrusted course). A listed file is read with lstat, so a file swapped for a symlink after the walk listed it is read as the link and never followed. A course holds far fewer entries than either cap, and the walk stays quick. Measured on a Mac with an SSD, median of 30 starts after warm-up, on a quiet machine: 2.0 ms for a trusted course of 2,000 reference files in 100 folders when only folders were walked, 4.8 ms now that its files are read too, and 10 ms when the untrusted course also holds 2,000 files; one stat costs about 1.4 µs, so each 2,000-file course adds about 3 ms. At the file cap, a trusted course of 100,000 files in 1,000 folders took a median of 0.5 s over 10 starts, measured under heavy load (load average above 40). With no untrusted course, nothing is walked.

The identity check misses one case: a mount made after School started, since the walk runs only at start. Compose's defaults create none. Never bind-mount anything into a course, a mount or the web folder while School runs.

### Fetching a course repository

`fetchCommit` (`server/fetch-commit.ts`, RFC 7 §6) fetches one commit of a course repository into a new bare repository, `<staging>/repo.git`, and answers the commit's full hash. The [install preview](#previewing-an-install) calls it with a staging folder under the course store. The URL and the server are hostile, so School checks the commit, then the URL, then the host's addresses, then the staging folder, and only then runs git. Table 2 lists the rules in that order, and the first rule broken gives the refusal. Any refusal deletes the staging folder, or never makes it.

| Rule | Refused with |
| --- | --- |
| The commit is a full hash (40 or 64 hex digits), or a branch, tag or `HEAD` that is safe to hand to git (no option, range, space, trailing slash or `.lock` name) | `bad-commit` |
| The URL is 2,048 characters at most | `bad-url` |
| The URL starts `https://`. `http`, `ssh`, scp-like `host:path`, `git://`, `file://`, `ext::`, a local path or an option is refused before git runs, and git's `protocol.allow=never` allows only `https`, even if something rewrites the URL later | `not-https` |
| No whitespace, control character or backslash, no query or fragment, and a host | `bad-url` |
| No user or password (`https://user:token@...`): School stores no secret for a course | `credentials` |
| Port 443 | `bad-port` |
| The host is an IP address or a plain host name: letters, digits and hyphens in dot-separated labels of 1 to 63 characters, none starting or ending with a hyphen, 253 characters in all. One trailing dot names the same host and is dropped from the URL, the lookup and the pin alike | `bad-url` |
| The host resolves, and every address is public. `isPublicAddress` refuses the IANA special-purpose IPv4 ranges (loopback, private, CGNAT `100.64/10`, link-local with the cloud metadata address, multicast, reserved, documentation), and allows IPv6 only in global unicast `2000::/3` outside `2001::/23`, `2001:db8::/32`, `2002::/16` and `3fff::/20`, so IPv4-mapped, NAT64, loopback, unique-local and link-local IPv6 are refused. A literal address is checked as given | `unresolved`, `private-address` |
| The staging folder is an absolute path, its parent exists, and the folder does not | `bad-staging` |
| A branch, tag or `HEAD` is resolved once, with `git ls-remote`, to a full hash (an annotated tag to the commit it tags). A name that is both a branch and a tag is refused. A full hash is fetched as given | `no-such-ref`, `ambiguous-ref` |
| Each git process finishes within 60 seconds. The fetched repository stays within 64 MiB on disk: School measures it every 100 ms while git runs and again when git ends (RFC 7 Table 6.2). Passing either limit kills git's whole process group | `timeout`, `too-large` |
| git fetches the commit, and the object is a commit, not a tree or blob | `git-failed`, `not-a-commit` |

_Table 2. What `fetchCommit` checks, in the order the code checks it. Every refusal carries a sentence naming what was refused._

git is pinned to the addresses School checked. `http.curloptResolve=HOST:443:ADDRESS[,ADDRESS]` hands them to libcurl, so git never looks the host up again, and a second answer from DNS (rebinding) is never used. Only a plain host name can be pinned this way: libcurl reads a name starting with `-` as "remove this entry", so Table 2 refuses such a name before any lookup. Redirects are not followed (`http.followRedirects=false`), because a redirect could lead to a host or port the pin does not cover. git runs with a fresh environment: no system or global configuration, `HOME` set to the staging folder (so no `.netrc`), `GIT_TERMINAL_PROMPT=0`, no askpass, an empty `credential.helper`, an empty `http.proxy` (which also overrides a proxy in the environment), `core.hooksPath=/dev/null`, `transfer.fsckObjects`, no submodules, and `git init --bare --template=`. The bare repository is made first. Every later git command, `ls-remote` included, names that repository with `--git-dir` and starts in it, and `GIT_CEILING_DIRECTORIES` stops git looking above the staging folder. So a git repository around the course store adds no configuration, such as a header, a URL rewrite or a proxy. The fetch is `git fetch --depth=1 --no-tags --no-recurse-submodules <url> <hash>`, so the repository holds that one commit and nothing is checked out. `refs/heads/course` then points at the commit, so nothing prunes it before it is read. When git exits, School kills its process group, so no helper it started outlives it. A host that will not serve a commit by its hash fails as `git-failed`, with git's own message.

The request names only the URL, the commit and the staging folder. The git program, the network (resolver, address check, ports, CA file) and the limits are a separate second argument, `FetchTesting`. Only tests pass it, to reach a local server, and no route may build it from a client's input.

### Previewing an install

`POST /api/installs/preview` (`server/install-preview.ts`, RFC 7 §4, task 7) is the first half of installing a course from a repository: it shows the learner what a commit holds before anything is installed. Its body is exactly `{"url": ..., "commit": ...}`, two strings; any other field is refused (400), so nothing in a request can reach `FetchTesting`, which the route never passes. Like every `POST /api/*` it needs a JSON body and an allowed `Host`, and it is also refused (403) when `Sec-Fetch-Site` is present and is anything but `same-origin`, so only School's own pages can make School fetch a URL (RFC 7 §8); that answer is `{"status": "forbidden", "error": ...}`. If the store or the record fails rather than the course being refused, it answers 500 `{"status": "failed", "error": ...}` without the cause, which goes to School's log, and the preview's folder is deleted. The sweep never runs on a `staging/` that is not a real folder (a symlink, say). Without a [course store](#configuration) it answers 503: `Installing courses needs a course store. It is set with SCHOOL_COURSE_STORE, described in Configuration.`

The preview works in a new folder, `<SCHOOL_COURSE_STORE>/staging/<preview id>/`:

1. `fetchCommit` fetches the commit into `repo.git` ([fetching a course repository](#fetching-a-course-repository)).
2. `extractCommit` (`server/extract-tree.ts`, RFC 7 task 5) reads that commit's tree and writes only `course.json`, `lessons/*.json` and `reference/**` into `course/`, refusing symlinks, submodules, LFS pointers, unsafe or colliding names and anything over RFC 7 Table 6.2's limits. `repo.git` is then deleted.
3. `checkCourse` (`server/check-course.ts`) loads `course/` as `school check` does.

A refusal at any stage deletes the preview's folder and answers 422. This one is the example course (`.agents/skills/school/example`) with its first quiz given no correct choice, as PREVIEW-4 checks it:

```json
{ "status": "refused", "stage": "check", "reason": "invalid", "path": "0001-places-worth-twice.json",
  "message": "0001-places-worth-twice.json > places-worth-twice > places-practice > places-q-worth: exactly one choice must be correct" }
```

`stage` is `fetch`, `extract` or `check`. `reason` is the fetch's reason (Table 2), the extraction's (`unsafe-name`, `case-collision`, `symlink`, `submodule`, `lfs-pointer`, `too-many-files`, `file-too-large`, `total-too-large`, `path-too-long`, `too-deep`, `not-a-commit`, `bad-destination`, `timeout`, `git-failed`), or `invalid` for the check. `path` is the tree path or course file it concerns, or null. `message` is the stage's own sentence, git's error output included for `git-failed`, with any path inside the store made relative to the course. It is text from the server and from git, and a client shows it as text, never as HTML.

A course that passes answers 200. This is the example course as PREVIEW-1 and PREVIEW-12 check it, with progress already under its name; the URL is illustrative, and the preview id and hash are shortened:

```json
{ "status": "ok", "preview": "6f1c…", "expires": "2026-11-26T11:00:00.000Z",
  "url": "https://github.com/flyingrobots/counting-in-binary.git", "commit": "3a9e…",
  "course": { "title": "Counting in Binary", "summary": "How two symbols are enough to count anything, and how to read a binary number.",
              "author": "The School maintainers", "license": "Apache-2.0", "format": 1,
              "lessons": [
                { "file": "0001-places-worth-twice.json", "id": "places-worth-twice", "title": "Places worth twice", "quizzes": 2, "explains": 1 },
                { "file": "0002-adding-with-carries.json", "id": "adding-with-carries", "title": "Adding with carries", "quizzes": 2, "explains": 1 }],
              "quizzes": 3, "explains": 2 },
  "name": { "suggested": "counting-in-binary", "taken": null,
            "progress": { "encounters": 1, "answers": 1, "explanations": 0, "views": 0 } } }
```

Each lesson's `quizzes` counts the quizzes it shows; the course's `quizzes` counts distinct quizzes, so one lesson reusing another's quiz through `ref` adds none.

`commit` is always the full hash, a branch or tag resolved once. `name.suggested` follows RFC 7 §5.2: the URL's last path segment, percent-decoded and without `.git`, lowercased, with each run of other characters made one hyphen and none at either end. When that is empty or a name School's routes reserve, the course's title is used the same way, and failing both, `course`. `name.taken` is `configured` when a configured course has the name, `installed` when a current install has it (`school.installed_courses()`), and otherwise null. `name.progress` is what the record already holds under the name (`school.course_progress`, [the learning record](#the-learning-record)), or null when it holds nothing; a course removed earlier, or one that was configured before, keeps its progress under its name.

The preview reads the record and writes nothing to it, and writes nothing in the store outside `staging/`. A good preview stays in its folder as `course/` alone, for [the install](#installing-a-previewed-course) to move into `courses/`. What the install needs to know about it is kept in the server process's memory, by preview id, and never written to the store: the URL, the full commit, when it expires, and the [content digest](../course-format/README.md#an-installed-courses-folder) of `course/`, taken just after the check and before the preview reads the record. So nothing that can write the store can change which URL and commit an install records, or which digest it compares. A preview is deleted from the store and from memory once it expires, an hour after it was made: by a sweep School runs every ten minutes and before each new preview. A folder in `staging/` the server does not remember, from a preview still running, one cut short, or anything else put there, is deleted an hour after it last changed; no file in it is read. Every preview is deleted when School starts, and the memory starts empty, so no preview outlives a restart.

### Installing a previewed course

`POST /api/installs` (`server/install-course.ts`, RFC 7 §4 stages 4 and 5, task 8) installs a preview under the name the learner chose. Its body is exactly `{"preview": ..., "name": ...}`: the id a preview answered, a lowercase UUID, and a name of at most 255 characters; anything else is 400. It has the same guards as the preview: a JSON body, an allowed `Host`, and 403 for a `Sec-Fetch-Site` other than `same-origin`. One install runs at a time, so two installs of one preview, or under one name, never race.

1. **The name.** It must pass the course-name rule (lowercase letters, digits and hyphens, starting with a letter or digit, and none of `assets`, `courses`, `lessons`, `reference`, `api`), or it is `bad-name`. A name a configured course or a current install already has is `name-taken`. Either way the preview is kept, so the learner can choose another name.
2. **The preview, as this server made it.** The id must be one this server process staged and still remembers, or it is `unknown-preview`: an id School never staged, a preview already installed, one from before a restart, or a folder another process put in `staging/`. A preview past its expiry is `expired`, and is deleted and forgotten. `staging/`, the preview's folder and its `course/` must be real folders, checked with `lstat`; a symlink there is not followed, and the answer is `unknown-preview`.
3. **The move.** The preview is forgotten, so it is spent, and `course/` is renamed to `courses/<install id>/`, a new UUID, and the rest of the preview deleted. A `courses/` that is not a real folder, or an install id that already has a folder, is a failure (500) and nothing is moved. After the rename, `courses/<install id>` must be a real folder by `lstat`: a `course/` swapped for a symlink after step 2 is moved as the symlink, which is removed without being followed, and the answer is `changed`.
4. **The check, where the folder now lies.** It may hold only `course.json`, `lessons/*.json` and `reference/**`, as folders and regular files with one link each, or it is `changed`: no symlink, and no hard link to a file elsewhere, whose mode the next step would change. Its sizes, read with `lstat` before any file is, must be within RFC 7 Table 6.2's limits, or it is `over-limit`; its content digest must be the one the server remembered, or it is `changed`; and `checkCourse` must pass it, or it is `invalid-course`. So a file changed, added, symlinked or hard-linked in staging before this check is never installed.
5. **The record.** Every file is made read-only (the folders stay writable, so the start sweep can delete them), then `school.install_course` records the install with `source: "git"`, the URL and commit the server remembered, the digest, and the title and format `checkCourse` read (the name when the course declares no title). No trust choice names it, so it is untrusted.

These steps hold against anything that changes `staging/` before each step runs. They are not a lock, and they do not make the store safe from a process that can write it (the same user, or a shared volume). Such a process can still:

- change a file in `courses/<install id>/` between step 4's check and the record, or at any time after; the install is recorded with the digest step 4 computed, and [the course list](#the-course-list) finds the change by its fingerprint and does not serve the folder unless its digest is still the record's;
- swap a folder inside `courses/<install id>/` for a symlink between step 4 and step 5, which step 5 follows, making the files it leads to read-only (step 5 opens each file without following a symlink and fails on a file with more than one link, but Node cannot open a folder relative to its parent, so it cannot refuse a swapped folder);
- replace `courses/` or `staging/` themselves, or delete any install's folder.

What it cannot do is make School record a URL or commit the preview did not fetch, compare against a digest the preview did not take, or install a preview this server did not make.

Any refusal or failure after the move deletes the moved folder. A record that fails after it committed the row (a connection lost before the answer) leaves an install whose folder is gone, which the course list shows as not served, with its reason. Its name is then taken, so installing the course again under it is refused until that install is removed, which no route does yet (RFC 7 task 12). A record that answers anything but `installed`, `updated` or `duplicate` is `not-recorded`. [The course list](#the-course-list) serves an install only once `installed_courses()` names it, so the folder is never served before it is recorded, and a crash between the move and the record leaves a folder that the next start deletes. A good install answers 201; the course is then served at `/api/courses/<name>` and `/courses/<name>/reference/...` in safe mode. This is the answer INSTALL-1 checks, with the URL illustrative and the ids and hash shortened:

```json
{ "status": "installed", "install": "9b2e…", "course": "binary",
  "url": "https://github.com/flyingrobots/counting-in-binary.git", "commit": "3a9e…", "trusted": false }
```

A refusal names its reason and says what happened in a sentence for a person, for example `name-taken`: `a configured course is already called "own"; would another name suit this one?`. The install does not ask whether to continue progress already under the name, which the preview reports; the learner's choice of name is that answer.

| Defect | Effect | Issue |
| --- | --- | --- |
| Bridge reply shape not validated | A malformed reply throws and stores no failed grading | [#17](https://github.com/flyingrobots/school/issues/17) |
| Explanations ignored by resume | An explanation does not keep its encounter open | [#19](https://github.com/flyingrobots/school/issues/19) |
| Phone over the tailnet | Never verified end to end | [#3](https://github.com/flyingrobots/school/issues/3) |

## Configuration

| Variable | Program | Meaning | Default |
| --- | --- | --- | --- |
| `SCHOOL_COURSES` | Server | `name=path` pairs, one per course | none |
| `SCHOOL_UNTRUSTED_COURSES` | Server | `name=path` pairs, one per course served in safe mode: its files are sandboxed ([trust](#trust-and-known-defects)). A name or folder also trusted is refused, and so is a course sharing a file or folder with a trusted one by device and inode; one holding more than 10,000 folders or 100,000 files is refused rather than walked | none |
| `SCHOOL_COURSE` | Server | One unnamed course, named after its folder | none; `/course` under compose, set there by `SCHOOL_COMPOSE_COURSE`, which may be empty |
| `SCHOOL_STATE` | Server | Learner state; must not be inside a course | `state/` |
| `SCHOOL_COURSE_STORE` | Server | The course store (RFC 7 §5.1): the folder installed courses live in, and nothing else. School serves each current install from `courses/<install id>/` in it ([the course list](#the-course-list)); [Install previews](#previewing-an-install) are staged in its `staging/`, which start empties, and [an install](#installing-a-previewed-course) moves one into `courses/`; start deletes every folder in `courses/` that is no current install's. Empty means no store, so installing is off and a preview or an install is a 503. Refused at start (exit 2, naming both paths) when it is, holds or sits inside a course, `SCHOOL_STATE`, `DB_PATH`, a PGlite record, a mount, `SCHOOL_WEB` or the framework folder (`SCHOOL_ROOT`, which holds the server source), and when the path exists but is not a folder, compared on real paths and by device and inode, as for [untrusted courses](#trust-and-known-defects) | none; `/store` under compose, the named volume `course-store`; compose reads it from `SCHOOL_COMPOSE_COURSE_STORE`, so a host export of `SCHOOL_COURSE_STORE` never reaches the container |
| `SCHOOL_SKILL` | Server | The `school` skill an authoring agent is given ([the pinned skill](#the-pinned-skill)). Empty means none, so authoring is off. Never a refusal to start: a missing or unfit folder turns authoring off with the reason | `<SCHOOL_ROOT>/.agents/skills/school`; `/framework/skills/school` under compose, the checkout's skill mounted read-only; compose reads it from `SCHOOL_COMPOSE_SKILL`, so a host export of `SCHOOL_SKILL` never reaches the container |
| `SCHOOL_SKILL_DOCS` | Server | The folder holding the references the skill links, `course-format/` and `voice/` | `<SCHOOL_ROOT>/docs/topics`; `/framework/docs` under compose, set there with no variable |
| `SCHOOL_SKILL` | Server | The `school` skill an authoring agent is given ([the pinned skill](#the-pinned-skill)). Empty means none, so authoring is off. Never a refusal to start: a missing or unfit folder turns authoring off with the reason | `<SCHOOL_ROOT>/.agents/skills/school`; `/framework/skills/school` under compose, the checkout's skill mounted read-only; compose reads it from `SCHOOL_COMPOSE_SKILL`, so a host export of `SCHOOL_SKILL` never reaches the container || `SCHOOL_DATABASE_URL` | Server | The record: `postgres://school_app:password@host:port/db` (`Bun.SQL`; `school_app`'s own login, refused if it fails [the login check](#the-login-check)) or `pglite:<dir>` (PGlite on disk, not inside a course) | none: required |
| `SCHOOL_DATABASE_PASSWORD`, `SCHOOL_DATABASE_PASSWORD_FILE` | Server | `school_app`'s password, for a `SCHOOL_DATABASE_URL` that names none; the file wins. Compose gives the file | none |
| `SCHOOL_MIGRATE_URL` | Migrate job | The owner's URL: a role that can create roles, in practice the superuser | none: required |
| `SCHOOL_MIGRATE_PASSWORD`, `SCHOOL_MIGRATE_PASSWORD_FILE` | Migrate job | The owner's password, for a `SCHOOL_MIGRATE_URL` that names none; the file wins. Compose gives the file | none |
| `SCHOOL_APP_PASSWORD`, `SCHOOL_APP_PASSWORD_FILE` | Migrate job | The password the job gives `school_app`, at least 20 letters and digits; the same one the server logs in with. The file wins | none: required |
| `DB_PATH` | Server | The old SQLite record, only read: startup refuses while it holds learner work | `<SCHOOL_STATE>/progress.db` |
| `SCHOOL_MOUNTS` | Server | `name=path` pairs served read-only, never sandboxed; one over an untrusted course's folder is refused; with `SCHOOL_UNTRUSTED_COURSES` set, a mount holding more than 10,000 folders or 100,000 files is refused rather than walked | none |
| `SCHOOL_WEB` | Server | The built web app; a folder over an untrusted course's is refused; with `SCHOOL_UNTRUSTED_COURSES` set, a folder holding more than 10,000 folders or 100,000 files is refused rather than walked | `web/dist` |
| `HOST`, `PORT` | Server | Listen address | `127.0.0.1:4747` |
| `SCHOOL_TEST_CLOCK` | Server | For tests only: an instant with a zone (`2026-01-03T10:00:00Z`) the server reads as now for everything it records and measures, with a warning at startup. Refused (exit 2) unless `SCHOOL_DATABASE_URL` is `pglite:`, or when it is not an instant | none: the system clock |
| `SCHOOL_ALLOWED_HOSTS` | Server | Host names answered besides `127.0.0.1`, `localhost`, `::1` and `HOST`, comma-separated; the tailnet name | none |
| `SCHOOL_BRIDGE_URL`, `SCHOOL_BRIDGE_TOKEN` | Server | Override the saved bridge settings; `SCHOOL_BRIDGE_TOKEN_FILE`, which compose gives, wins over the token | none |
| `SCHOOL_BACKUP_INTERVAL_SECONDS` | `backup` service | Seconds between dumps; the first is taken at start | `21600` |
| `SCHOOL_BACKUP_KEEP` | `backup` service | Dumps kept; older ones are deleted after each good dump | `28` |
| `PGPASSWORD_FILE` | `backup` service | The superuser's password as a file, read into `PGPASSWORD`; wins over it | none |
| `SCHOOL_BRIDGE_TOKEN` | Bridge | Shared secret, 16 characters or more; when unset, read from the Keychain | the Keychain item `./school up` stores |
| `SCHOOL_KEYCHAIN_ACCOUNT` | Launcher, bridge | The Keychain account School's secrets are under | `school` |
| `SCHOOL_POSTGRES_PASSWORD`, `SCHOOL_APP_PASSWORD`, `SCHOOL_BRIDGE_TOKEN` | Launcher (`./school`) | Each, when set, used instead of the Keychain and never stored | the Keychain |
| `SCHOOL_BRIDGE_CONFIG` | Bridge | Agents file, re-read per request | `~/.config/school/bridge.json` |
| `SCHOOL_BRIDGE_HOST`, `SCHOOL_BRIDGE_PORT` | Bridge | Listen address; port `0` lets the OS choose, reported in the `bridge.listening` log line | `127.0.0.1:4748` |

[^adr2]: flyingrobots/school, `docs/adr/0002-typescript-on-bun.md` at `a959505`.
[^adr6]: flyingrobots/school, `docs/adr/0006-separate-framework-lessons-and-learner-state.md` at `a959505`.
[^adr9]: flyingrobots/school, `docs/adr/0009-the-learning-record-is-enforced-by-the-database.md` at `a959505`.
[^rfc1]: flyingrobots/school, `docs/rfc/0001-school.md` at `a959505`.
[^rfc3]: flyingrobots/school, `docs/rfc/0003-postgres-functions-and-generated-types.md` at `eb70a31`.
