# Due review

Reference: how School brings an earlier quiz back for delayed review, and says why
(RFC 2 §5; flyingrobots/school#32).

A correct answer with no recorded aid, given after a delay, is the strongest evidence School can
hold. Due review collects it: when the learner opens a lesson, quizzes from elsewhere in the course
that need another look come back at the top of it, each with its reason. A quiz needs another look
when its latest first try was weak, or when it had settled and its [mastery](../mastery/README.md)
has since faded.

## The rule

`school.due_review(course, blocks, at, delay_ms, limit)` in `server/db/migrations/0006_due_review.sql`
is the rule, as migration `0012_ai_help.sql` replaced it to read help for a whole encounter, and
migration `0014_faded_review.sql` replaced it to add the faded rule. Each replacement kept its
signature, result, volatility and grant. It reads only, and orders everything by `seq`, never by
`at`. `at` is read only to measure how long ago something happened.

It considers the quiz blocks it is given (`blocks`) and their answers in the course's encounters.
An **episode** is one encounter's answers to one block. Its first try is the answer the record
marked `first_try`. An episode is **weak** when its first try was:

| First try | Rule |
| --- | --- |
| Wrong | `due-review/wrong-first-try` |
| Right, after help shown for the block, or for the whole encounter, in that encounter (an exposure with a smaller `seq`) | `due-review/aided-first-try` |
| Right, in an encounter opened without aid tracking, so its aid is unknown | `due-review/unknown-aid` |

Otherwise the episode is **clean**: right, with no recorded aid.

A block is **due** when both of these hold:

- No clean episode follows its latest weak episode at least `delay_ms` after that weak episode's
  last answer. A right answer a minute after a wrong one is memory, not review, so it does not
  clear the block. A right answer with unknown aid is never clean, so it never clears one.
- Its latest answer, in any encounter, was at least `delay_ms` before `at`.

Due blocks come back ranked: wrong first tries, then aided, then unknown aid. Within a rule, the
oldest first try comes first. At most `limit` come back.

### Faded quizzes

A quiz none of those three rules chose may still come back as `due-review/faded` (RFC 5 §4.6). It
is faded when all of these hold, reading its `school.mastery` row at `at`:

- It is **settled**: no weak episode, or one cleared as above. A quiz still held by a weak rule is
  never faded, so a quiz both weak and low in strength comes back once, under its weak rule.
- Its **strength** is below one half: a whole stability has passed since the right first try that
  last refreshed it. A clean answer's stability is one day, and each clean answer given at least
  `delay_ms` after the last grows it by 2.5 ([mastery](../mastery/README.md)).
- Its latest answer, in any encounter, was at least `delay_ms` before `at`, as for the other rules.

Faded quizzes come after every weak one, lowest strength first, then by the `seq` of the first try
that refreshed them. They take only the places the weak ones leave of `limit`, and
`school.mastery` is not read at all when the weak ones fill it.

So a quiz answered cleanly at 10:00 on 21 November comes back on 22 November after 10:00, and,
answered cleanly then, 2.5 days later (RFC 5 Table 4.3).

The core asks with `REVIEW_DELAY_MS`, twenty hours, so a quiz from one day's study comes back the
next day even if the learner sits down a little earlier. It also passes `REVIEW_LIMIT`, three
(`server/core/school.ts`). The blocks it asks about are the course's quizzes as served now, less
the ones already in the lesson being opened. A block the course no longer has is never shown.

Explain blocks are not selected: this rule reads quiz answers only.

### Help for the whole encounter

Help a model writes is the general case of "a model showed the learner more" (RFC 6 §5.1). When
School shows the learner text a model wrote in answer to the learner's request for help with a
lesson, the server records one exposure of kind `ai-help` for the whole encounter, with no block,
before the model is asked. It counts as help shown for every quiz and explain block of that
encounter: a first try after it is aided, whichever block it answers, and a first try before it is
not. Help in one encounter aids nothing in another. Explain mode, and any later model-written help,
use the same rule.

`school.record_lesson_help` stores it, on the server only: `POST /api/exposure` refuses the kind. An
encounter without aid tracking refuses it, because its answers are already unknown aid. The rule
errs toward marking aid: one question in a lesson of five quizzes brings up to five items back.

## What each item cites

Each item names the rows that chose it, by `seq`, at most 100:

| Rule | Evidence |
| --- | --- |
| Wrong first try | The episode's answers up to and including its first right one (all of them if none was right), and the block's and the whole encounter's exposures in that encounter before the last of those |
| Aided first try | The block's and the whole encounter's exposures in that encounter before the first try, and the first try |
| Unknown aid | The encounter, whose row records that aid was not tracked, and the first try |
| Faded | `school.mastery`'s evidence: the first try of the episode its stability counts from, each spaced clean first try it counted, and the latest right first try |

The item also carries the facts its reason is written from. `answeredAt` is the time of the first
try that decided it; for a faded quiz, the time of the right first try that last refreshed it
(mastery's `refreshedAt`). `corrected` says whether a later answer in that encounter was right; it
is false for a faded quiz. `shown` lists the kinds of help among the evidence, each once; a faded
quiz's is empty. `lastSeen` is the time of the block's latest answer.

## The reason, in words

`reviewReason` (`server/core/school.ts`) writes each reason from those facts. The day is the
answer's, in the server's time zone (`TZ`):

| Facts | Reason |
| --- | --- |
| Wrong, then right after help | On 21 November, the explanation helped you find this one. It's back so you can answer it from memory. |
| Wrong, then right on a later try | On 21 November, you found this one on a second go. It's back so you can answer it from memory. |
| Wrong, never put right | On 21 November, this one hadn't settled yet. It's back for a fresh look. |
| Aided | On 21 November, a hint helped you find this one. It's back so you can answer it from memory. |
| Aided by help for the whole encounter | On 21 November, asking about the lesson helped you find this one. It's back so you can answer it from memory. |
| Unknown aid | On 21 November, you found this one while School wasn't noting the help it showed. It's back so you can answer it from memory. |
| Faded | On 21 November, you found this one from memory. Some time has passed: how does it feel now? |

The reasons are written in [School's voice](../voice/README.md): they say what helped, never what
was wrong. A faded quiz's reason recalls the clean answer and asks a question; it never says the
learner lost anything, and it names no strength.

Help is named as the page shows it: `feedback` is "the explanation", `model-answer` is "the model
answer", `hint` is "a hint", `reference` is "a reference" and `ai-help` is "asking about the
lesson". Reasons are words, never scores.

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
`review` lists each item's `blockId`, `rule` and `reason`, read back from the encounter's notes, and
`from`, the `id` and `title` of the lesson that holds the quiz now (`null` when no lesson holds it
any more), so the page can say where the question came from. A
review quiz is answered in the encounter of the lesson that shows it. Its answer is not progress in
that lesson, whose own quizzes are what the course and home pages count. The slides view opens no
encounter and carries no review.

## On the home page

`GET /api/review` runs the same selector for every served course over all its quizzes, now, and
returns each item with its course, the lesson holding the quiz, the question and its reason, so the
home page can show what is ready for another look (flyingrobots/school#165). `GET /api/activity`
projects it forward: for each of the next `days` days, how many quizzes first become due by then.
It counts every due quiz, not only the three a lesson shows. Faded quizzes reach the lesson's Review
section, the home page's list and the timeline through the same selector, with no change of their
own.

## Not yet

- **Flagged items.** RFC 2 §2 excludes a flagged item's answers from the evidence that drives
  review. Flags arrive with generated quizzes (RFC 2 step 3), and the record has none, so nothing
  is excluded yet. The [test plan](test-plan.md) holds the case.
- **FSRS.** A spaced-repetition model can later replace the mastery measure as a pure query over
  the same rows (RFC 5 §3).

## Tests

Case by case, with the real test names: the [test plan](test-plan.md).
