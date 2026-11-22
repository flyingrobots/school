# Glossary

The vocabulary used across School's ADRs, RFCs and code. If a term here conflicts with older wording in [ADR 6](adr/0006-separate-framework-lessons-and-learner-state.md), [ADR 7](adr/0007-lesson-file-schema-in-graphql-compiled-by-wesley.md) or [RFC 1](rfc/0001-school.md), this file wins and those documents need a terminology pass.

Entries marked **Unsettled** name a thing we have agreed exists without agreeing how it works. They are not decisions.

> Not to be confused with `reference/glossary.html`, which is AIΩN subject matter and is course content, not project vocabulary.

## The three layers

**School**, or **the framework** — This repository: the server, the block model, the renderers, the shared assets and the docs. It is *lesson-agnostic*: it opens a course file, presents what is in it, records evidence, and knows nothing about any subject. Nothing in it names a particular course.

**Course** — The shareable unit, and the thing that has a git repository. A course bundles lessons, quizzes and exams into an ordered whole that someone can download and work through. A course with exactly one lesson is an ordinary course, not a special case. Courses are public by default; sharing them is the point.

**Learner state** — One person's private record: their answers, views, gradings, and position in a course. It lives outside the course repository and School never writes it there. Whether it is itself a private git repository or a single local file is the learner's configuration choice.

## Course anatomy

**Course repository** — The git repository holding one course. It has its own history, authors and release cadence, independent of School's. It contains course source, not learner state.

**Course source** — The authored build materials in a course repository: lesson text, question banks, diagrams, source documents, and whatever else the author works in. School never reads course source.

**Course compiler** — Whatever turns course source into a course file. **Each course may have its own**, written in any language, with any dependencies. The framework does not supply it and does not care how it works. The only contract is that its output conforms to the course schema.

**Course file** — The compiled artifact School consumes: one file, produced by a course compiler, conforming to the course schema. This is the *only* interface between a course and the framework, which is what keeps the framework agnostic. **Unsettled:** whether it is JSON or a binary encoding, and whether one file holds a whole course or one file holds each lesson.

**Course schema** — The declared, versioned definition of what a valid course file is. Held in this repository, because the framework owns the format. **Unsettled:** whether it is declared in GraphQL SDL compiled by Wesley (ADR 7) or as JSON Schema, and whether Wesley earns its cost at all.

**Format version** — The identifier of which course schema a course file was built against, recorded inside the file. Lets School reject a file it cannot read and say why. Under ADR 7 this is Wesley's schema hash, computed from the lowered schema rather than the file's bytes.

**Asset** — A binary a lesson needs that is not itself text: an image, audio, video, a PDF. Referenced from the course file by path or identifier rather than embedded, so the course file stays text and stays diffable.

## Content units

**Lesson** — One teaching unit inside a course: short, numbered, teaching a single skill. A lesson is a unit of content, not a repository.

**Block** — The smallest addressable piece of content, with a stable `id` and a type. Current types: `page`, `section`, `prose`, `card`, `quote`, `aside`, `quiz`, `explain`, `nest`. A block may be reused by reference (`{ "ref": id }`) rather than copied, so one activity can appear in several places while keeping one history.

**Quiz block** — A `quiz`-typed block *inside* a lesson: inline practice, answered as you read. Distinct from a **quiz** below. These are two different things and the old wording conflated them.

**Quiz** — An assessment that is its own item in the sequence, covering part of a lesson or one whole lesson. Sits between lessons rather than inside one.

**Exam** — An assessment covering a bundle of several lessons. A course may have one or more, spaced through the sequence.

**Assessment** — Quizzes and exams together, when the distinction does not matter. **Unsettled:** whether a quiz and an exam differ in anything but scope — for example whether exams are closed-book, timed, or gate progress.

**Sequence** — The order in which a course presents its lessons, quizzes and exams: lesson 1, its quiz, lesson 2, its quiz, an exam over lessons 1–2, and so on. The sequence belongs to the course and is public. Where the learner *is* in it is learner state and is private. **Unsettled:** whether the sequence is strict, whether an assessment must be passed to advance, and how a fixed sequence coexists with the teacher's adaptive choice of review material (RFC 1).

## Learner evidence

These are the identities the [learning record contract](rfc/0001-school.md#the-learning-record-contract) requires. They are summarised here; the contract is authoritative.

**Encounter** — One occasion of being shown content: which lesson or assessment, which view, which content snapshot, and when. Created by the server when a page is served.

**Submission** — One answer the learner gave, identified by a client-generated UUID so that a retransmission is not mistaken for a second attempt.

**Grading** — One judgment of one submission. A submission may have several gradings over time; earlier ones are never overwritten.

**Snapshot** — The retained, resolved content exactly as displayed for an encounter, stored by hash. Lets an old answer still be interpreted after the course is revised.

**First try** — The first response to a block within one encounter, decided by the server rather than the browser. Full history is kept, so first-ever performance can also be derived.

**Position** — Where the learner has reached in a course's sequence. Private state.

## Runtime

**View** — A rendering of the same content for a different purpose: `web` (interactive, records evidence), `slides` (presentation, records nothing), `epub` (a frozen export, later). A view may omit a block but never changes its data.

**Mount** — A named directory the server will serve files from, configured rather than compiled in. `assets` is the only mount the framework itself supplies.

**Sidecar** — **Reserved term.** The LLM grading service: a process on the host, outside Docker, that grades written explanations. It is *not* a repository and has nothing to do with courses. Do not use "sidecar" for anything else.

## Retired wording

| Old term | Use instead | Why |
| --- | --- | --- |
| lesson pack, pack | **course** | The repository and the shareable unit are the course. Lessons live inside it. |
| lesson file | **course file** | The compiled artifact is a course, which contains lessons. |
| sidecar repository | **course repository** | "Sidecar" is reserved for the grading service. |
| private content repository | **learner state** | Courses are public; only the learner's record is private. |
