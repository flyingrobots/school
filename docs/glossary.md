# Glossary

The vocabulary used across School's ADRs, RFCs and code. If a term here conflicts with older wording in [ADR 6](adr/0006-separate-framework-lessons-and-learner-state.md), [ADR 7](adr/0007-course-schema-in-graphql-compiled-by-wesley.md) or [RFC 1](rfc/0001-school.md), this file wins and those documents need a terminology pass.

**Where the idea came from.** School's teaching model was inspired by the `teach` skill in [mattpocock/skills](https://github.com/mattpocock/skills). School is not a fork or an extension of it: we write our own skill, for our own framework, and it works differently in almost every detail. What carries over is the principle — that teaching should be grounded in a stated mission, built on high-trust sources, practised through tight feedback loops, and aimed just past what the learner can already do. School then adds what that skill has no notion of: **courses**, **quizzes**, **exams**, and a **server** that records what actually happened.

Entries are tagged:

- *model* — part of the teaching model, in the lineage of that original idea.
- *School* — something School adds.
- *diverges* — a word the original used differently, and why ours differs.
- **Unsettled** — we agree the thing exists, not how it works. Not a decision.

> Not to be confused with a course's own `GLOSSARY.md`, which is subject matter. This file is project vocabulary.

## The teaching loop

**Mission** *(model)* — Why *one particular learner* is studying something: the concrete real-world goal, what success looks like, their constraints. Every teaching decision traces back to it. A mission is about the learner, so it is private and is not part of a course.

**Objectives** *(School)* — What a *course* claims to teach, declared by its author. The counterpart to a mission: objectives are about the subject and are shared, a mission is about one person and is not. A lesson is generated from where the two overlap.

**Zone of proximal development** *(model)* — The band just past what the learner can already do, where teaching lands best. Computed from their learning records, not guessed.

**Knowledge, Skills, Wisdom** *(model)* — The three-part split School borrows from the original skill's philosophy. Knowledge is captured from high-trust resources, never from an agent's parametric memory. Skills are built by interactive practice with a tight feedback loop. Wisdom comes from real interaction with other practitioners, which is why resources list communities and not only reading.

**Fluency strength** and **storage strength** *(model)* — Retrieving something right now, versus still knowing it months later. Fluency is the more convincing of the two and the less valuable: answering correctly today predicts very little about next month. Storage strength is the goal, and it is built by making practice harder in useful ways — retrieval practice, spacing and interleaving.

**Learning record** *(model)* — A short numbered note in the learner's own store recording that something is now genuinely understood, or was corrected, or was disclosed as prior knowledge — and why that changes what to teach next. The teaching equivalent of an ADR. Evidence, not a session log. Private.

**Reference document** *(model)* — A compressed, durable cheat sheet: the distilled essence of what a lesson taught, built for quick re-reading. The original skill is explicit that *these* are what a learner returns to, while lessons are not — which is what makes reference documents the durable content of a course.

**Resources** *(model)* — The curated, annotated set of high-trust sources for a subject, split into Knowledge and Wisdom (communities). Part of a course.

**Notes** *(model)* — How this learner wants to be taught: their stated preferences. Private.

**Component** *(model)* — A reusable asset shared across lessons: a stylesheet, a quiz widget, a simulator, a diagram helper. Reuse is the default rather than the exception. A shared stylesheet is the first component any course needs, so that its lessons read as one coherent course rather than a set of unrelated pages.

## Lessons

**Lesson** *(diverges)* — A declared unit in a course's sequence: what it teaches, which materials it draws on, and which assessments attach to it. In the `teach` skill a "lesson" is the generated HTML file the learner reads; we split the word because a course must declare *lesson 1, lesson 2, lesson 3* while the page each learner sees is made for them.

**Lesson rendering** *(School)* — The actual page a specific learner receives for a lesson, built from that lesson's declared materials plus that learner's state. **Prepared ahead of time and retained**, not generated when the page is opened: the learner never waits on a model, and a prepared rendering can be replayed with no agent running at all. It lives in learner state rather than in the course, and is hashed as a snapshot so old answers stay interpretable. A rendering should be beautiful and readable, cite its claims, recommend one primary source, and remind the learner that the agent is their teacher and can be asked follow-ups.

**Block** *(model)* — The smallest addressable piece of content, with a stable `id` and a type: `page`, `section`, `prose`, `card`, `quote`, `aside`, `quiz`, `explain`, `nest`. A block can be reused by reference (`{ "ref": id }`) rather than copied, so one activity keeps one history across several appearances.

**Quiz block** *(model, clarified)* — A `quiz`-typed block *inside* a lesson rendering: inline practice, answered while reading. Not the same as a **quiz** below.

**Preparation** *(School)* — The act of an agent building the next lesson rendering before the learner reaches it, from recorded performance and from what the learner says they need. Asynchronous by design: a failure costs the *future* of a course, never the page currently in front of the learner. **Unsettled:** how far ahead it runs, and what a learner sees when they reach the end of what has been prepared.

## Assessment and grading

**Objective item** *(School)* — A question with a declared correct answer: multiple choice and anything else checkable by comparison. Graded by the server, deterministically, with no model involved and no delay.

