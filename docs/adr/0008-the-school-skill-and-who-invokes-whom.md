# 8. The `school` skill, and who invokes whom

Date: 2026-11-21 · Status: Accepted

## Context
Until now the assumption was that the agent drives: you run a teaching skill in some folder, it decides everything, and it writes the artifacts itself. An earlier draft of this ADR kept that direction and only moved the structure into the framework — the agent would call the framework to scaffold a course, then fill it in.

That is half the picture, and it has the direction wrong for the half that matters most. Authoring a course is agent-driven. **Taking** a course is not. A learner opening lesson 3 on their phone should not be waiting on a model, and should not need one running at all.

There is also a naming problem. The idea came from a skill called `teach` in someone else's repository ([credited in the README](../../README.md#credit)), and continuing to use that name would be both confusing and discourteous.

## Decision

### The skill is `school`
Invoked as `/school`. It is School's own skill, written for this framework.

### The server is required. An agent is not — at the moment of study
A lesson that has already been prepared is playable by the server alone. The server renders it, records every answer, and grades **objective items** — multiple choice and anything else with a declared correct answer — deterministically, with no model involved and no waiting.

This is what makes a shared course genuinely usable: someone who downloads a course and runs the server can take it.

### The server invokes the agent, not the reverse
For two jobs, and only these:

1. **Grading subjective answers.** Write-ins and explanations need reasoning to assess; there is no declared correct answer to compare against. Objective items never go to a model.
2. **Preparing future lessons.** From the learner's recorded performance, and from what they say they need or want.

### Preparation happens ahead of time
Lessons are prepared **before** the learner reaches them, stored, and then played without an agent. Nothing is generated at page load.

This is why [RFC 1](../rfc/0001-school.md)'s rejection of generation-on-every-load still holds: the objection was never to generation, it was to not keeping the result. A prepared lesson is retained, hashable, reviewable and replayable, exactly like an authored one.

### The skill's job is conformance
`/school` is what makes an agent's output meet School's standards rather than whatever that model would have produced unaided: the declared structure, the rubric, the citation requirements, the question-balancing rules. The framework is deterministic; the skill constrains the part that cannot be.

Authoring a course is also `/school`, run by a person writing or extending one.

## Alternatives
- **Agent drives everything** (the status quo, and the earlier draft of this ADR). Taking a lesson would require a live model, which makes a course unusable by anyone who only has the server, puts a model in the latency path of reading a page, and leaves nothing retained to attribute an answer to.
- **Generate each lesson on demand when the learner opens it.** Rejected: the learner waits on inference, an outage becomes a blocked lesson rather than a missing future one, and a page that differs on every load cannot be the thing an answer refers to.
- **Grade everything with a model, including multiple choice.** Rejected: it is slower, less reliable and less honest than comparing against a declared answer. A model's verdict on a question that has a known answer is strictly worse evidence.
- **Keep the name `teach`.** Rejected. It is another project's name.

## Consequences
- **This answers [RFC 1](../rfc/0001-school.md) open question 1.** Agents do prepare lesson content. The blanket prohibition is gone and the retention rule takes its place: anything generated is stored as a revision and recorded in the snapshot of every encounter that shows it, on the same terms as authored content.
- **The sidecar widens.** RFC 1 scoped it to grading only. It is now the server's bridge to an agent for grading *and* preparation. Its constraints and activation gates apply unchanged to both.
- **Grading splits by item type, and the two are different authorities.** A deterministic server grading of a declared answer and a model's judgment of an explanation are not the same kind of evidence, and the learning record contract must keep them apart. This strengthens RFC 1's existing principle that a submission, a grade and a teaching decision are separate records.
- A learner never waits on a model. Model failures degrade the *future* of a course, not the page in front of them.
- Prepared lessons are durable artifacts in learner state, not ephemeral renderings. They need storage, and they need the same content hashing as anything else an answer points at.
- The skill is version-coupled to the framework's rubric and schema. A newer skill writing against an older framework's structure will drift.
- The framework now needs a way to be *called from* the server (the sidecar) and a way to *call* a person's agent during authoring. Two different interfaces.

## Open
- How far ahead preparation runs: the next lesson, the next few, or the rest of the sequence.
- What a learner sees when they reach the end of what has been prepared and no agent is reachable. An honest "nothing prepared yet" is probably right, but it is a real state that needs designing.
- Whether a human author uses `/school` through the same sidecar interface the server uses, or directly in their own agent session.
- Whether subjective grading can be deferred indefinitely — a learner finishing an exam and getting an immediate objective score, with written answers graded later, is a sensible but unspecified behaviour.
