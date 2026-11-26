# School documentation

Start here. Each page has one job; this page routes to all of them.

| Page | Job |
| --- | --- |
| [Glossary](glossary.md) | The vocabulary. The authority on every term. Read it first. |
| [Architecture](topics/architecture/README.md) | Reference: how School is built today, on the default branch; with its [test plan](topics/architecture/test-plan.md) for the bridge's output. |
| [App shell](topics/app-shell/README.md) | Reference: the web app's routes, keys, theme switch and layout. |
| [Home page](topics/home-page/README.md) | Reference: what Home shows: a question from a course still ahead, the lessons still ahead with their pictures, and what happened since the learner was last here; and the page's states. |
| [Settings page](topics/settings-page/README.md) | Reference: what `/settings` shows and does, state by state. |
| [A course's folder](topics/course-format/README.md) | Reference: what School reads from a course's folder (`course.json` and its title, `lessons/`, `reference/`) and [the blocks a lesson is written in](topics/course-format/blocks.md), `school check`, which says whether School would serve one, and the `school` skill that writes one; with its [test plan](topics/course-format/test-plan.md). |
| [Course page](topics/course-page/README.md) | Reference: a course's lessons, the learner's progress in words, and the page's states. |
| [Reference page](topics/reference-page/README.md) | Reference: a course's reference documents, how each opens, and the page's states. |
| [Lesson page](topics/lesson-page/README.md) | Reference: what the lesson page shows, records and reloads. |
| [Back up and restore](workflows/backup-and-restore/README.md) | How-to: check the scheduled `pg_dump` backups, drill a restore, and restore the record for real. |
| [School's secrets](topics/secrets/README.md) | Reference: the three secrets in the macOS Keychain, `./school up`, and how each reaches its process as a compose secret file; with its [test plan](topics/secrets/test-plan.md). |
| [Upgrade a compose deployment](workflows/upgrade/README.md) | How-to: take a new version into a running deployment, including the first upgrades to the migrate job and to the Keychain (`./school import`), and what each failure means. |
| [The migrate job's output](topics/migrate-job/README.md) | Reference: what `server/migrate.ts` prints, its message types and schemas, `--help`, `--schema` and `--human`, and what the contract cannot cover; with its [test plan](topics/migrate-job/test-plan.md). |
| [The programs' output](topics/program-output/README.md) | Reference: what the backup job, the Postgres gate and the bridge print, their message types and schemas, `--help`, `--schema` and `--human`, and what the contract cannot cover; with its [test plan](topics/program-output/test-plan.md). |
| [Due review](topics/due-review/README.md) | Reference: which quizzes come back for delayed review, why, and where they are shown; with its [test plan](topics/due-review/test-plan.md). |
| [Reading aloud](topics/reading-aloud/README.md) | Reference: how School reads a lesson or the latest feedback aloud through AI-TTS, what it never says, the playback bar and its keys; with its [test plan](topics/reading-aloud/test-plan.md). |
| [School's voice](topics/voice/README.md) | Reference: how School speaks to the learner, in the app and in course prompts: encouraging or neutral, inviting rather than commanding. |
| [Working notes](working-notes.md) | How-to notes for anyone changing the framework. |
| [RFC 1: School](rfc/0001-school.md) | The original design and the learning record contract. Draft. |
| [RFC 2: Lessons written for each learner](rfc/0002-lessons-written-for-each-learner.md) | Proposal: courses as curricula, lessons and quizzes prepared per learner, exams, completion. Draft. |
| [RFC 3: Postgres functions and generated types](rfc/0003-postgres-functions-and-generated-types.md) | Decided, in progress: the server as a hexagon, the record in Postgres functions, PGlite in tests, types from Wesley. Draft. |
| [RFC 4: Publishing courses](rfc/0004-publishing-courses.md) | Proposal: a public index of course repositories and a static catalog built from it; School stays private. Awaiting the maintainer's decision. |
| [RFC 5: Mastery that fades](rfc/0005-mastery-that-fades.md) | Proposal: a per-quiz mastery measure with a growing half-life, derived by a database function, and one added due-review rule for quizzes that have faded. Awaiting the maintainer's decision. |
| [ADRs](adr/) | The decisions, in order, with what each cost. |

Living pages describe only what exists on the default branch. Proposals live in RFCs until they
are built.
