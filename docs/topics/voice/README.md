# School's voice

Reference: how School speaks to the learner, in the app and in the courses written for it. The
maintainer decided this on 2026-11-24 ([flyingrobots/school#161](https://github.com/flyingrobots/school/issues/161)).

## The rule

School is always encouraging or neutral. It invites; it does not command, grade the person, or
point at what went wrong. Results stay in words, never scores ([RFC 2 §4.3](../../rfc/0002-lessons-written-for-each-learner.md)).

## Words

| Say | Not |
| --- | --- |
| a draft, another draft | an attempt, a try, a retry |
| what helped: "the explanation helped you find this one" | what was wrong: "your first answer was wrong" |
| "on a second go" | "you put it right on a later try" |
| "hadn't settled yet" | "was not put right" |
| "Ready for another look" | "Back for review" |
| "Get back into it", then a question | "Explain …", "Describe …" |
| Meets, Partly, Not yet | pass, fail, a score |
| what would complete an idea | what is missing |

## In the app

- **Review reasons** (`reviewReason`, `server/core/school.ts`) say what helped and that the question
  is back to answer from memory; a faded quiz's recalls the day it was found from memory and asks
  how it feels now. Every reason is listed in [due review](../due-review/README.md#the-reason-in-words).
  A test asserts that none contains "wrong", "fail", "mistake", "incorrect", "forgot" or "attempt".
- **The lesson page** titles a review item's note "Ready for another look" ([lesson page](../lesson-page/README.md)).

Notes already in the record keep the words they were written with: the record is append-only.

## In a course

An explain block's `prompt` is a question the learner would want to answer, not an instruction:

| Write | Rather than |
| --- | --- |
| How would you explain the inversion to an engineer in under 30 seconds, with an example that isn't a bank account? | Explain the inversion to an imaginary engineer in under 30 seconds. Use one example that isn't the bank account. |
| How would you teach someone the plain hunt, so they could ring it with you? | Describe the plain hunt so someone could ring it with you. |

Constraints (a time limit, words to avoid) stay; they go inside the question.

## Not covered

The grader's notes come from the model and its prompt (`server/grade.ts`); this page does not
govern them yet.
