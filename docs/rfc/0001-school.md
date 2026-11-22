# RFC 1: School, a personal learning system built with an AI teacher

- **Status:** Draft, revision 4. Agent-written. Not yet accepted.
- **Date:** 2026-11-18, revised 2026-11-21 (revisions 3 and 4).
- **Describes:** this repository at commit `22e5411`. The workspace is a git repository as of 2026-11-21, so revision 3 cites commits where revision 2 could not.
- **Builds on:** ADRs 1–7 in `docs/adr/`. Revision 4 follows [ADR 6](../adr/0006-separate-framework-lessons-and-learner-state.md) and [ADR 7](../adr/0007-course-schema-in-graphql-compiled-by-wesley.md), which changed what School is.
- **Decision requested:** agree on [the concept](#the-concept), accept the [learning record contract](#the-learning-record-contract), accept, amend or reject each of the four [proposals](#proposals), and answer [open questions](#open-questions) 1 and 2. This RFC deliberately does not settle those two for the learner; see [review reconciliation](#review-reconciliation).

## The concept

School is a **learning framework**, and it is subject-agnostic. It plays a lesson that has already been prepared, records how the practice went, grades the objective items itself, and calls an agent for the parts that need reasoning. It knows nothing about any particular subject.

Three things are kept apart ([ADR 6](../adr/0006-separate-framework-lessons-and-learner-state.md)):

| Layer | What it is | Visibility |
| --- | --- | --- |
| **The framework** | this repository: server, block model, renderers, shared assets | public |
| **A course** | its own git repository: objectives, a sequence of lessons, quizzes, exams, reference documents, resources, components | shareable, public by default |
| **Learner state** | one person's mission, notes, learning records, answers, gradings, position, and their prepared lesson renderings | private, outside the course |

Courses are worth sharing and worth versioning on their own; performance is worth neither. A course declares what each lesson teaches; the page a learner reads is a **lesson rendering**, prepared for them ahead of time and held in their own state ([ADR 8](../adr/0008-the-school-skill-and-who-invokes-whom.md)). The framework is what keeps this agnostic: it plays and records, and knows nothing of the subject.

The **AIΩN Foundations Series is the first course, and it was the test case that built the framework** — not its purpose. It still lives in this repository, which contradicts all of the above; moving it out is [increment 2](#rollout).

School runs on the learner's own machine. It has one learner at a time and it does not publish anything on their behalf.

### Where it came from

School began on 2026-11-18 as an ordinary use of the `/teach` skill in Claude Code, with the request "teach me about `~/git/aion`". The skill treats a folder as a teaching workspace:

| File or folder | What it holds |
| --- | --- |
| `MISSION.md` | Why the learner is learning this, and what success looks like |
| `lessons/` | Short, numbered lessons, each one teaching a single skill |
| `reference/` | Cheat sheets and a glossary, meant to be revisited |
| `learning-records/` | Evidence of what the learner has actually learned, used to decide what to teach next |
| `RESOURCES.md`, `NOTES.md` | Trusted sources, and the learner's preferences |
| `assets/` | A shared stylesheet and components, such as the quiz widget |

In this first workspace the learner is the author of the AIΩN Foundations Series, and that course is what the framework was built against. Their goal is to explain the series to other people, so they asked to be taught it from zero, the way a newcomer would meet it (`MISSION.md`, `learning-records/0001-author-learning-as-newcomer.md`).

The skill's lessons are static HTML files. After Lesson 2 the learner asked, "wait, you can't see my quiz results?" The teacher couldn't: answers stayed in the browser and were lost. That gap led to the server (ADR 1), and the rest followed from using it:

1. A local server records answers and views in SQLite (ADRs 1–3).
2. The learner wanted to study on their phone, away from home, so the server runs in Docker on their Mac and is reachable only over their Tailscale network (ADRs 4–5).
3. Answers keyed by question position break when a lesson is edited, so the learner proposed building lessons from **blocks**: data plus a render function, d3-style, with the page itself as the root block (proposal 1).
4. Blocks raised two more ideas: the same lesson shown in different ways for a phone, a presentation or an e-book (proposal 3), and blocks whose data comes from different sources (proposal 2).
5. The explanation exercise had no automatic feedback, so the learner proposed connecting local LLM agents through a service on the host (proposal 4).

### How it is used

One study session goes like this:

1. **The teacher plans.** A person runs `/school`, or the server calls an agent to prepare the next lesson. The teacher reads the learner's mission and learning records from their state directory, and queries its `progress.db` for recent results. It writes the next lesson, aimed just past what the learner can already do, with claims citing the papers. The lesson includes at least one activity from an earlier lesson, chosen by the teacher, as delayed practice.
2. **The learner studies, anywhere.** They open the lesson on a phone or laptop through the tailnet, answer quizzes with immediate feedback, and write or dictate a 30-second explanation.
3. **School records.** Each submission is stored with the content the learner actually saw and the encounter it belonged to (see [the learning record contract](#the-learning-record-contract)).
4. **The teacher adapts, and says why.** The next plan names the recorded attempts that caused each review item to return, so the learner can disagree with the reasoning.

Lessons, reference sheets and the papers are served read-only. Content changes come from the teacher, as file edits.

### How lessons are planned

Lessons are written **one at a time, as the course goes**. Only the direction is planned: it roughly follows the order of the sources a course lists. There is no syllabus, and the teacher does not write one unless asked — an offer to draft a 10–12 lesson outline was made on 2026-11-18 and was not taken up.

This is deliberate, not an omission. A syllabus fixed in advance would decide the next lesson before the evidence for it exists, which is the opposite of the organizing idea. The cost is that the course has no visible map, so the learner cannot reorder it ahead of time; the mitigation is that every lesson names the recorded attempts behind its review items (step 4 above).

With the learner's notes and learning records, this fixes the teaching stance: start from zero, never assume the jargon even though the learner wrote the papers, and end each lesson with a "say it out loud" exercise, because the mission is explaining the series to other people.

### What it is for

The purpose is long-term retention of real skills, not the feeling of having covered something. The `/teach` skill distinguishes *fluency* (recalling something right now) from *storage strength* (still knowing it months later). Research on learning draws the same line: performance during practice can differ from what is learned ([Bjork Learning and Forgetting Lab](https://bjorklab.psych.ucla.edu/research/)). It builds storage strength through retrieval practice, spacing and interleaving.

Those methods work with paper flashcards. What School adds is **evidence-based adaptation**: a record that lets the teacher choose what returns and when. School treats these as different kinds of evidence, and never treats one as another:

- a view (the learner opened a page);
- an immediate correct answer;
- a correct, unaided answer after a delay;
- successful use in a new example or explanation;
- a grader's judgment of an explanation.

For this mission the decisive test is whether another person could rebuild the idea from the learner's explanation.

### Design principles

1. **Lesson content is versioned, and every answer points at what was served.** Content may come from the teacher or from generation, but it is reviewed, kept as a revision, and shown the same way on every load.
2. **Learner evidence is never lost or reinterpreted.** Submissions and judgments are preserved with their original meaning. Physical tables may be rebuilt; logical history may not change. Operational state, such as whether a grading job is running, may be mutable.
3. **A submission, a grade and a teaching decision are separate records.** Each has a different authority. Keeping all three makes it possible to find that the learner was right, the grader was wrong, or the lesson was misleading. Append-only storage preserves evidence; it does not make an interpretation correct.
4. **Unknown is better than invented.** When old evidence cannot be attributed reliably, School keeps it marked as unattributed rather than guessing.
5. **Tight feedback loops.** Every practice task gives feedback at once, automatically where possible, and says honestly when it cannot.
6. **Small, local and private.** One machine, no accounts. A local-model option keeps School usable with no cloud service. An adapter that uses a hosted model sends prompts and outputs over the network, and is described as such.
7. **Each part is worth what it costs.** A feature earns its place by improving the learner's practice or the trustworthiness of the teacher's decisions.

## Current state (measured)

First measured on 2026-11-18 by reading the files and running the server against a scratch database. **Re-measured on 2026-11-21** against commit `22e5411`, including a real `docker build` and a container run.

| Item | Observed |
| --- | --- |
| Repository | **Framework only** since increment 2. The AIΩN course lives in its own repository and learner state in a separate private one. Published as `flyingrobots/school` under Apache 2.0. |
| Running container | **None.** The pre-block `server-school-1` container seen on 2026-11-18 is gone, so nothing is currently accepting answers. |
| `progress.db` | `user_version` 0, still the pre-block schema (`answers` keyed by `lesson` and question position). `answers`: 0 rows. `views`: 0 rows. No learner evidence exists yet — so nothing is at risk today, and equally the teacher has no results to plan from. |
| Block model | `server/blocks.ts`: block types `page`, `section`, `prose`, `card`, `quote`, `aside`, `quiz`, `explain` and `nest`; `{ "ref": id }` reuse; duplicate IDs, unknown refs and reference cycles throw `BlockError`, the cycle error naming its path (`a > b > a`); sharing one block from two parents is allowed. Quiz choices carry a required `id`, unique within the quiz, rendered as `data-choice` (increment 3a, flyingrobots/school#1). |
| Renderers | `server/render.ts`: views `web` and `slides`, with an exhaustive `switch`. |
| Server on disk | `server/server.ts` loads `lessons/*.json` and renders `/lessons/:id?view=`. The schema migration is **no longer destructive** (increment 1, done 2026-11-21): `server/migrate.ts` snapshots the database, rebuilds `answers` in a transaction and refuses to proceed if the row count would change. Schema version 5: `snapshots`, `encounters`, and answers that name their encounter, choice and submission, with append-only triggers on all three tables (increment 3b, flyingrobots/school#2). A lesson set that fails validation falls back to that course's last valid set, logging the error on every failing reload; with no earlier valid set the lesson page is a 500. |
| Quiz client | `assets/quiz.js` sends a submission UUID, the encounter, the block and the choice id. It claims nothing about correctness. An answer waits in a `localStorage` outbox until the server confirms the commit, and the page says when it is not saved yet ([ADR 9](../adr/0009-the-learning-record-is-enforced-by-the-database.md)). |
| Lessons | The framework renders any course whose lessons are block JSON, proven against two unrelated courses. The AIΩN course's two lessons are still pre-format HTML, so that course lists none until increment 3. |
| Markdown | Bun 1.4.4 provides `Bun.markdown.html`. Raw HTML in the input passes through unescaped (`"# hi <b>x</b>"` renders `<h1>hi <b>x</b></h1>`). |
| Phone access | **Unverified.** `tailscale serve --bg 4747` was left for the learner to run on 2026-11-18 and no run is recorded. `tailscale serve status` currently fails on this machine (`Fatal error: The current bundleIdentifier is unknown to the registry`), so the tailnet route has never been shown to work end to end — even though studying on a phone is the reason ADRs 4 and 5 exist. |

Container run on 2026-11-21, built from `server/` with a scratch `progress/` mount:

```text
GET /                           -> 200
GET /assets/style.css           -> 200
GET /lessons/0001-the-inversion -> 404   (no .json lesson exists)
```

Problems that block a rebuild:

1. ~~`server/Dockerfile` copies only `server.ts`.~~ **Fixed 2026-11-21** in commit `22e5411`. The real cause was `server/.dockerignore`, which was `*` plus `!server.ts`: `blocks.ts` and `render.ts` could not enter the build context at all, so widening the Dockerfile's `COPY` alone would not have worked. Revision 2 named only the Dockerfile. Both files now admit all three sources, verified by building the image and starting the container.
2. No lesson is in block form, and `lessons/` is no longer served as static files, so every lesson returns 404. *(Still true, measured above.)*
3. ~~`render.ts` links `/assets/slides.css` and `/assets/slides.js`, which do not exist.~~ **Fixed 2026-11-22:** the slides view no longer links them; a test fetches every asset a slides page links.
4. ~~**The framework is not lesson-agnostic.**~~ **Fixed 2026-11-21** (increment 2). `server/config.ts` resolves the course, the learner's state and any source mounts from the environment; `render.ts` discovers a course's reference documents instead of assuming a glossary filename. No shipped framework source names a subject.
5. **The course format has no schema and no version.** It is hand-written TypeScript in `server/blocks.ts`, so no course author can read it and no second implementation can exist (ADR 7, now itself reopened).
6. ~~**The version-2 migration drops `answers`.**~~ **Fixed 2026-11-21.** Replaced by `server/migrate.ts`: a snapshot via `VACUUM INTO` (a file copy is unsafe under WAL), a transactional table rebuild, and a row-count guard that aborts rather than lose a row. Legacy positional answers are kept as `origin = 'legacy'` with `block_id` NULL — unknown attribution rather than invented — and their original question position, prompt and choice text preserved.

## The learning record contract

This section is the core of the RFC. It applies to every proposal.

> Every accepted submission identifies enough retained content and encounter context to recover the activity the learner actually answered.

### Identities

| Identity | Answers | How School provides it |
| --- | --- | --- |
| Block | Which reusable activity is this? | Block `id`, stable for the block's meaning |
| Content revision | What exactly was shown? | A content hash of the resolved lesson, stored once in a `snapshots` table keyed by hash |
| Encounter | In which lesson or review did this happen? | An `encounters` row created when the web view is served, or resumed if that lesson with the same snapshot was active within six hours (ADR 9): lesson, view, snapshot hash, time |
| Submission | Which answer did the learner give? | A client-generated UUID, unique in the database |
| Grading | Which judgment of that submission is this? | A `gradings` row referring to one submission |
| Format version | Which course schema was this written against? | Recorded in the compiled course (ADR 7, mechanism reopened) |

One stored snapshot per distinct resolved lesson covers both the content revision and anything dynamic bindings selected (see proposal 2). A git commit is not enough on its own, because the server may serve working-tree bytes that differ from any commit — and under ADR 6 the commit would belong to a repository School does not control. The compiled course is the thing to hash: it has a version where a working tree does not.

### Rules

- **Choices have stable IDs.** Each quiz choice carries an `id`. A submission records the choice ID. With the snapshot, that is enough to recover the exact wording and position the learner saw. Reordering or rewording choices never reinterprets old answers.
- **First try means the first response to a block within one encounter.** The full history is kept, so the first answer ever can also be derived. A page reload during the same encounter does not reset it; the server, not the browser, decides.
- **Retries are not answers.** Submitting the same submission UUID twice stores one row. A learner trying again creates a new UUID.
- **Assistance is recorded.** If an encounter shows a hint or reveals a model answer before a submission, the submission records that, and it is not counted as unaided.
- **Time on page is not thinking time.** `ms` is kept as a raw measurement and is not used as a measure of effort, because a phone tab can be interrupted.
- **Corrections are additions.** A flawed activity can be marked as unsuitable for progress estimates; its answers stay.

Acceptance scenario: today the learner answers a block wrong, then right. Next week the block appears in another lesson and they answer it right first time, and the phone sends that last answer twice. School stores **three** submissions in **two** encounters. The later one is a first-try success.

### Block definitions

Structural validation happens **at compile time**, in the course compiler, so a course cannot ship broken (ADR 6). The server still validates what it is handed, because a compiled file can arrive corrupt or in an older format version; it keeps serving the previous valid set if validation fails. Either way, these are rejected:

- two definitions with the same `id` (reusing one definition through `ref` twice is allowed);
- a `ref` to an unknown `id`;
- a reference cycle.

## Proposals

These ship as separate increments. Deferring a proposal also defers its obligations.

### 1. Block lessons

A lesson is a JSON file whose root is a `page` block. Every block has a globally unique `id`. A child is either a block or `{ "ref": "<id>" }`. This example is illustrative and abridged.

```json
{ "type": "page", "id": "0002-warp-graphs", "title": "Graphs of Graphs", "subtitle": "…",
  "children": [
    { "type": "prose", "id": "warp-two-rules", "md": "…" },
    { "type": "quiz", "id": "warp-depth-1", "q": "…",
      "choices": [ { "id": "a", "text": "…", "correct": false }, { "id": "b", "text": "…", "correct": true } ],
      "why": "…" },
    { "ref": "inversion-core-1" } ] }
```

- A course's authored sources, rubrics and grading prompts live in **the course's** git repository (ADRs 6 and 7). Learner records and prepared renderings live in private state outside the course, and are backed up separately.
- A block keeps its `id` only while its meaning is unchanged. Changing what a quiz tests means a new block.

### 2. Data bindings

These are two separate decisions.

**2a. Markdown: accept.** Prose blocks may use an `md` field, rendered with `Bun.markdown.html`. The API is marked unstable, so the Bun version stays pinned (ADR 4) and a test covers the markup we rely on. Lesson Markdown is trusted, because the teacher wrote it and it is in git. Learner text and model text are **never** rendered as Markdown or HTML; they are shown as escaped plain text. Exercises keep typed fields, not Markdown.

**2b. Dynamic review: start with one named selector.** Instead of general SQL in lesson files, add a `review` block bound to one built-in operation, `due-review`. It returns a bounded list of block IDs (at most `limit`, in a fixed order) chosen from first-try misses and time since the last encounter. If the selector fails, the block says so and the rest of the page renders. The selected blocks become part of the encounter's snapshot, so a later database change cannot alter what an answer refers to. The snapshot keeps the **resolved content as displayed**, not merely the list of selected block IDs: if a binding ever substitutes values inside an exercise, those values are what is stored, because an ID alone would not recover what the learner actually read.

General author-written SQL is deferred. If it returns, it needs a defined result shape, ordering, row and time limits, and failure behaviour, as well as a read-only connection.

### 3. Views

Shared content with one renderer per view. A view may leave a block out but never changes its data. Each view has a behaviour contract:

| View | Behaviour | Records evidence? |
| --- | --- | --- |
| `web` | Interactive practice with recorded submissions | Yes |
| `slides` | Presentation. Quizzes render as questions with an answer-reveal step; nothing is submitted | No. A quiz shown during a talk is not practice |
| `epub` (later) | A frozen export with an answer key at the end of each chapter; review blocks are omitted | No |

Whether EPUB needs no change to any lesson will be checked when it is built.

### 4. LLM sidecar for explanation grading

**Scope.** The sidecar's first and only capability is grading explanations. Any later capability that produces teaching content (personal examples, explanations of mistakes, extra practice) must meet the same rules as other content: reviewed, stored as a revision, and recorded in the snapshot of every encounter that shows it. Whether to build such a capability is [open question 1](#open-questions).

**Placement.** A separate process on the host, outside Docker, in this repository. Its advantage is process separation and reuse of host-side tools and logins. A direct API client in the container could also abstract providers; the sidecar is chosen for the separation, not because the alternative is limited to one provider.

```text
phone ──tailnet──▶ tailscale serve ──▶ 127.0.0.1:4747  school (Docker)
                                             │  POST /grade  (token)
                                             ▼
                                   host: llm-sidecar (127.0.0.1:<port>)
                                             │  adapter chosen by config
                                ┌────────────┴─────────────┐
                                ▼                          ▼
                    agent CLI (subscription;      local model server
                    inference is remote)          (inference is local)
```

The configuration below is illustrative; the names are not final.

```toml
default = "local"

[adapters.local]
kind = "openai-compatible"           # for example LM Studio or Ollama on the host
base_url = "http://127.0.0.1:1234/v1"
model = "example-model"

[adapters.agent]
kind = "cli"
command = ["claude", "-p", "--output-format", "json"]   # incomplete: see activation gates
timeout_s = 120
```

**Rubric.** Each grading judges three things separately, with one note per finding:

- **Fidelity:** does the explanation match the cited source?
- **Completeness:** are the necessary connections present?
- **Accessibility:** would the intended newcomer understand the language?

Each is `meets`, `partly` or `misses`. The grader may instead return `insufficient_evidence`, which means the grading is incomplete; it is not a fourth verdict. A finding that the explanation contradicts the source carries a `source_id` and a `quote`. The server checks mechanically that the quote appears in that source. That check does not prove the quote supports the criticism, and the UI does not claim it does.

**What a grading row keeps:** the submission ID, rubric version, prompt version, source excerpts sent, adapter, model identity, the raw response, and the parsed findings. This lets anyone inspect the inputs later; it does not promise the same output on a rerun.

**Lifecycle.**

1. The explanation is saved as a submission before any grading starts.
2. The server creates a grading attempt for that submission and calls the sidecar.
3. If grading succeeds, the result is stored and shown.
4. If it times out, the response is malformed, or the sidecar is unreachable, the attempt is stored as `failed` with the reason. A failure is never an educational verdict.
5. Retry is **manual**. The learner sees: "Your explanation is saved. Automated feedback is unavailable. Retry when ready." Nothing is promised to happen later on its own.
6. A new grading of the same submission, for example after a rubric change, is added as a new row that refers to the earlier one. Earlier gradings are never overwritten. A result that arrives for a superseded attempt is stored and marked as late.

**Activation gates.** The sidecar is not enabled until each of these has been demonstrated against the deployed configuration:

- The container reaches the sidecar through `host.docker.internal` while the sidecar listens only on `127.0.0.1`. *(Unverified.)*
- Requests without the shared token are rejected.
- The CLI adapter runs with no tools available: built-in tools disabled with the CLI's tool restriction option, *and* no MCP servers or settings inherited from the user's configuration. Shown by trying to make the agent use a tool. The Claude Code documentation notes that disabling built-in tools does not disable MCP tools ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
- The prompt goes on stdin; the argument list is fixed by the configuration.
- Each lifecycle case passes: timeout, malformed output, a restart after saving, a duplicate delivery, and two different explanations for the same block.
- The subscription's terms allow this use ([open question 2](#open-questions)). The local adapter does not wait on this.

## Review reconciliation

An external review (*Baker Street*: concept approved, `CHANGES_REQUIRED` on the plan) was applied in revision 2 and re-checked line by line for revision 3, when its full text became available again. Nothing in it is newly adopted here; revision 2 had already acted on it. What revision 3 adds is verification.

The review stated plainly that it had read only the RFC attachment — not the checkout, the ADRs, the database or the container — so its account of the current state was reported, not confirmed. Revision 3 discharges that caveat: every row of [current state](#current-state-measured) has now been checked directly, and the review's two load-bearing observations both hold. The destructive migration is real and still on disk at `server/server.ts:19`, and the database is empty.

| Review item | Where it is handled | Status |
| --- | --- | --- |
| MUST 1 — put preservation into the rebuild instructions | Rollout increment 1; principles 2 and 4 | Adopted |
| MUST 2 — define what a submission identifies | Learning record contract: identities, governing rule, stable choice IDs, snapshot rather than commit | Adopted |
| MUST 3 — define "first try"; separate answers from retries | Contract rules; acceptance scenario | Adopted |
| MUST 4 — give grading a complete lifecycle | Proposal 4, lifecycle; retry is manual | Adopted |
| MUST 5 — specify what the grading labels mean | Proposal 4, rubric; mechanical quote check | Adopted |
| MUST 6 — preserve what dynamic bindings showed | Proposal 2b | Adopted; **tightened in revision 3** to displayed values |
| MUST 7 — make the sidecar's constraints activation gates | Proposal 4, activation gates | Adopted; every gate still unmet |
| SHOULD — let generated content become fixed, reviewed content | Principle 1; proposal 4 scope | Adopted; the underlying preference is [open question 1](#open-questions) |
| SHOULD — make delayed practice part of the first loop | "How it is used" step 1; increment 3 | Adopted, manual teacher choice first |
| SHOULD — use the available Markdown renderer | Proposal 2a | Adopted; verified on Bun 1.4.4 |
| SHOULD — define each view's behavioural contract | Proposal 3 | Adopted |
| SHOULD — rewrite alternatives around real tradeoffs | Alternatives considered | Adopted |
| SHOULD — correct "none of these work without a record" | "What it is for" | Adopted |
| COULD — objective labels, appeals, corrections, calibration set, decision notes | Future directions | Listed, deliberately unscheduled |
| DONT — all seven | Principles 2–4; the evidence list; the `ms` rule; increment 1's evidence bar | Adopted |

Two of the review's own claims are **taken on trust and not verified here**: that disabling Claude Code's built-in tools does not disable MCP tools, and anything about subscription entitlement. The first is an activation gate for the CLI adapter, so it has to be demonstrated against the installed CLI version rather than cited.

One thing the review could not see, because it read only the RFC: the `.dockerignore` cause of problem 1. Revision 2 recorded the Dockerfile half of that bug and would not have fixed it.

**The review's recommendation on open question 1 is still only a recommendation.** It advised rejecting a blanket ban on LLM-written content while keeping grading as the sidecar's first job, and revision 2 wrote that into principle 1 and proposal 4. The learner has not confirmed it. Until they do, that part of the design rests on the reviewer's suggestion and this RFC's assumption rather than on a decision — which is the one thing the review explicitly asked not to let happen quietly.

## Alternatives considered

- **Store blocks in the database.** A database can keep immutable versions too. Files are chosen because they suit the authoring and review workflow: the teacher edits them, the learner reads diffs, and git keeps history.
- **Generate content on every page load.** Rejected because nothing would be kept, so content could not be revisited and answers could not be attributed. Generation whose output is reviewed and stored is a different thing and remains possible (proposal 4, scope).
- **Call a model API directly from the container.** It would work, with the same provider abstraction. It would put credentials in a container reachable from the tailnet, and could not use host-side agent logins. Superseded by the sidecar.
- **General SQL bindings first.** Deferred in favour of one named selector, which has a known result shape and cost.
- **Use the d3 library.** Only its pattern is kept: data plus one render function per type, rendered on the server.
- **Write a Markdown parser.** Unnecessary: `Bun.markdown` exists.

## Risks

- **Losing learner history during an upgrade.** Addressed by rollout increment 1 and principle 2.
- **Fragile CLI output.** Strict schema validation; a parse failure is a failed attempt, never a verdict.
- **Grading that teaches errors.** Separate rubric dimensions, quotes that are checked, `insufficient_evidence`, and gradings that are advisory and never replace the submission. A fixed calibration set (see [future directions](#future-directions)) catches changes in grader behaviour.
- **Scope creep.** Each increment ships separately, and the system is done when it reliably helps the learner practise, revisit and explain.

## Rollout

Each increment ends only when its evidence exists.

| Increment | Work | Evidence required before moving on |
| --- | --- | --- |
| **1. Preserve the foundation** — **DONE 2026-11-21** | `git init` (commit `22e5411`). `server/migrate.ts` replaces the destructive migration. | **Met.** `server/migrate.test.ts`, 5 tests / 66 assertions on a *populated* legacy fixture: all four answers present with original position, prompt, choice and timestamp; two answers to one position stay two answers; the `VACUUM INTO` backup opens standalone and still reads as legacy; a second run copies nothing and takes no snapshot; a v2 database keeps its block attribution. Also proven end to end — the real server migrated a populated legacy database on boot, logged the backup, and served `/` at 200. |
| **2. Separate framework, course and state** — **DONE 2026-11-21** | `server/config.ts` (`SCHOOL_COURSE`, `SCHOOL_STATE`, `SCHOOL_MOUNTS`); `render.ts` discovers reference documents; the AIΩN course and the learner's state are now separate repositories. The course schema question (ADR 7) turned out **not** to block this and stays open. | **Met.** Two unrelated courses — one on knitting, one on chess — each served their own index, lesson, reference list and a named source mount, with **no server change between runs**. Learner state was written to its own directory and nothing was written into either course. Pointing `SCHOOL_STATE` inside `SCHOOL_COURSE` exits 2 with a clear message. 14 unit tests. |
| **3. One web lesson** — split into 3a validation (flyingrobots/school#1, **done**), 3b the record contract (flyingrobots/school#2, **done**) and 3c Lesson 1 end to end (flyingrobots/school#3) | Fix the Dockerfile; convert Lesson 1; add `encounters`, `snapshots`, choice IDs and submission UUIDs; validate the lesson set at load. | The rebuilt container serves Lesson 1, and one answer row identifies its snapshot, encounter, block, choice and submission. HTTP 200 alone is not evidence. |
| **4. Reuse and delayed practice** | Convert Lesson 2 with a `ref` to a Lesson 1 quiz; teacher-chosen review; the `due-review` selector. | The acceptance scenario above produces three submissions in two encounters, with correct first-try values. |
| **5. Explanation feedback** | Sidecar with the local adapter first; rubric v1; lifecycle; then the CLI adapter after its gates. | All activation gates pass; a failure is shown honestly; every grading names its submission. |
| **6. Presentation and exports** | `slides` with its contract; Markdown prose; EPUB later. | Each view meets its contract in the table above. |

Each increment that changes a decision gets an ADR. ADRs 6 (framework/course/state), 7 (the course schema, reopened), 8 (the `school` skill and who invokes whom) and 9 (the learning record, enforced by the database) are written; still to come are views (10), bindings (11) and the sidecar (12).

The first usable milestone is the whole loop working once: a saved attempt, a deliberate later review, usable feedback, and a teaching decision that names the evidence it used.

## Future directions

Possibilities, not proposals. Each is built only if real use shows a need for it.

- **Spaced-repetition scheduling.** Replace the teacher's manual choice with a schedule computed from the history. This is ordinary TypeScript work; it does not require moving to Rust.
- **A newcomer reconstruction test.** Give a separate evaluator *only* the learner's explanation and a description of the audience. Ask what it understood, which terms were undefined and which connections it had to guess. A grader that knows the whole corpus may fill those gaps silently. It is still a simulation; occasional tests with real people remain necessary.
- **Boundary exercises.** "Give an example where this analogy helps, then where it misleads." "Change one assumption: which conclusion no longer follows?"
- **Calibration set.** A fixed set of explanations (clear, jargon-heavy, fluent but wrong, incomplete, appropriately uncertain), graded again whenever the model or rubric changes.
- **Objective labels, grading appeals, teacher decision notes.** Link activities that test the same skill; let the learner flag a grading and attach a correction; record why each review item returned.
- **Talks built from lessons.** Lessons that have exposed where an explanation trips people up become the slides for real talks about AIΩN.
- **More subjects.** Nothing in the server is specific to AIΩN; this is now ADR 6's decision rather than a future direction.

## Review log

- **Revision 1** (2026-11-18): first draft.
- **Revision 11** (2026-11-22): the rest of the external review's code findings. One guard on every `POST /api/*` (JSON only, cross-site refused). Static files are served only if their resolved path stays inside the mount, and never a directory. Malformed percent-encoding is a 400. A course with no `lessons/` lists none. Plain-text lesson fields (`subtitle`, `q`, `prompt`, `model`) and lesson errors are escaped; only `html` blocks carry markup. Config containment resolves symlinks and covers `DB_PATH`. `compose.yaml` names no course. Dark shadows apply however dark is chosen.
- **Revision 10** (2026-11-22): an external review found that an interrupted migration could null every answer's course, encounter, choice and submission. The version was written after the data transaction, so a crash in between sent a current-shaped database down the v2 rebuild, and `DROP TABLE` fires no triggers. The version is now written inside the transaction, the dispatch is an exhaustive `switch` on the shape on disk, and a database from a newer School is refused. Legacy and v2 `views` tables now gain `course`.
- **Revision 9** (2026-11-21): **3b is done.** The learner required that progress is never lost and lives in School's SQLite database. [ADR 9](../adr/0009-the-learning-record-is-enforced-by-the-database.md) puts the record's rules in the database: append-only triggers, correctness and first try derived inside the INSERT from the stored snapshot, and server-side encounter resumption. Postgres with database functions was considered and left open.
- **Revision 8** (2026-11-21): increment 3 is split into three issues, flyingrobots/school#1–#3. **3a is done:** reference cycles are rejected at load, choices have stable ids, and a broken lesson set falls back to the last valid one. Corrected the schema version in the current state (it is 4, not 3).
- **Revision 7** (2026-11-21): **rollout increment 2 is done.** The framework takes its course, state and source mounts from configuration, so a second course needs no code change — proven with two unrelated courses. The AIΩN course and the learner's private state are now their own repositories and this one is framework only. Settling ADR 7 proved unnecessary to get here, which is itself evidence that a course file needs less than revision 4 assumed.
- **Revision 6** (2026-11-21): **rollout increment 1 is done.** The destructive migration is gone, replaced by `server/migrate.ts` with its evidence gate met by tests against a populated legacy database rather than the empty one on disk. `migrate.ts` was also added to `server/.dockerignore` and the Dockerfile `COPY`, which is the same allowlist trap that broke the image before.
- **Revision 5** (2026-11-21): the learner settled the two questions that were blocking. The skill is `/school`; the **server** invokes an agent, not the reverse, and only for subjective grading and preparing future lessons; objective items are graded by the server with no model involved; and lesson renderings are prepared ahead of time, retained, and replayable with no agent running ([ADR 8](../adr/0008-the-school-skill-and-who-invokes-whom.md)). That answers open question 1: agents may write lesson content under the retention rule. Terminology brought in line with the [glossary](../glossary.md) — "lesson pack" is a **course**, and a course declares lessons rather than shipping renderings. ADR 7 is reopened, since a server that plays prepared lessons needs far less in a course file.
- **Revision 4** (2026-11-21): the learner corrected what School is. It is a subject-agnostic framework; the AIΩN series was the test case that built it, not its purpose. Courses become their own public git repositories ([ADR 6](../adr/0006-separate-framework-lessons-and-learner-state.md)) and the course format gets a declared schema ([ADR 7](../adr/0007-course-schema-in-graphql-compiled-by-wesley.md)), with learner state private and outside the course. Added the separation increment, two problems, the format-version identity, and open questions 3 and 4. ADRs 2–5 are amended accordingly. Terminology here was superseded by revision 5.
- **Revision 3** (2026-11-21): reconciled against the full text of the same external review, checked row by row rather than recalled. Re-measured the current state against commit `22e5411`; recorded the Dockerfile fix and the `.dockerignore` cause behind it; tightened proposal 2b to displayed values; added the [reconciliation table](#review-reconciliation). Wrote down four things that existed only in captured session transcripts: how lessons are planned, the undetected reference cycles, the unverified tailnet route, and the still-live destructive migration. Those transcripts were removed from this repository and its history on 2026-11-21, so this RFC is now their only record. Also normalised machine-specific paths across the workspace to repo-root-relative ones (`../aion` for the sibling papers checkout), keeping only the two that are verbatim historical quotes: the original `/teach` request above and the broken `file://` URLs in ADR 5's problem statement.
- **Revision 2** (2026-11-18): revised after an external review that returned *changes required*. It added the learning record contract, the preserving migration, the definition of first try, idempotent submissions, the grading lifecycle and rubric, binding snapshots, the sidecar activation gates and the view contracts. It replaced the ban on generated content with a retention rule, and closed the Markdown question. The Bun claim was verified locally; the Claude Code documentation claims were taken from the review and not checked here.

## Open questions

Question 2 gates the CLI adapter only. Questions 3 and 4 block increment 2. Increment 1 waits on none of them.

1. **Answered 2026-11-21 — "false" rejected the rule, not just the mechanism.** Agents do prepare lesson content, and they grade subjective answers. The blanket prohibition is gone; the retention rule replaces it — anything generated is prepared ahead of time, stored as a revision, and recorded in the snapshot of every encounter that shows it, on the same terms as authored content. See [ADR 8](../adr/0008-the-school-skill-and-who-invokes-whom.md).
2. **Does the subscription permit automated use through its CLI?** The CLI supports non-interactive mode; whether the learner's plan allows this wrapper must be checked before enabling the CLI adapter.
3. **Answered 2026-11-21.** The skill is `/school`. A person runs it to author or extend a course; the server invokes an agent for subjective grading and for preparing future lessons. Taking an already-prepared lesson needs no agent. See [ADR 8](../adr/0008-the-school-skill-and-who-invokes-whom.md).
4. **Does a course file need a schema language at all, and if so which?** Now that the server only plays prepared lessons, a course file may carry little more than the sequence, the assessment items and the block structure. The learner wants text, diffable, with binary assets referenced by path. Wesley gives a deterministic format hash and a CI breaking-change gate but emits no JSON instance validator; JSON Schema validates instances natively but hand-rolls versioning. Blocks increment 2. See ADR 7.
5. **Answered:** the sidecar stays typed around grading and lives in this repository until a second real consumer exists.
6. **Answered, and done:** this workspace became a git repository on 2026-11-21 (commit `22e5411`), published as `flyingrobots/school` under Apache 2.0. The rest of increment 1 — the preserving migration — is not done.
