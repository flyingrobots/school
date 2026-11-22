# School

A framework for learning something properly, with an AI teacher that adapts to evidence of what you have actually learned.

The organizing idea is one sentence: **the next lesson responds to evidence from the previous one.** Not "did you open the page" — whether you answered correctly, whether you still could a week later without help, and whether you could explain it to someone else. School records that evidence so the teacher has something real to plan from.

It aims at long-term retention rather than the feeling of having covered something. Answering correctly today is weak evidence; still knowing it next month is the goal, and getting there means practice that is harder in useful ways — retrieval, spacing, interleaving.

## Status

**Early, and not usable yet.** Be warned:

- The design is in [RFC 1](docs/rfc/0001-school.md). It is a **draft and has not been accepted**, and two of its open questions are unanswered.
- The server serves a configured course: its index, lessons, reference documents and any source material it cites. Verified against two unrelated courses with no code changes between them.
- **Progress is kept in the SQLite database and is append-only.** Every answer names what was shown and where. The database refuses to update or delete one, and a reload or a server restart resumes where the learner left off ([ADR 9](docs/adr/0009-the-learning-record-is-enforced-by-the-database.md)).
- **Lesson *conversion* is unfinished.** Lessons must be block JSON; the AIΩN course's lessons are still the static HTML that predates the format, so that course serves an empty lesson list until increment 3 converts them.
- The AIΩN Foundations Series has moved to its own repository as the first course, alongside a private learner-state directory. This repository is now framework only.

Nothing here is stable. There are no releases.

## Running it

No install step, no `package.json` — [Bun](https://bun.com) runs the TypeScript directly (ADR 2).

```sh
SCHOOL_COURSE=/path/to/a-course \
SCHOOL_STATE=/path/to/your-state \
SCHOOL_MOUNTS="papers=/path/to/source-material" \
  bun server/server.ts
```

| Variable | Meaning |
| --- | --- |
| `SCHOOL_COURSE` | The course to serve. Omit it and the index says so rather than crashing. |
| `SCHOOL_STATE` | Where **your** answers and progress go. Must not be inside the course; the server refuses to start if it is. |
| `SCHOOL_MOUNTS` | `name=path` pairs, served read-only at `/name/...`, for source material a course cites. |
| `HOST`, `PORT` | Default `127.0.0.1:4747`. |
| `SCHOOL_GRADER` | `anthropic` or `openai-compatible` to grade written explanations. Unset, explanations are saved but not graded. |
| `SCHOOL_GRADER_URL`, `SCHOOL_GRADER_MODEL`, `SCHOOL_GRADER_API_KEY` | The grader's endpoint, model and key. For `anthropic` they default to `https://api.anthropic.com`, `claude-opus-5-5` and `ANTHROPIC_API_KEY`. The key is never stored or logged. |
| `SCHOOL_GRADER_TIMEOUT_MS` | Default 120000; at most 240000. |

`bun test` runs the suite. `server/compose.yaml` runs it in Docker behind `tailscale serve` (ADR 4); copy `server/compose.example.env` to `server/.env` and set your course, state and source paths first.

## How it is put together

Four parts, kept deliberately separate, because they have different audiences and opposite privacy needs:

| Part | What it is | Visibility |
| --- | --- | --- |
| **The framework** | This repository: the server, the block model, the renderers, the shared components. Subject-agnostic — it renders, records and runs assessments without knowing what any course is about. | public |
| **The School skill** | The agent-side teacher: interviews for a mission, works out what to teach next, authors courses, generates each lesson. | public |
| **A course** | Its own git repository: objectives, a sequence of lessons, quizzes, exams, reference documents, resources, a glossary, components. Shareable — that is the point. | public |
| **Learner state** | One person's mission, notes, learning records, answers, gradings and position. Never written into a course. | **private** |

Two distinctions do most of the work:

- **A lesson is declared; a lesson rendering is generated.** A course declares what lesson 3 teaches. The page you actually read is built for you, from that declaration plus what you have already shown you know.
- **Declared for measurement, generated for practice.** Practice questions inside a lesson may be generated. A quiz or an exam is declared in the course and identical for everyone, or its results mean nothing across two learners.

The [glossary](docs/glossary.md) is the authority on these terms. It exists because we crossed these wires more than once.

## Design documents

- [Glossary](docs/glossary.md) — the vocabulary. Read this first.
- [RFC 1: School](docs/rfc/0001-school.md) — the whole design, including the learning record contract. Draft.
- [ADRs](docs/adr/) — the decisions, in order, with what each one cost.

## Credit

School started from the [`teach` skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/teach) in **[Matt Pocock](https://github.com/mattpocock)**'s [skills repository](https://github.com/mattpocock/skills). Thank you — that skill is where this whole idea came from.

To be clear about the relationship: School is **not** a fork or an extension of it, and no code was taken from it. What carries over is the teaching model — grounding every lesson in a stated mission, drawing knowledge from high-trust sources rather than an agent's memory, building skills through tight feedback loops, aiming at the zone of proximal development, and separating fluency from storage strength. School then adds what that skill has no notion of: courses you can share, quizzes and exams, and a server that records what actually happened. Go read the original; it is good, and it is useful on its own.

That skill is MIT licensed. This project is Apache-2.0.

## License

[Apache-2.0](LICENSE).
