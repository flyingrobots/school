# 6. Separate the framework, the lessons and the learner's state

Date: 2026-11-21 · Status: Accepted

## Context
School was built while teaching one course, the AIΩN Foundations Series, and that course leaked into the software. `server/server.ts` hardcodes an `aion` mount and defaults `AION_ROOT` to a sibling checkout; ADR 5 fixes `/aion` as one of exactly four served URL prefixes; `MISSION.md`, `RESOURCES.md`, `learning-records/` and `lessons/` all describe that one subject; and `progress/progress.db` sits in the same tree as everything else.

The course was a test case for building the framework, not the purpose of it. A second course cannot be added today without editing the server.

The three things involved have different audiences, different histories and opposite privacy needs:

| Layer | Who it is for | Visibility | Whose history |
| --- | --- | --- | --- |
| The framework | anyone running School | public | this repository |
| A lesson pack | anyone studying or teaching that subject | shareable, public by default | its own repository |
| Learner state | one learner | private | not shared at all |

Lessons are worth sharing and worth versioning in their own right. A pack that teaches AIΩN from zero is useful to other people, it will be revised over years, and its revisions have nothing to do with School's release history. Performance is worth neither: answers, views, gradings and position in a lesson describe one person's learning and must not travel with the lesson they are about.

## Decision
Three separate things, with no course knowledge in the framework.

1. **The framework** is this repository: the server, the block model, the renderers, the shared assets and the docs. It contains no lesson, no subject, no mission and no learner data. Nothing in it names AIΩN.

2. **A lesson pack is its own git repository**, with its own history, authors and release cadence. It holds the authored source material for a course. A **compile step turns those sources into a single consumable lesson file**, and that compiled file — not the sources, and not the pack's working tree — is what School opens. School never needs a pack's authoring material, build tooling or git history in order to run a lesson.

   The compiled file is the only interface between a pack and the framework. That is what keeps School lesson-agnostic: it knows one format, not how any course is written. It also gives the [learning record contract](../rfc/0001-school.md#the-learning-record-contract) something stable to point at, because a compiled pack has a version and a hash while a working tree does not.

   Compiling is also where a pack is validated. Duplicate block IDs, references to unknown IDs and reference cycles are rejected at compile time, so a broken pack cannot ship — rather than being caught by the server at load time, as RFC 1 currently has it.

3. **Learner state** is private and lives outside the pack: answers, views, encounters, gradings and lesson position for one learner. School never writes it into the pack directory. A pack's `.gitignore` is not the mechanism that keeps it out; not putting it there is. Whether that state is itself a private git repository or a single local file is the learner's choice, and is configuration.

The framework resolves all three from settings the learner edits, not from compiled-in paths. The served URL prefixes become a configured map of named mounts rather than the fixed four of ADR 5, and `assets` is the only mount the framework itself supplies.

## Alternatives
- **One repository per course, each a fork of School.** Rejected: it fixes nothing and every course carries its own copy of the server.
- **A single private repository holding lessons and grades together.** Considered and rejected. It makes lessons unshareable in order to protect performance data, which is the wrong trade; the two layers have opposite visibility.
- **Keep the lessons here and just ignore the database.** Rejected: the framework stays course-specific, so a second course still cannot exist.
- **Have School read a pack's sources directly, with no compile step.** Rejected: the framework would need to know each pack's authoring conventions, which is the course knowledge this ADR removes. It also leaves nothing stable to hash, since a working tree changes without a version.

## Consequences
- ADRs 3, 4 and 5 are amended. The database path, the bind mounts and the served allowlist all become configured rather than fixed.
- The AIΩN material in this repository becomes the first lesson pack and moves to its own repository. That is its own rollout increment; until it runs, this repository still contains the course it says it should not.
- The compiled lesson file is a distribution format, so it needs a declared layout and a format version. Without one, packs will not stay readable across School versions.
- A compile step is new work the project does not have yet: a format, a compiler, and a way to tell a stale artifact from a fresh one. It is the cost of this decision, and it buys pack-side validation and a hashable artifact.
- Block `ref` resolution and lesson-set validation move from the server's loader to the compiler. `server/blocks.ts` keeps validating what it is handed, because a compiled file can still arrive corrupt or from an older format version.
- Private state must stay interpretable against content its owner does not control. A pack author can publish a new revision at any time, so state recorded against an earlier compiled hash has to remain readable — which is what the learning record contract already requires.
- `/teach` must be told where the pack and the state are, and whether it authors sources or reads compiled output. The single-workspace layout it assumes is now split, and which directory it runs in is unresolved (RFC 1, open question 5).
- This repository has no README describing School as a framework, because `MISSION.md` describes the AIΩN course instead. It needs one once the course moves out.

## Open
These follow from the decision and are not settled by it:

- Whether the compiled file is committed to the pack repository, attached to a release, or built on demand.
- Whether School can compile a pack locally for authoring, or only ever consumes an artifact someone else built.
- The compiled format itself: one file per pack, or one per lesson.
