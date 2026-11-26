---
title: "RFC 5: Mastery that fades"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-26
updated: 2026-11-26
version: 0.1.0
status: "Proposal, awaiting the maintainer's decision. Answers flyingrobots/school#192. Builds on flyingrobots/school at commit 2f18da4."
---

# RFC 5: Mastery that fades

> **How to read this.** **Built** means it exists at commit `2f18da4`. **Proposed** means this RFC asks for it. **Open** means it needs the maintainer's decision. Nothing here is decided. How due review works today is in the [due review reference](../topics/due-review/README.md); this RFC describes only what would change.

## Executive Summary

The maintainer wants School to know that memory fades: a quiz answered cleanly last month is not known as surely as one answered cleanly this morning, and each clean answer given after a delay should make it last longer (flyingrobots/school#192). Today School has no such measure. A quiz answered right once counts as answered correctly forever, and due review brings back only quizzes whose latest first try was weak.

This RFC recommends **a per-quiz mastery measure with a half-life that grows**: a database function, `school.mastery`, reads the append-only record and returns, for each quiz at a given time, how long its memory lasts (its *stability*) and how much of it is left now (its *strength*, between 0 and 1). Strength halves each time one stability passes. The first right answer gives a stability of one day; each clean answer given at least the review delay after the one before multiplies it by 2.5. Help and unknown aid refresh the clock but not the growth. Due review gains one rule, ranked after the three it has, that brings back a quiz whose strength has fallen below one half. The number itself is never shown: the pages say it in words.

| Question from #192 | Recommendation |
| --- | --- |
| Which model: simple exponential decay, SM-2 intervals, or FSRS | Exponential decay with a growing half-life: two constants, computed in closed form in SQL, explainable in a sentence. Shaped as stability and strength, like FSRS, so FSRS can replace the update rule later behind the same function (§3, §4.1) |
| How aid and unknown aid lower the refresh | A clean answer after the delay restarts the clock and grows stability by 2.5 times. Unknown aid restarts the clock only. An aided first try restarts the clock and returns stability to one day. A wrong first try sets strength to 0 until the next right first try (§4.2) |
| How it is worded | In words, never numbers: **Holding**, **Ready for another look**, **Still settling**, **Not started yet**. A faded quiz's reason recalls the day it was found from memory and asks how it feels now (§4.7) |
| How far the due-review rule changes | One added rule, `due-review/faded`, ranked last and sharing the limit. The three existing rules, the function's signature and every existing test stay as they are (§4.6) |

_Table 0.1. The open questions in flyingrobots/school#192 and this RFC's recommendation for each. Every recommendation keeps the record append-only and every number derivable from it._

In short: one read-only function derives a fading measure from the record, due review uses it for one more reason to bring a quiz back, and the pages say it in School's voice.

## Contents

1. [The problem and who it serves](#1-the-problem-and-who-it-serves)
2. [Constraints](#2-constraints)
3. [Options](#3-options)
4. [Recommendation](#4-recommendation)
5. [Order of work](#5-order-of-work)
6. [Out of scope](#6-out-of-scope)
7. [Risks](#7-risks)
8. [Open questions](#8-open-questions)
9. [References](#9-references)

## 1. The problem and who it serves

School records every answer, but treats a clean answer as permanent. Three things are built, and none of them decays.

**Built:**

- `school.lesson_progress(course)` (`server/db/migrations/0001_init.sql`) returns, per lesson, the quizzes ever answered correctly there, in any encounter. The course page turns that into "2 of 3 quizzes answered correctly" and a check mark when all are done ([course page](../topics/course-page/README.md)). An answer from a year ago counts the same as one from today.
- `school.due_review(course, blocks, at, delay_ms, limit)` (`server/db/migrations/0006_due_review.sql`) brings back a quiz whose latest *episode* (one encounter's answers to one block) was weak: a wrong first try, a right first try after help, or a right first try with unknown aid. A clean episode at least `delay_ms` after the weak one clears it, and once cleared it never comes back. `REVIEW_DELAY_MS` is twenty hours and `REVIEW_LIMIT` three (`server/core/school.ts`).
- The home page's timeline (`GET /api/activity`, `activity` in `server/core/school.ts`) projects due review forward by calling the selector at each of the next fourteen days, and draws a ring for each day questions come back ([home page](../topics/home-page/README.md)).

The due review reference already names the gap: "A spaced-repetition model can later replace this heuristic as a pure query over the same rows" ([due review, Not yet](../topics/due-review/README.md#not-yet)).

| Who | What they need |
| --- | --- |
| The **learner** | To see which material is holding and which is ready for another look, and to be brought back to a quiz before it is gone, at growing intervals so review stays light |
| A **course author** | Nothing new to write: the measure is derived from quizzes they already declare |
| **Explain mode** (flyingrobots/school#191) | A definition of "demonstrated mastery" per quiz, lesson and course, as a database function, to pitch extra explanation to |

_Table 1.1. Who a fading mastery measure serves. The learner gains a reason to return to clean quizzes; explain mode gains the definition it is waiting on._

In short: the record already holds the evidence of when each quiz was last found from memory; nothing yet reads it as something that fades.

## 2. Constraints

Each option is weighed against these. They come from existing decisions, not from this RFC.

| # | Constraint | Source |
| --- | --- | --- |
| C1 | Every read is a Postgres function; the application role calls functions only | [RFC 3 §3.1](0003-postgres-functions-and-generated-types.md#31-privileges) |
| C2 | The record is append-only; nothing derived is stored as mutable state, so any number can be derived again from the rows | [ADR 9](../adr/0009-the-learning-record-is-enforced-by-the-database.md); flyingrobots/school#192 |
| C3 | Order is by `seq`, never by `at`; `at` is read only to measure elapsed time. No record function calls `now()`: the caller passes the time | [RFC 3 §3.4](0003-postgres-functions-and-generated-types.md#34-time-and-order) |
| C4 | The evidence is what School records: a quiz first try that is right or wrong, help shown before it (exposures), and whether aid was tracked at all. There is no "easy" or "hard" grade | `school.answers`, `school.exposures`, `encounters.aid_tracking` in `server/db/migrations/0001_init.sql` |
| C5 | Server grading and model grading are kept apart; an explanation's grade is not the same evidence as a quiz answer | The [glossary](../glossary.md), "Server grading and model grading" |
| C6 | School is encouraging or neutral; it invites with questions, never commands; results are words, never scores or percentages | [School's voice](../topics/voice/README.md); the [course page](../topics/course-page/README.md) ("never a percentage, a letter or a score") |
| C7 | Due review is a shared rule used by the lesson page, the home page's review list and the timeline; changing it changes all three | [due review](../topics/due-review/README.md) |
| C8 | One learner, so there is little history to fit parameters to, and nothing to fit them against until real study has run for months | [ADR 4](../adr/0004-docker-on-this-mac-behind-tailscale.md); flyingrobots/school#52 |

_Table 2.1. The constraints every option must meet. C2 and C4 rule out stored state and models that need graded ratings; C8 rules out anything that needs fitting before it works._

C4 and C8 matter most here. The published spaced-repetition models were built for flashcard apps where the learner rates each recall, and their parameters were fitted to millions of such ratings. School has a binary outcome plus an aid signal, for one person.

## 3. Options

Four options are weighed: no decay, exponential decay with a growing half-life, SM-2 intervals, and FSRS. Each is judged on whether it fits School's evidence and constraints, not on which is best in general.

### Option A: no decay

Keep `lesson_progress` and due review as they are. A clean answer stays clean.

| For | Against |
| --- | --- |
| No work; due review already collects the most valuable evidence, a clean delayed answer after a weak one | A quiz answered cleanly once is never seen again, which is fluency, not storage strength ([glossary](../glossary.md), "Fluency strength and storage strength") |
| Nothing new to explain | Gives flyingrobots/school#191 no measure to pitch to |

_Table 3.1. Option A, no decay. It keeps every constraint by not serving the issue._

Option A is the baseline the others are measured against.

### Option B: exponential decay with a growing half-life

Each quiz has a stability *S*, a half-life. Its strength at time *t* is 2^(−(*t* − *t*₀)/*S*), where *t*₀ is the last right first try. A clean answer given after the review delay multiplies *S* by a fixed growth factor. This is the Ebbinghaus forgetting curve[^1] with the half-life idea of Settles and Meeder's half-life regression[^2], without the regression: the constants are fixed, not learned. A variant with a fixed half-life (no growth) was considered and dropped, because the issue asks that each successful review lengthen the interval.

| For | Against |
| --- | --- |
| Two constants (the first stability and the growth factor); every value can be checked by hand | Not a calibrated probability of recall: "strength 0.5" means "one half-life has passed", not "a 50% chance" |
| Closed form: stability is the first stability times the growth factor to the power of a count, so the SQL needs no recursion | One growth factor for every quiz: it ignores that some items are harder than others |
| Uses exactly School's evidence: right or wrong, aid or none (C4) | A late review grows stability by the same factor as one on time, where FSRS grows it more |
| Works from the first answer, with no fitting (C8) | Less accurate than FSRS on large flashcard datasets[^4] |
| Its shape, stability plus strength, is FSRS's, so FSRS can replace the update rule later behind the same function | |

_Table 3.2. Option B, exponential decay with a growing half-life. It trades predictive accuracy for something School can compute, test and explain today._

Option B is the simplest model that both fades and lengthens the interval with each clean review.

### Option C: SM-2 intervals

SuperMemo's 1987 algorithm, the basis of Anki's original scheduler[^3]. After each review the learner grades recall from 0 to 5. The first interval is one day, the second six, and each later one is the previous times an *easiness factor* that starts at 2.5, falls with low grades and never drops below 1.3. A grade below 3 restarts the intervals.

| For | Against |
| --- | --- |
| Well known and simple; decades of use | It schedules a next date; it has no measure of how much is left now, so a fading mark would have to be invented on top |
| Its 2.5 growth is a reasonable default, which Option B borrows | Its easiness factor is driven by a 0–5 self-grade School does not collect (C4); mapping wrong, aided and clean onto grades is guesswork |
| | Each review updates the easiness factor from the last, so it needs a stateful pass over every review (a recursive query), not a count |
| | Repeated low grades push the easiness factor down for good, which keeps an item on short intervals after it is learned |

_Table 3.3. Option C, SM-2 intervals. It answers "when next", not "how much is left", and it is driven by grades School does not have._

SM-2's growth factor is worth keeping; its machinery is not.

### Option D: FSRS

The Free Spaced Repetition Scheduler, from the open-spaced-repetition project, now Anki's optional scheduler[^5]. It models each item's difficulty, stability and retrievability; retrievability is a predicted probability of recall that falls along a power curve. After each review, stability and difficulty are updated by formulas with about twenty parameters (21 in FSRS-6), fitted to large sets of Anki reviews rated Again, Hard, Good or Easy.

| For | Against |
| --- | --- |
| The most accurate of the three at predicting recall on the open benchmark[^4] | About twenty parameters, fitted to four-button flashcard ratings; School's binary outcome and aid signal have no rating to map onto, so the defaults are being used outside the data they were fitted to (C4) |
| Retrievability is a calibrated probability, so a threshold such as 0.9 means what it says | Fitting to one learner needs hundreds of reviews School will not have for months (C8); until then it runs on someone else's defaults |
| Larger stability gain for a review given late, smaller for one given early | Each review updates stability and difficulty from the previous values: a recursive query per quiz, hard to check by hand |
| Open source, with reference implementations to test against | Harder to explain in a sentence, which matters when every review item must say why it came back |

_Table 3.4. Option D, FSRS. It is the best model where its assumptions hold, and School does not yet meet them._

FSRS is the model to compare against once School has its own history, not the one to start on.

### Comparison

| | A: none | B: growing half-life | C: SM-2 | D: FSRS |
| --- | --- | --- | --- | --- |
| A Postgres function (C1) | holds | holds, closed form | holds, recursive | holds, recursive |
| Derived from the record, no state (C2) | holds | holds | holds | holds |
| Order by `seq`, caller's clock (C3) | holds | holds | holds | holds |
| Uses only School's evidence (C4) | holds | holds | needs invented grades | needs invented ratings |
| Words, not scores (C6) | holds | holds, by bands | holds, by bands | holds, by bands |
| Works with one learner's history (C8) | holds | holds | holds | on borrowed defaults |
| A measure of how much is left | no | yes | no | yes, calibrated |
| Each review lengthens the interval | no | yes | yes | yes |
| Can be checked by hand at a fixed clock | n/a | yes | mostly | hard |

_Table 3.5. The four options against the constraints. B meets every constraint and the issue's requirements; D is more accurate but rests on evidence School does not record._

In short: B is the one School can build, test and explain now; D is where it could go once the record holds enough real reviews to tell whether D would do better.

## 4. Recommendation

**Option B: exponential decay with a growing half-life.** Proposed. The sections below define the measure, how each kind of answer moves it, the functions, the rollup, the one change to due review, and the words.

### 4.1 The measure

The measure reuses due review's vocabulary exactly. An *episode* is one encounter's answers to one quiz block, in the course's encounters; its *first try* is the answer the record marked `first_try`. Its first try is **clean** (right, no exposure to the block in that encounter before it, aid tracked), **aided** (right, after an exposure), **unknown aid** (right, in an encounter with `aid_tracking` NULL), or **wrong**. An episode is **spaced** when its first try is at least `delay_ms` after the previous episode's last answer to that block, by `seq` order; the first episode is spaced.

For a quiz at time `at`:

| Value | Definition |
| --- | --- |
| `stability` | One day × 2.5^*k*, where *k* counts the spaced clean episodes after the *anchor*. The anchor is the latest episode whose first try was wrong or aided; if there is none, it is the quiz's first episode |
| `refreshedAt` | The `at` of the latest right first try (clean, aided or unknown aid) |
| `strength` | 0.5^((`at` − `refreshedAt`) / `stability`), and 1 when `at` is before `refreshedAt`. It is 0 when the latest episode's first try was wrong, and null when the quiz has never been answered |
| `settled` | Due review's clearing rule: no weak episode, or a clean episode at least `delay_ms` after the latest weak one's last answer |
| `evidence` | The `seq` of the anchor's first try, each counted episode's first try, and the latest right first try; at most 100, keeping the latest |

_Table 4.1. The values `school.mastery` returns per quiz. Stability is a count raised to a power, so no step depends on the one before and the query needs no recursion._

The two constants, one day and 2.5, live in the SQL, in one place, and change only by a new migration. One day matches the review delay's intent (a quiz from one day's study comes back the next); 2.5 is SM-2's starting easiness factor. A quiz has **faded** when it is settled and its strength is below one half, which is the same as saying a whole stability has passed since it was refreshed. That threshold needs no constant of its own.

Strength is not a probability of recall, and nothing may present it as one. It is how far through its half-life a quiz is.

### 4.2 How each answer moves it

This answers the issue's question of how aid and unknown aid lower the refresh. A refresh has two parts, and different evidence earns different parts of it: restarting the clock says "the learner had it at this moment"; growing stability says "and it had lasted since the last time".

| First try of the episode | Clock (`refreshedAt`) | Stability | Why |
| --- | --- | --- | --- |
| Clean, spaced | Restarts | × 2.5 | The strongest evidence School holds: found from memory, unaided, after a delay ([RFC 2 §5](0002-lessons-written-for-each-learner.md)) |
| Clean, within the delay | Restarts | Unchanged | Right, but a minute after the last answer is memory, not review, as due review already says |
| Unknown aid, right | Restarts | Unchanged | Right, but School was not watching, so it cannot say whether help was shown; it never earns growth, as it never clears a review item |
| Aided, right | Restarts | Back to one day | Found with help: it is known now, and the help shows it had not lasted |
| Wrong | Strength 0 until the next right first try | Back to one day | It had not settled; the next right first try starts it again |

_Table 4.2. How each kind of first try moves the measure. Aid lowers the refresh by withholding growth (unknown aid) or resetting it (aided); only a clean answer after the delay lengthens the interval._

Answers after the first try in an episode, such as a right answer after feedback, do not move the measure; they are the episode's, and the first try decides it, as in due review. So a quiz answered wrong and then put right in the same encounter has strength 0 until a later encounter's right first try.

### 4.3 A worked example

A learner answers a quiz cleanly at 09:00 on day 0 and, each time it fades, answers it cleanly again as soon as due review brings it back. The faded rule (§4.6) brings it back when strength reaches one half.

| Day | What happens | Strength just before | Stability after |
| --- | --- | --- | --- |
| 0 | First answer, clean | none | 1 day |
| 0.5 | Nothing; strength is 0.71 | | 1 day |
| 1 | Faded; comes back; clean | 0.5 | 2.5 days |
| 3.5 | Faded; comes back; clean | 0.5 | 6.25 days |
| 9.75 | Faded; comes back; clean | 0.5 | 15.6 days |
| 25.4 | Faded; comes back; clean | 0.5 | 39.1 days |
| 64.4 | Faded; comes back; clean | 0.5 | 97.7 days |

_Table 4.3. One quiz answered cleanly each time it returns. Five reviews in about two months, then one every three months or so; the load on the learner falls as stability grows._

Had the day-3.5 answer come after a hint, stability would return to one day, the aided rule would bring the quiz back the next day as it does today, and growth would start again from there. The example is illustrative: it assumes the learner answers on the day each quiz returns.

### 4.4 The functions

The measure is two read-only functions, both `STABLE`, both `SECURITY DEFINER` with a fixed `search_path`, both granted to `school_app` by name, as `due_review` is (C1).

| Function | Returns | Used by |
| --- | --- | --- |
| `school.mastery(course text, blocks jsonb, at timestamptz, delay_ms bigint)` | One row per asked block: `{blockId, strength, stabilityMs, refreshedAt, settled, evidence}`, with `strength` null for a quiz never answered | The rollup, the faded rule, and flyingrobots/school#191 for one block |
| `school.mastery_rollup(course text, groups jsonb, at timestamptz, delay_ms bigint)` | One row per group key: `{key, quizzes, notStarted, settling, holding, faded, strength}` | The course page per lesson, the home page per course, flyingrobots/school#191 per lesson and course |

_Table 4.4. The two proposed functions. Both take the time from the caller and the blocks from the course as served, as `due_review` does._

The caller passes the blocks, as it does to `due_review`, because the database does not know which quizzes a course serves now or which lesson holds each; a block the course no longer has is never asked about. `at` is the caller's clock (C3), which is what makes the measure testable at fixed clocks and lets the timeline project it forward. The function reads the whole record, as `due_review` does: it measures time to `at`, it does not replay history as of `at`.

### 4.5 Rolling up to lessons and courses

flyingrobots/school#191 needs "demonstrated mastery" for a lesson and a course, so the rollup is defined now. `groups` is a jsonb object from a key to an array of quiz block ids: one key per lesson for the course page, or one key holding every quiz for a course.

| Field | Meaning |
| --- | --- |
| `quizzes` | The number of distinct blocks in the group |
| `notStarted` | Never answered |
| `settling` | Answered, not settled: due review's weak rules still hold it |
| `holding` | Settled, strength one half or more |
| `faded` | Settled, strength below one half |
| `strength` | The mean strength over every quiz in the group, counting a quiz not started as 0; null for an empty group |

_Table 4.5. What the rollup returns for each group. The four counts partition the group, so they can always be said in words; the mean is for explain mode to rank lessons by, never for display._

The rollup is a second function rather than arithmetic in the core so that every number shown, and every number explain mode reads, comes from the database by one definition. Explain mode can read `school.mastery` for the quizzes of a lesson when it needs the weakest one rather than the mean.

Explanation grades are not part of the measure (C5). They are model grading, a different kind of evidence; explain mode can show them beside mastery, but this RFC does not fold them in.

### 4.6 Due review: one added rule

The issue asks how far the shared rule changes. This RFC proposes the smallest change that serves it: one rule added to `due_review`, by `CREATE OR REPLACE` in a new migration, with its signature and its three rules unchanged.

| | Today | Proposed |
| --- | --- | --- |
| Rules | `wrong-first-try`, `aided-first-try`, `unknown-aid` | The same three, then `due-review/faded` |
| `due-review/faded` | none | A block not chosen by the other rules, settled, whose strength from `school.mastery` at `at` is below one half, and whose latest answer is at least `delay_ms` before `at` |
| Ranking | Wrong, aided, unknown aid; oldest first try first within a rule | The same, then faded, lowest strength first, then by `seq` |
| Limit | `REVIEW_LIMIT`, three per lesson | Shared: faded items fill only what the weak ones leave |
| Evidence | Per rule ([due review, What each item cites](../topics/due-review/README.md#what-each-item-cites)) | Faded cites `school.mastery`'s evidence: the anchor, each counted first try and the latest right first try |
| Facts | `answeredAt`, `corrected`, `shown`, `lastSeen` | Faded: `answeredAt` is `refreshedAt`, `corrected` false, `shown` empty |

_Table 4.6. The change to due review. Everything the three existing rules do, cite and return stays as it is; a quiz they would not bring back may now come back because it has faded._

Because every caller already goes through `due_review`, the lesson page's Review section, the home page's **Ready for another look** list and the timeline's rings all pick up faded quizzes with no change of their own. On the server, `ReviewRule` in `server/core/model.ts` gains the value and `reviewReason` its case; the web pages parse `rule` as any string (`web/src/lib/home-api.ts`, `web/src/lib/school-api.ts`), so the added value is not a breaking change to them. Every existing case in the due-review [test plan](../topics/due-review/test-plan.md), DR-G1 through DR-W1, must pass unchanged; that is the proof the three rules did not move.

Leaving `due_review` alone and adding a second selector was considered. It would keep the shared rule's text untouched, but every caller (opening a lesson, `GET /api/review`, `GET /api/activity`) would then have to merge two lists and share one limit, which moves the rule into three call sites instead of one.

### 4.7 The words

The measure is a number inside School and words outside it (C6). A quiz, a lesson or a course is described by the four counts of §4.5, each with its word.

| State | Word on the page | Instead of |
| --- | --- | --- |
| Not answered | Not started yet | 0%, unanswered |
| Weak and not yet cleared | Still settling | failed, wrong |
| Settled, strength one half or more | Holding | mastered, 80% |
| Settled, strength below one half | Ready for another look | forgotten, decayed, overdue |

_Table 4.7. The words for each state. None names a number, and none says the learner lost anything; "Ready for another look" is already School's title for a review item._

The faded rule's reason, written by `reviewReason` from its facts, recalls the clean answer and asks a question: "On 21 November, you found this one from memory. Some time has passed: how does it feel now?" A course page line reads "2 of 3 quizzes holding · 1 ready for another look". The voice test that asserts no reason contains "wrong", "fail", "mistake" or "incorrect" gains "forgot" and "attempt".

### 4.8 On the pages

The course page and the home page show the measure; the lesson page needs nothing new, since faded quizzes arrive through its Review section.

| Page | Proposed |
| --- | --- |
| Course page | Each lesson's card adds its counts in words beside "N of M quizzes answered correctly", from `mastery_rollup` with one group per lesson |
| Home page, timeline | Each course's lane says in words, at today, how its quizzes are holding, from `mastery_rollup` with one group for the course. Faded quizzes already appear as rings on the days they come back, because the timeline asks `due_review` |
| Home page, review list | Faded quizzes appear under **Ready for another look** with their reason, through `GET /api/review`, with no change to the page |

_Table 4.8. Where the measure appears. Every mark carries its meaning in words, so the issue's "fading mark" is a word beside the mark, never colour or opacity alone._

Every UI step is built from shadcn registry components already in `web/src/components/ui` (Badge, Tooltip, Popover, Item), coloured with theme-book tokens, and checked in light and dark themes. No state goes in browser storage: the page asks the server, which asks the database.

In short: one function measures, one rolls up, due review adds one rule, and two pages say it in four words.

## 5. Order of work

Each step is one issue with one observable outcome. None is filed by this RFC; the coordinator files them once the maintainer decides. Each step updates its living reference, test plan and glossary in the same pull request, so the docs describe only what exists.

| # | Step | Depends on | Done when |
| --- | --- | --- | --- |
| 1 | **A database function returns mastery per quiz at a given time.** `school.mastery(course, blocks, at, delay_ms)` in a new migration, granted to `school_app` and listed in `GRANTED_FUNCTIONS`; a `LearningRecord.mastery` port method with its Zod schema, SDL type and regenerated Wesley output; a new `docs/topics/mastery/` reference and test plan; glossary entries for mastery, stability and strength | none | Contract cases pass on PGlite and on Bun.SQL at fixed clocks: a clean answer has strength 1 at once, 0.7071 twelve hours later and 0.5 at one day; a clean answer after the delay raises stability to 2.5 days; one within the delay does not; unknown aid restarts the clock and keeps stability; an aided first try returns it to one day; a wrong first try gives 0 until the next right one; a quiz never answered is null; with `at` out of step with `seq`, order follows `seq`; the function is `STABLE` and takes no sequence value; `school_app` may execute it and still reads no table |
| 2 | **A database function rolls mastery up per lesson and per course.** `school.mastery_rollup(course, groups, at, delay_ms)`, granted and listed as in step 1 | 1 | Contract cases on both drivers at fixed clocks: the four counts partition each group, the mean counts a quiz not started as 0, an empty group gives null, and a block in two groups counts in both |
| 3 | **Due review brings back a quiz whose mastery has faded.** `due_review` replaced in a new migration with `due-review/faded` ranked last; `ReviewRule` and `reviewReason` gain it; the due-review reference and test plan updated | 1 | Every existing DR case passes unchanged; new cases on both drivers: a settled quiz past one stability comes back as faded citing `school.mastery`'s evidence, one within it does not, faded ranks after the three weak rules and fills only what they leave of the limit; the year-of-history stress case (DR-9) still reads within 1000 ms; the faded reason passes the voice test with "forgot" and "attempt" added |
| 4 | **The course API reports each lesson's mastery in counts.** `GET /api/courses/:course` adds `mastery: {notStarted, settling, holding, faded}` per lesson, from step 2 | 2 | An HTTP test at a fixed clock reads the counts for a lesson with one quiz of each state |
| 5 | **The course page says how each lesson is holding.** Each lesson card shows its counts in words (§4.7), built from shadcn registry components with theme-book colours | 4 | A Chrome test shows "holding" and "ready for another look" on a lesson card in light and dark themes, with no number or percentage, and nothing written to browser storage |
| 6 | **The home timeline says how each course is holding.** `GET /api/activity` adds per-course counts for today from step 2; each lane shows them in words, built from shadcn registry components with theme-book colours | 2, 3 | A Chrome test shows a course's words in its lane in light and dark themes, and a faded quiz as a ring on the day it comes back |
| 7 | **The learner answers one faded review for real.** Study, no code, as flyingrobots/school#52 does for due review | 3, flyingrobots/school#52 | One `due-review/faded` decision note in the record is followed by a clean answer during real study |

_Table 5.1. The build, in order. Step 1 is the first slice flyingrobots/school#192 asks for; steps 2 and 3 can run in parallel after it, and step 2 is what flyingrobots/school#191 needs._

In short: a measure, a rollup, one more review rule, two API fields and two pages, then a real review.

## 6. Out of scope

These are left out on purpose; each would be a later issue if wanted.

| Left out | Why |
| --- | --- |
| FSRS, or fitting any parameter | C4 and C8; revisit as §8 Q9 says |
| A per-item difficulty | Needs fitting, and no course declares difficulty |
| Explanation grades in the measure | Model grading is different evidence (C5) |
| Showing strength as a number, a percentage or a bar | C6 |
| Storing mastery, caching it, or a table of next due dates | C2; it is derived on every read |
| A browser-side copy of mastery | No browser storage for state |
| Changing `REVIEW_DELAY_MS` or `REVIEW_LIMIT` | Shared constants; the faded rule works within them |
| Mastery of exams, or a pass mark | Exams are unsettled in the [glossary](../glossary.md) |

_Table 6.1. What this RFC does not propose. Most of it is held back by a constraint, not by effort._

Nothing here blocks a later RFC from taking any of these up.

## 7. Risks

The risks are about volume, meaning and copy; each has a mitigation in the design or a test in the order of work.

| Risk | Mitigation |
| --- | --- |
| Every clean quiz eventually comes back, so review crowds out new lessons | Faded ranks last and shares the limit of three per lesson; stability grows 2.5 times per review, so the load per quiz falls quickly (Table 4.3) |
| The faded rule slows `due_review`, which the timeline calls fifteen times per course | DR-9's year-of-history case must still read within 1000 ms (step 3); `school.mastery` is closed form, with no recursion |
| Someone reads strength as a probability of recall | It is never shown as a number; this RFC and the topic reference say it is a half-life fraction |
| The constants are wrong for this learner | They are two numbers in one migration, changed by a new one; step 7 and months of real study give the evidence to change them, or to move to FSRS |
| The faded rule changes what due review means for every page | It is additive: the three rules and their tests are unchanged; the added rule is listed in the reference with its reason |
| Copy slips into "you forgot" or a grade | The voice test gains the words; every reason is listed in the reference |
| A quiz's id changes when an author edits a course, and its history is lost | As today for due review: a block id is stable by rule (flyingrobots/school#1), and the measure follows the id |

_Table 7.1. Risks and mitigations. The largest, review volume, is bounded by the shared limit and by the growth of stability._

The risk the issue names, that the shared rule changes meaning, is real and deliberate; the design keeps it to one added rule with its own reason.

## 8. Open questions

The maintainer decides Q1 to Q4, which are the issue's own; the rest have a recommendation that holds until someone objects.

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Which model? | Option B, the growing half-life (§3, §4.1) |
| Q2 | How do aid and unknown aid lower the refresh? | Unknown aid restarts the clock and withholds growth; aided restarts the clock and returns stability to one day; only a clean answer after the delay grows it (Table 4.2) |
| Q3 | How is it worded? | Four words, never a number: Not started yet, Still settling, Holding, Ready for another look; the faded reason asks "how does it feel now?" (§4.7) |
| Q4 | How far does due review change? | One added rule, `due-review/faded`, ranked last, sharing the limit; nothing else moves (§4.6) |
| Q5 | Are one day and 2.5 the right constants? | Yes, to start: they match the review delay's one-day intent and SM-2's long-used default. Change them only with evidence from real study |
| Q6 | Should a late clean answer grow stability more than one on time? | Not now: it would need a third constant. FSRS does this, and is the place to get it |
| Q7 | Should the rollup be a mean or the weakest quiz? | Both are available: the rollup's mean, and `school.mastery` per quiz for the weakest. Explain mode chooses |
| Q8 | Should "Holding" split into finer words, such as "Fresh"? | Not at first. Two settled states are enough to act on; more can follow if the learner wants them |
| Q9 | When should FSRS be reconsidered? | After step 7, once the record holds several hundred real review answers: replay them through both models as a query and compare which predicted the next first try better |

_Table 8.1. Open questions and recommendations. Q1 to Q4 come from flyingrobots/school#192; Q5 to Q9 come from this design._

In short: the maintainer decides the model, the aid rule, the words and the change to due review; the constants and the later move to FSRS wait for real study.

## 9. References

The models in §3 are described from these sources. They were cited from memory and not re-fetched while writing this draft; a reviewer should check the details before the RFC is decided.

[^1]: H. Ebbinghaus, *Über das Gedächtnis*. Leipzig: Duncker & Humblot, 1885. The forgetting curve: retention falling with time since learning.
[^2]: B. Settles and B. Meeder, "A Trainable Spaced Repetition Model for Language Learning," in *Proc. 54th Annu. Meeting Assoc. Comput. Linguistics (ACL)*, 2016. Half-life regression, the source of the half-life framing in Option B.
[^3]: P. A. Woźniak, "Application of a computer to improve the results obtained in working with the SuperMemo method," 1990. [Online]. Available: https://super-memory.com/english/ol/sm2.htm. The SM-2 algorithm in Option C.
[^4]: Open Spaced Repetition, "srs-benchmark." [Online]. Available: https://github.com/open-spaced-repetition/srs-benchmark. The comparison of FSRS, SM-2 and simpler models on Anki review logs.
[^5]: Open Spaced Repetition, "The Algorithm," fsrs4anki wiki. [Online]. Available: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm. FSRS's model of difficulty, stability and retrievability in Option D.

These sources describe flashcard models; none was tested against School's record, which is the point of §8 Q9.
