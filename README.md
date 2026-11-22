# School

A framework for learning something properly, with an AI teacher that adapts to evidence of what you have actually learned.

The organizing idea is one sentence: **the next lesson responds to evidence from the previous one.** Not "did you open the page" — whether you answered correctly, whether you still could a week later without help, and whether you could explain it to someone else. School records that evidence so the teacher has something real to plan from.

It aims at long-term retention rather than the feeling of having covered something. Answering correctly today is weak evidence; still knowing it next month is the goal, and getting there means practice that is harder in useful ways — retrieval, spacing, interleaving.

## Status

**Early, and not usable yet.** Be warned:

- The design is in [RFC 1](docs/rfc/0001-school.md). It is a **draft and has not been accepted**, and two of its open questions are unanswered.
- The server runs and serves its index and assets, but **does not serve lessons yet**: the block migration is unfinished, so `/lessons/<id>` returns 404.
- There is a known destructive schema migration still on disk (`server/server.ts:19`). It is harmless only because the database is empty.
- The AIΩN Foundations Series currently sits in this repository as the course the framework was built against. It is meant to move into its own repository; until it does, this repo contradicts its own architecture.
- Terminology in ADRs 6 and 7 predates [the glossary](docs/glossary.md) and needs a pass.

Nothing here is stable. There are no releases.

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
