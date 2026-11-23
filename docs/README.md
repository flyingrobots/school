# School documentation

Start here. Each page has one job; this page routes to all of them.

| Page | Job |
| --- | --- |
| [Glossary](glossary.md) | The vocabulary. The authority on every term. Read it first. |
| [Architecture](topics/architecture/README.md) | Reference: how School is built today, on the default branch. |
| [App shell](topics/app-shell/README.md) | Reference: the web app's routes, keys, theme switch and layout. |
| [Home page](topics/home-page/README.md) | Reference: what Home shows first (the lesson to study now), the courses with their progress in words, and the page's states. |
| [Settings page](topics/settings-page/README.md) | Reference: what `/settings` shows and does, state by state. |
| [Course page](topics/course-page/README.md) | Reference: a course's lessons, the learner's progress in words, and the page's states. |
| [Reference page](topics/reference-page/README.md) | Reference: a course's reference documents, how each opens, and the page's states. |
| [Lesson page](topics/lesson-page/README.md) | Reference: what the lesson page shows, records and reloads. |
| [Back up and restore](workflows/backup-and-restore/README.md) | How-to: check the scheduled `pg_dump` backups, drill a restore, and restore the record for real. |
| [Upgrade a compose deployment](workflows/upgrade/README.md) | How-to: take a new version into a running deployment, including the first upgrade to the migrate job and `SCHOOL_APP_PASSWORD`, and what each failure means. |
| [Due review](topics/due-review/README.md) | Reference: which quizzes come back for delayed review, why, and where they are shown; with its [test plan](topics/due-review/test-plan.md). |
| [Working notes](working-notes.md) | How-to notes for anyone changing the framework. |
| [RFC 1: School](rfc/0001-school.md) | The original design and the learning record contract. Draft. |
| [RFC 2: Lessons written for each learner](rfc/0002-lessons-written-for-each-learner.md) | Proposal: courses as curricula, lessons and quizzes prepared per learner, exams, completion. Draft. |
| [RFC 3: Postgres functions and generated types](rfc/0003-postgres-functions-and-generated-types.md) | Decided, in progress: the server as a hexagon, the record in Postgres functions, PGlite in tests, types from Wesley. Draft. |
| [RFC 4: Publishing courses](rfc/0004-publishing-courses.md) | Proposal: a public index of course repositories and a static catalog built from it; School stays private. Awaiting the maintainer's decision. |
| [ADRs](adr/) | The decisions, in order, with what each cost. |

Living pages describe only what exists on the default branch. Proposals live in RFCs until they
are built.
