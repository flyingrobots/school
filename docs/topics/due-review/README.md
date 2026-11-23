# Due review

Reference: how School brings an earlier quiz back for delayed review, and says why
(RFC 2 §5; flyingrobots/school#32).

A correct answer with no recorded aid, given after a delay, is the strongest evidence School can
hold. Due review collects it: when the learner opens a lesson, quizzes from elsewhere in the course
that need another look come back at the top of it, each with its reason.

## The rule

`school.due_review(course, blocks, at, delay_ms, limit)` in `server/db/migrations/0006_due_review.sql`
is the rule. It reads only, and orders everything by `seq`, never by `at`. `at` is read only to
measure how long ago something happened.

It considers the quiz blocks it is given (`blocks`) and their answers in the course's encounters.
An **episode** is one encounter's answers to one block. Its first try is the answer the record
marked `first_try`. An episode is **weak** when its first try was:

| First try | Rule |
| --- | --- |
| Wrong | `due-review/wrong-first-try` |
| Right, after help shown for the block in that encounter (an exposure with a smaller `seq`) | `due-review/aided-first-try` |
| Right, in an encounter opened without aid tracking, so its aid is unknown | `due-review/unknown-aid` |

Otherwise the episode is **clean**: right, with no recorded aid.

A block is **due** when both of these hold:

- No clean episode follows its latest weak episode at least `delay_ms` after that weak episode's
  last answer. A right answer a minute after a wrong one is memory, not review, so it does not
  clear the block. A right answer with unknown aid is never clean, so it never clears one.
- Its latest answer, in any encounter, was at least `delay_ms` before `at`.

Due blocks come back ranked: wrong first tries, then aided, then unknown aid. Within a rule, the
oldest first try comes first. At most `limit` come back.

The core asks with `REVIEW_DELAY_MS`, twenty hours, so a quiz from one day's study comes back the
next day even if the learner sits down a little earlier. It also passes `REVIEW_LIMIT`, three
(`server/core/school.ts`). The blocks it asks about are the course's quizzes as served now, less
the ones already in the lesson being opened. A block the course no longer has is never shown.

Explain blocks are not selected: this rule reads quiz answers only.

## What each item cites

Each item names the rows that chose it, by `seq`, at most 100:

| Rule | Evidence |
| --- | --- |
| Wrong first try | The episode's answers up to and including its first right one (all of them if none was right), and the block's exposures in that encounter before the last of those |
| Aided first try | The block's exposures in that encounter before the first try, and the first try |
| Unknown aid | The encounter, whose row records that aid was not tracked, and the first try |

The item also carries the facts its reason is written from. `answeredAt` is the time of the first
try that decided it. `corrected` says whether a later answer in that encounter was right.
`shown` lists the kinds of help among the evidence, each once. `lastSeen` is the time of the
block's latest answer.

## The reason, in words

`reviewReason` (`server/core/school.ts`) writes each reason from those facts. The day is the
answer's, in the server's time zone (`TZ`):

| Facts | Reason |
| --- | --- |
| Wrong, then right after help | Back because your first answer on 21 November was wrong, and the right one came after the explanation was shown. |
| Wrong, then right on a later try | Back because your first answer on 21 November was wrong; you put it right on a later try. |
| Wrong, never put right | Back because your first answer on 21 November was wrong, and it was not put right then. |
| Aided | Back because on 21 November you answered it right only after a hint was shown. |
| Unknown aid | Back because on 21 November you answered it right while School was not recording the help it showed, so it cannot say whether you had any. |

Help is named as the page shows it: `feedback` is "the explanation", `model-answer` is "the model
answer", `hint` is "a hint" and `reference` is "a reference". Reasons are words, never scores.

## Placing the items

Model B (lessons prepared per learner) does not exist yet. Until it does, the items go at the top
of the lesson the learner opens, in a section with id `school:review` titled "Review". Authored
block ids may not start with `school:` (`server/blocks.ts`).

`School.openLesson` asks the selector, builds that page, and calls the port's `openLessonEncounter`,
which is `school.open_lesson_encounter`. It finds the encounter to resume by the **lesson as
written**: `encounters.lesson_hash` when School added review, or the snapshot's hash when it added
none, including every encounter opened before migration 0006. The resume rule is otherwise the
usual one: the same aid capture version, and activity within six hours.

- **On a resume,** what is shown now and the notes offered are ignored. The page is the encounter's
  snapshot, so a reload shows the review it opened with, even when the selector would now choose
  otherwise.
- **On a new encounter,** the page with its review is snapshotted like any content. Each item's
  decision note is stored for that block of this lesson and this encounter, citing its evidence, in
  the same transaction. A note the record refuses opens nothing.

The lesson API (`GET /api/courses/:course/lessons/:lesson`) returns that snapshot as `lesson`, and
`review` lists each item's `blockId`, `rule` and `reason`, read back from the encounter's notes. A
review quiz is answered in the encounter of the lesson that shows it. Its answer is not progress in
that lesson, whose own quizzes are what the course and home pages count. The slides view opens no
encounter and carries no review.

## Not yet

- **Flagged items.** RFC 2 §2 excludes a flagged item's answers from the evidence that drives
  review. Flags arrive with generated quizzes (RFC 2 step 3), and the record has none, so nothing
  is excluded yet. The [test plan](test-plan.md) holds the case.
- **FSRS.** A spaced-repetition model can later replace this heuristic as a pure query over the
  same rows.

## Tests

Case by case, with the real test names: the [test plan](test-plan.md).
