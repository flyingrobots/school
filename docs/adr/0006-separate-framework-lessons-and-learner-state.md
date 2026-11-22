# 6. Separate the framework, the lessons and the learner's state

Date: 2026-11-21 · Status: Accepted

> **Amended 2026-11-21.** Written before the [glossary](../glossary.md) and before [ADR 8](0008-the-school-skill-and-who-invokes-whom.md). Two corrections apply. "Lesson course" is now **course**. And this ADR implied that a course ships prewritten lessons; it does not — a course declares lessons, and the page a learner reads is a **lesson rendering**, prepared per learner and held in learner state. The three-layer split is unchanged.

## Context
School was built while teaching one course, the AIΩN Foundations Series, and that course leaked into the software. `server/server.ts` hardcodes an `aion` mount and defaults `AION_ROOT` to a sibling checkout; ADR 5 fixes `/aion` as one of exactly four served URL prefixes; `MISSION.md`, `RESOURCES.md`, `learning-records/` and `lessons/` all describe that one subject; and `progress/progress.db` sits in the same tree as everything else.

The course was a test case for building the framework, not the purpose of it. A second course cannot be added today without editing the server.

The three things involved have different audiences, different histories and opposite privacy needs:

| Layer | Who it is for | Visibility | Whose history |
| --- | --- | --- | --- |
| The framework | anyone running School | public | this repository |
| A course | anyone studying or teaching that subject | shareable, public by default | its own repository |
| Learner state | one learner | private | not shared at all |

Lessons are worth sharing and worth versioning in their own right. A course that teaches AIΩN from zero is useful to other people, it will be revised over years, and its revisions have nothing to do with School's release history. Performance is worth neither: answers, views, gradings and position in a lesson describe one person's learning and must not travel with the lesson they are about.

## Decision
Three separate things, with no course knowledge in the framework.

1. **The framework** is this repository: the server, the block model, the renderers, the shared assets and the docs. It contains no lesson, no subject, no mission and no learner data. Nothing in it names AIΩN.

2. **A course is its own git repository**, with its own history, authors and release cadence. It holds the authored source material for a course. A **compile step turns those sources into a single consumable course file**, and that compiled file — not the sources, and not the course's working tree — is what School opens. School never needs a course's authoring material, build tooling or git history in order to run a lesson.

   The compiled course file is the only interface between a course and the framework. That is what keeps School subject-agnostic: it knows one format, not how any course is written. It also gives the [learning record contract](../rfc/0001-school.md#the-learning-record-contract) something stable to point at, because a compiled course has a version and a hash while a working tree does not.

   Compiling is also where a course is validated. Duplicate block IDs, references to unknown IDs and reference cycles are rejected at compile time, so a broken course cannot ship — rather than being caught by the server at load time, as RFC 1 currently has it.

3. **Learner state** is private and lives outside the course: answers, views, encounters, gradings and lesson position for one learner. School never writes it into the course directory. A course's `.gitignore` is not the mechanism that keeps it out; not putting it there is. Whether that state is itself a private git repository or a single local file is the learner's choice, and is configuration.

The framework resolves all three from settings the learner edits, not from compiled-in paths. The served URL prefixes become a configured map of named mounts rather than the fixed four of ADR 5, and `assets` is the only mount the framework itself supplies.

## Alternatives
- **One repository per course, each a fork of School.** Rejected: it fixes nothing and every course carries its own copy of the server.
- **A single private repository holding lessons and grades together.** Considered and rejected. It makes lessons unshareable in order to protect performance data, which is the wrong trade; the two layers have opposite visibility.
- **Keep the lessons here and just ignore the database.** Rejected: the framework stays course-specific, so a second course still cannot exist.
- **Have School read a course's sources directly, with no compile step.** Rejected: the framework would need to know each course's authoring conventions, which is the course knowledge this ADR removes. It also leaves nothing stable to hash, since a working tree changes without a version.

## Consequences
- ADRs 3, 4 and 5 are amended. The database path, the bind mounts and the served allowlist all become configured rather than fixed.
- ~~The AIΩN material in this repository becomes the first course and moves to its own repository.~~ **Done 2026-11-21** (increment 2): the course is its own repository, learner state is a separate private one, and this repository is framework only.
- The compiled course file is a distribution format, so it needs a declared layout and a format version. Without one, courses will not stay readable across School versions.
- A compile step is new work the project does not have yet: a format, a compiler, and a way to tell a stale artifact from a fresh one. It is the cost of this decision, and it buys course-side validation and a hashable artifact.
- Block `ref` resolution and lesson-set validation move from the server's loader to the compiler. `server/blocks.ts` keeps validating what it is handed, because a compiled file can still arrive corrupt or from an older format version.
- Private state must stay interpretable against content its owner does not control. A course author can publish a new revision at any time, so state recorded against an earlier compiled hash has to remain readable — which is what the learning record contract already requires.
- The skill must be told where the course and the state are. ~~Which directory it runs in is unresolved.~~ **Settled by [ADR 8](0008-the-school-skill-and-who-invokes-whom.md):** the skill is `/school`, a person runs it to author a course, and the *server* invokes an agent for subjective grading and lesson preparation. Taking a prepared lesson needs no agent at all.
- ~~This repository has no README describing School as a framework.~~ **Done 2026-11-21:** [README.md](../../README.md) now describes the framework and credits the skill the idea came from.

## Open
These follow from the decision and are not settled by it:

- Whether the compiled file is committed to the course repository, attached to a release, or built on demand.
- Whether School can compile a course locally for authoring, or only ever consumes an artifact someone else built.
- The compiled format itself: one file per course, or one per lesson.