**Subjective item** *(School)* — A write-in or an explanation, with no declared answer, that needs reasoning to assess. Graded by an agent through the sidecar.

**Server grading** and **model grading** *(School)* — The two kinds of judgment, kept apart because they carry different authority. Comparing an answer against a declared one is not the same kind of evidence as a model's opinion of an explanation, and the record must never conflate them.

## Courses

**Course** *(School)* — The shareable unit, and the thing that has a git repository. A course declares its objectives, its sequence, its lessons, its quizzes and exams, its reference documents, its resources, its glossary and its components. It does **not** contain lesson renderings or anyone's learner state. A course with one lesson is an ordinary course.

**Course repository** *(School)* — The git repository holding one course, with its own history, authors and release cadence, independent of School's.

**Sequence** *(School)* — The order a course presents its lessons, quizzes and exams: lesson 1, its quiz, lesson 2, its quiz, an exam over lessons 1–2, and so on. The sequence belongs to the course and is public. **Unsettled:** whether it is strict, whether an assessment must be passed to advance, and how a declared sequence coexists with the agent's adaptive choice of review material.

**Quiz** *(School)* — An assessment that is its own item in the sequence, covering part of a lesson or one whole lesson.

**Exam** *(School)* — An assessment covering several lessons, spaced through the sequence. A course may have more than one. **Unsettled:** whether an exam differs from a quiz in anything beyond scope — timing, closed-book, or gating progress.

**Assessment** *(School)* — Quizzes and exams together, when the distinction does not matter.

**Declared for measurement, generated for practice** *(School)* — The governing rule for the two kinds of question. A quiz block is practice, so it may be generated for one learner. A quiz or exam is measurement, so its items are declared in the course and are the same for everyone; otherwise results do not mean the same thing for two learners, or for one learner twice.

**Course file** *(School)* — **Unsettled**, and possibly unnecessary. If a course is played by an agent reading the repository, the server needs only the machine-readable parts (sequence, assessment items, block structure) and a compiled bundle may be redundant. See the open decisions in RFC 1.

**Course schema**, **format version** *(School)* — **Unsettled**, and downstream of whether a course file exists at all. [ADR 7](adr/0007-course-schema-in-graphql-compiled-by-wesley.md) proposes GraphQL SDL compiled by Wesley; JSON Schema is the alternative; neither is settled.

## The learner's side

**Learner state** *(School)* — Everything about one person: their mission, notes, learning records, submissions, gradings, position, and the snapshots of what they were shown. Private, stored outside every course repository, and never written into one.

**Position** *(School)* — Where a learner has reached in a course's sequence.

**Encounter** *(School)* — One occasion of being shown content: which lesson or assessment, which view, which snapshot, and when.

**Submission** *(School)* — One answer a learner gave, identified by a client-generated UUID so a retransmission is not counted as a second attempt.

**Grading** *(School)* — One judgment of one submission. A submission may collect several over time; earlier ones are never overwritten.

**Snapshot** *(School)* — The resolved content exactly as displayed for an encounter, stored by hash, so an answer stays interpretable after the course is revised. Required because lesson renderings are generated.

**First try** *(School)* — The first response to a block within one encounter, decided by the server rather than the browser.

## The framework

**School**, or **the framework** *(School)* — This repository: the server, the block model, the renderers, the shared components and the docs. It is subject-agnostic. It renders lessons, records evidence, and runs assessments; it does not know what any course is about.

**Server** *(School)* — The part that serves renderings and records evidence to SQLite. Its existence is the original reason School exists: the skill alone could not see the learner's quiz results.

**View** *(School)* — A rendering of the same content for a different purpose: `web` (interactive, records evidence), `slides` (presentation, records nothing), `epub` (a frozen export, later). A view may omit a block but never changes its data.

**The `school` skill** *(School)* — School's own skill, invoked as `/school`, written for this framework. Its job is **conformance**: making an agent's output meet School's structure, rubric, citation requirements and question-balancing rules rather than whatever the model would have produced unaided. Used in two places — by a person authoring a course, and by the agent the server calls to grade subjective answers and prepare future lessons ([ADR 8](adr/0008-the-school-skill-and-who-invokes-whom.md)). The framework is deterministic; the skill constrains the part that cannot be.

**Mount** *(School)* — A named directory the server will serve files from, configured rather than compiled in.

**Sidecar** *(School, reserved term)* — The server's bridge to an agent: a host process, outside Docker, that the server calls for the two jobs needing a model — grading **subjective items** and **preparing** future lesson renderings ([ADR 8](adr/0008-the-school-skill-and-who-invokes-whom.md)). Originally scoped to grading alone. It is **not** a repository and has nothing to do with course distribution. Do not use "sidecar" for anything else.

## Retired wording

| Old term | Use instead | Why |
| --- | --- | --- |
| lesson pack, pack | **course** | The repository and the shareable unit are the course. |
| lesson file | **course file** (if it exists at all) | A course contains lessons, not the reverse. |
| sidecar repository | **course repository** | "Sidecar" is reserved for the grading service. |
| private content repository | **learner state** | Courses are public; only the learner's record is private. |
| curriculum | **objectives** + **sequence** | Two separable things; naming them apart avoids the earlier confusion. |
