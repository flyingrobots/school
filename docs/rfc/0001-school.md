# RFC 1: School, a personal learning system built with an AI teacher

- **Status:** Draft, revision 2. Agent-written; revised after an external review. Not yet accepted.
- **Date:** 2026-11-18
- **Describes:** the working tree of `~/git/school` on 2026-11-18. The folder is not under version control yet, so there is no commit to cite.
- **Builds on:** ADRs 1–5 in `docs/adr/`
- **Decision requested:** agree on [the concept](#the-concept), accept the [learning record contract](#the-learning-record-contract), accept, amend or reject each of the four [proposals](#proposals), and answer the [open questions](#open-questions).

## The concept

School is a personal course that one learner and an AI teacher build together, one lesson at a time. The teacher plans and writes the lessons. The learner takes them on any device and practises. School records how each practice went, so **the next lesson responds to evidence from the previous one**.

It is not a course platform, and it does not publish content. It has one learner, its lessons are written for one specific goal, and it runs on the learner's own machine.

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

In this workspace the learner is the author of the AIΩN Foundations Series. Their goal is to explain the series to other people, so they asked to be taught it from zero, the way a newcomer would meet it (`MISSION.md`, `learning-records/0001-author-learning-as-newcomer.md`).

The skill's lessons are static HTML files. After Lesson 2 the learner asked, "wait, you can't see my quiz results?" The teacher couldn't: answers stayed in the browser and were lost. That gap led to the server (ADR 1), and the rest followed from using it:

1. A local server records answers and views in SQLite (ADRs 1–3).
2. The learner wanted to study on their phone, away from home, so the server runs in Docker on their Mac and is reachable only over their Tailscale network (ADRs 4–5).
3. Answers keyed by question position break when a lesson is edited, so the learner proposed building lessons from **blocks**: data plus a render function, d3-style, with the page itself as the root block (proposal 1).
4. Blocks raised two more ideas: the same lesson shown in different ways for a phone, a presentation or an e-book (proposal 3), and blocks whose data comes from different sources (proposal 2).
5. The explanation exercise had no automatic feedback, so the learner proposed connecting local LLM agents through a service on the host (proposal 4).

### How it is used

One study session goes like this:

1. **The teacher plans.** The learner runs `/teach` in `~/git/school`. The teacher reads `MISSION.md` and the learning records, and queries `progress.db` for recent results. It writes the next lesson, aimed just past what the learner can already do, with claims citing the papers. The lesson includes at least one activity from an earlier lesson, chosen by the teacher, as delayed practice.
2. **The learner studies, anywhere.** They open the lesson on a phone or laptop through the tailnet, answer quizzes with immediate feedback, and write or dictate a 30-second explanation.
3. **School records.** Each submission is stored with the content the learner actually saw and the encounter it belonged to (see [the learning record contract](#the-learning-record-contract)).
4. **The teacher adapts, and says why.** The next plan names the recorded attempts that caused each review item to return, so the learner can disagree with the reasoning.

Lessons, reference sheets and the papers are served read-only. Content changes come from the teacher, as file edits.

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

Checked on 2026-11-18 by reading the files and running the server against a scratch database.

| Item | Observed |
| --- | --- |
| Running container | `server-school-1` is up, serving `127.0.0.1:4747`, built from the pre-block `server.ts` (ADR 4). `GET /` returns 200. |
| `progress.db` | `user_version` 0. `answers`: 0 rows. `views`: 0 rows. The old server is still accepting answers, so this count can change. |
| Block model | `server/blocks.ts`: block types `page`, `section`, `prose`, `card`, `quote`, `aside`, `quiz`, `explain` and `nest`; `{ "ref": id }` reuse; duplicate IDs and unknown refs throw `BlockError`. Cycles are not detected. |
| Renderers | `server/render.ts`: views `web` and `slides`, with an exhaustive `switch`. |
| Server on disk | `server/server.ts` loads `lessons/*.json`, renders `/lessons/:id?view=`, and migrates the schema to version 2 by dropping and recreating `answers`. |
| Quiz client | `assets/quiz.js` sends the selected choice's *text*, and computes `firstTry` from a counter that resets on every page load. |
| Lessons | Only `0001-the-inversion.html` and `0002-warp-graphs.html` exist. No `.json` lessons. |
| Markdown | Bun 1.4.4 provides `Bun.markdown.html`. Raw HTML in the input passes through unescaped (`"# hi <b>x</b>"` renders `<h1>hi <b>x</b></h1>`). |

Smoke test of the on-disk server (`PORT=4799`, scratch `DB_PATH`):

```text
GET /                                  -> 200, index with an empty lesson list
GET /lessons/0001-the-inversion        -> 404
```

Problems that block a rebuild:

1. `server/Dockerfile` copies only `server.ts`; the new server imports `blocks.ts` and `render.ts`. *(Inferred from the Dockerfile; not rebuilt.)*
2. No lesson is in block form, and `lessons/` is no longer served as static files, so every lesson would return 404.
3. `render.ts` links `/assets/slides.css` and `/assets/slides.js`, which do not exist.
4. **The version-2 migration drops `answers`.** Increment 1 of the [rollout](#rollout) replaces it with a preserving migration before anything is rebuilt.

## The learning record contract

This section is the core of the RFC. It applies to every proposal.

> Every accepted submission identifies enough retained content and encounter context to recover the activity the learner actually answered.

### Identities

| Identity | Answers | How School provides it |
| --- | --- | --- |
| Block | Which reusable activity is this? | Block `id`, stable for the block's meaning |
| Content revision | What exactly was shown? | A content hash of the resolved lesson, stored once in a `snapshots` table keyed by hash |
| Encounter | In which lesson or review did this happen? | An `encounters` row created when a page is served: lesson, view, snapshot hash, time |
| Submission | Which answer did the learner give? | A client-generated UUID, unique in the database |
| Grading | Which judgment of that submission is this? | A `gradings` row referring to one submission |

One stored snapshot per distinct resolved lesson covers both the content revision and anything dynamic bindings selected (see proposal 2). A git commit is not enough on its own, because the server may serve working-tree bytes that differ from any commit.

### Rules

- **Choices have stable IDs.** Each quiz choice carries an `id`. A submission records the choice ID. With the snapshot, that is enough to recover the exact wording and position the learner saw. Reordering or rewording choices never reinterprets old answers.
- **First try means the first response to a block within one encounter.** The full history is kept, so the first answer ever can also be derived. A page reload during the same encounter does not reset it; the server, not the browser, decides.
- **Retries are not answers.** Submitting the same submission UUID twice stores one row. A learner trying again creates a new UUID.
- **Assistance is recorded.** If an encounter shows a hint or reveals a model answer before a submission, the submission records that, and it is not counted as unaided.
- **Time on page is not thinking time.** `ms` is kept as a raw measurement and is not used as a measure of effort, because a phone tab can be interrupted.
- **Corrections are additions.** A flawed activity can be marked as unsuitable for progress estimates; its answers stay.

Acceptance scenario: today the learner answers a block wrong, then right. Next week the block appears in another lesson and they answer it right first time, and the phone sends that last answer twice. School stores **three** submissions in **two** encounters. The later one is a first-try success.

### Block definitions

The loader validates the whole lesson set before serving it, and keeps serving the previous valid set if validation fails. It rejects:

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

- Lesson files, rubrics and grading prompts live in git. Learner records live in `progress.db`, which is backed up separately.
- A block keeps its `id` only while its meaning is unchanged. Changing what a quiz tests means a new block.

### 2. Data bindings

These are two separate decisions.

**2a. Markdown: accept.** Prose blocks may use an `md` field, rendered with `Bun.markdown.html`. The API is marked unstable, so the Bun version stays pinned (ADR 4) and a test covers the markup we rely on. Lesson Markdown is trusted, because the teacher wrote it and it is in git. Learner text and model text are **never** rendered as Markdown or HTML; they are shown as escaped plain text. Exercises keep typed fields, not Markdown.

**2b. Dynamic review: start with one named selector.** Instead of general SQL in lesson files, add a `review` block bound to one built-in operation, `due-review`. It returns a bounded list of block IDs (at most `limit`, in a fixed order) chosen from first-try misses and time since the last encounter. If the selector fails, the block says so and the rest of the page renders. The selected blocks become part of the encounter's snapshot, so a later database change cannot alter what an answer refers to.

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
| **1. Preserve the foundation** | `git init`. Replace the version-2 migration with one that runs in a transaction, copies old answers into the new schema and marks them `legacy` with their original question position, prompt and choice text. Back up `progress.db` before migrating. | Against a small *populated* legacy database: every old answer is present with its original meaning; a restore from the backup works; the migration is idempotent. |
| **2. One web lesson** | Fix the Dockerfile; convert Lesson 1; add `encounters`, `snapshots`, choice IDs and submission UUIDs; validate the lesson set at load. | The rebuilt container serves Lesson 1, and one answer row identifies its snapshot, encounter, block, choice and submission. HTTP 200 alone is not evidence. |
| **3. Reuse and delayed practice** | Convert Lesson 2 with a `ref` to a Lesson 1 quiz; teacher-chosen review; the `due-review` selector. | The acceptance scenario above produces three submissions in two encounters, with correct first-try values. |
| **4. Explanation feedback** | Sidecar with the local adapter first; rubric v1; lifecycle; then the CLI adapter after its gates. | All activation gates pass; a failure is shown honestly; every grading names its submission. |
| **5. Presentation and exports** | `slides` with its contract; Markdown prose; EPUB later. | Each view meets its contract in the table above. |

Each increment that changes a decision gets an ADR: blocks and the record contract (6), views (7), bindings (8), the sidecar (9).

The first usable milestone is the whole loop working once: a saved attempt, a deliberate later review, usable feedback, and a teaching decision that names the evidence it used.

## Future directions

Possibilities, not proposals. Each is built only if real use shows a need for it.

- **Spaced-repetition scheduling.** Replace the teacher's manual choice with a schedule computed from the history. This is ordinary TypeScript work; it does not require moving to Rust.
- **A newcomer reconstruction test.** Give a separate evaluator *only* the learner's explanation and a description of the audience. Ask what it understood, which terms were undefined and which connections it had to guess. A grader that knows the whole corpus may fill those gaps silently. It is still a simulation; occasional tests with real people remain necessary.
- **Boundary exercises.** "Give an example where this analogy helps, then where it misleads." "Change one assumption: which conclusion no longer follows?"
- **Calibration set.** A fixed set of explanations (clear, jargon-heavy, fluent but wrong, incomplete, appropriately uncertain), graded again whenever the model or rubric changes.
- **Objective labels, grading appeals, teacher decision notes.** Link activities that test the same skill; let the learner flag a grading and attach a correction; record why each review item returned.
- **Talks built from lessons.** Lessons that have exposed where an explanation trips people up become the slides for real talks about AIΩN.
- **More subjects; a general School for `/teach`.** Nothing in the server is specific to AIΩN.

## Review log

- **Revision 1** (2026-11-18): first draft.
- **Revision 2** (2026-11-18): revised after an external review that returned *changes required*. It added the learning record contract, the preserving migration, the definition of first try, idempotent submissions, the grading lifecycle and rubric, binding snapshots, the sidecar activation gates and the view contracts. It replaced the ban on generated content with a retention rule, and closed the Markdown question. The Bun claim was verified locally; the Claude Code documentation claims were taken from the review and not checked here.

## Open questions

1. **What did "false" reject?** The learner answered "false" to the rule that LLMs grade but never supply content, then described the sidecar. Revision 2 assumes: the sidecar grades first, and generated content is allowed later if it is reviewed and kept as a revision. Confirm or correct this.
2. **Does the subscription permit automated use through its CLI?** The CLI supports non-interactive mode; whether the learner's plan allows this wrapper must be checked before enabling the CLI adapter.
3. **Answered:** the sidecar stays typed around grading and lives in this repository until a second real consumer exists.
4. **Answered:** `~/git/school` becomes a git repository in rollout increment 1.
