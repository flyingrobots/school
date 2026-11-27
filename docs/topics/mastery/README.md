# Mastery

Reference: how well School holds each quiz to be known at a given time, as a stability and a strength (RFC 5 §4.1, §4.2; flyingrobots/school#217), and how a lesson's or a course's quizzes roll up into four states (RFC 5 §4.5; flyingrobots/school#218).

A quiz answered cleanly last month is not held as surely as one answered cleanly this morning, and each clean answer given after a delay makes it last longer. `school.mastery` measures that for each quiz, from the append-only record, every time it is asked; nothing it returns is stored. It exists as the database function and the `LearningRecord.mastery` port method, and `school.mastery_rollup` counts it per lesson or per course ([Rolling up to lessons and courses](#rolling-up-to-lessons-and-courses)). Due review reads it to bring back a settled quiz whose strength is below one half ([faded quizzes](../due-review/README.md#faded-quizzes), migration 0014); no page or API reads either function directly yet.

## The measure

The measure reads a quiz's **episodes** exactly as [due review](../due-review/README.md#the-rule) does: an episode is one encounter's answers to the quiz, in the course's encounters, and its first try is the answer the record marked `first_try`. Only the first try moves the measure. Every "first", "latest", "previous" and "after" is by `seq`, never by `at`; `at` is read only to measure elapsed time.

| Value | Definition |
| --- | --- |
| Stability (`stabilityMs`) | The quiz's half-life: one day × 2.5^*k*, where *k* counts the spaced clean episodes after the anchor. The **anchor** is the latest episode whose first try was wrong or aided, or the first right one after a wrong one, or the first episode if there is none. An episode is **spaced** when its first try came at least `delay_ms` after the previous episode's last answer; the first episode is spaced. *k* stops at 100 (2.5^100 days is about 10^37 years), so stability stays a finite number |
| Refreshed at (`refreshedAt`) | The `at` of the latest right first try: clean, aided or unknown aid |
| Strength (`strength`) | 0.5^((`at` − `refreshedAt`) / stability), from 0 to 1: how far through its half-life the quiz is. It is 1 when `at` is not after `refreshedAt`, and 0 when the latest episode's first try was wrong. Past 1000 stabilities it is 0 |
| Settled (`settled`) | Due review's clearing rule: no weak episode, or a clean episode whose first try came at least `delay_ms` after the latest weak episode's last answer |
| Evidence (`evidence`) | The `seq` of the anchor's first try, of each counted episode's first try and of the latest right first try, ascending, at most 100, keeping the latest |

_Table 1. What `school.mastery` returns per quiz. Stability is a count raised to a power, so no step depends on the one before._

The two constants, one day and 2.5, are RFC 5's and live only in `server/db/migrations/0011_mastery.sql`; changing them takes a new migration. Strength is not a probability of recall, and nothing may present it as one.

In short: stability is how long a quiz lasts, strength is how much of that has passed, and both are read from the first tries in `seq` order.

## How each first try moves it

A first try is clean, aided, unknown aid or wrong, as due review names them. Each kind earns a different part of a refresh: restarting the clock says the learner had it at that moment, and growing stability says it had lasted since the time before.

| First try of the episode | Refreshed at | Stability |
| --- | --- | --- |
| Clean (right, nothing shown before it, aid tracked), spaced, and the episode before it did not start wrong | This first try | × 2.5 |
| Any right first try right after a wrong one | This first try | One day, however long after: it starts again and is the new anchor |
| Clean, within `delay_ms` of the previous episode's last answer | This first try | Unchanged |
| Right in an encounter whose `aid_tracking` is NULL (unknown aid) | This first try | Unchanged, however long after the last |
| Right after help shown for the quiz, or for the whole encounter, in that encounter (aided) | This first try | Back to one day |
| Wrong | Unchanged; strength is 0 until the next right first try | Back to one day |

_Table 2. How each kind of first try moves the measure. Only a clean answer after the delay lengthens the half-life; aid withholds growth (unknown aid) or resets it (aided)._

A right answer after a wrong first try in the same encounter, such as one after feedback, moves nothing: the episode's first try decides it. So a quiz answered wrong and then put right has strength 0 until a later encounter's right first try. That right first try starts the chain again: its stability is one day, not 2.5 times anything, however long after the wrong one it comes, and it becomes the anchor the next clean, spaced answer grows from. The first answer a quiz ever has starts it at one day, whatever kind it is.

In short: every right first try restarts the clock, only a clean and spaced one grows stability, and a wrong one holds strength at 0.

## A worked example

A learner answers a quiz cleanly at 10:00 on day 0 (the contract's clock, 2026-11-21T10:00:00Z), then again each time its strength reaches one half. The contract asserts each row of Table 3 at fixed clocks, with `delay_ms` of twenty hours.

| Day | Strength just before | Stability after |
| --- | --- | --- |
| 0 | none | 1 day |
| 1 | 0.5 | 2.5 days |
| 3.5 | 0.5 | 6.25 days |
| 9.75 | 0.5 | 15.625 days |
| 25.375 | 0.5 | 39.0625 days |
| 64.4375 | 0.5 | 97.65625 days |

_Table 3. One quiz answered cleanly each time it reaches half strength (RFC 5 Table 4.3). The test is `mastery: RFC 5 Table 4.3: answered cleanly each time it fades, stability grows by 2.5 at each answer`._

After the day-0 answer alone, strength is 1 at once, 0.7071 twelve hours later, 0.5 at one day and 0.25 at two. Had the day-3.5 answer come after a hint, stability would have returned to one day and grown again from there.

In short: answered as it fades, the quiz comes back five times in about two months and then about every three months.

## Calling it

`school.mastery(course text, blocks jsonb, at timestamptz, delay_ms bigint)` returns one row, `item jsonb`, per distinct block in `blocks`, in the order each was first asked. It is `STABLE` and `SECURITY DEFINER` with `search_path` fixed to `school, pg_temp`, takes no sequence value, writes nothing, and is granted to `school_app` by name (it is in `GRANTED_FUNCTIONS`, `server/adapters/database.ts`). `blocks` that is not a jsonb array asks about nothing. The caller passes the time, so the measure can be read at a fixed clock or projected forward; it reads the whole record, and does not replay history as of `at`.

The port method is `LearningRecord.mastery({ course, blocks, now, delayMs })` (`server/core/ports.ts`), parsed with the `MasteryQuery` and `Mastery` schemas in `server/core/model.ts`; `server/schema/school.graphql` describes the same two shapes for Wesley. A quiz asked about but never answered in this course, or a block that is not a quiz, comes back with no measure:

```json
{"blockId": "q3", "strength": null, "stabilityMs": null, "refreshedAt": null, "settled": false, "evidence": []}
```

_Listing 1. The row for a block with no episodes, as the contract case `mastery: a quiz never answered is null; ...` asserts it through the port._

The episodes come from `school.quiz_episodes(course, blocks)`, also in migration 0011: due review's episodes and how each first try was weak, as one function. It is not granted, so `school_app` cannot call it; `school.mastery` calls it as its owner. Since migration 0012 `school.due_review` takes its episodes from it too, so the two read the same rows, and an exposure for the whole encounter (`ai-help`, [due review](../due-review/README.md#help-for-the-whole-encounter)) makes a first try after it aided in both.

In short: one read-only function, one port method, one row per asked block, with nulls for a quiz never answered.

## Rolling up to lessons and courses

A page says how a lesson or a course is holding in words, and explain mode ranks lessons by how well they are held, so `school.mastery_rollup` places each quiz of a group in one of four states and gives the group's mean strength. A group is any set of quiz blocks under a key: one key per lesson for a course page, or one key holding every quiz for a course. Each quiz's state comes from its `school.mastery` row, as Table 4 defines.

| Field | Meaning | The learner reads it as |
| --- | --- | --- |
| `quizzes` | The number of distinct blocks in the group | |
| `notStarted` | Never answered in this course: strength is null | Not started yet |
| `settling` | Answered, not settled: due review's weak rules still hold it | Still settling |
| `holding` | Settled, strength one half or more | Holding |
| `faded` | Settled, strength below one half | Ready for another look |
| `strength` | The mean strength over the group, a quiz not started counting 0; null for an empty group | Never shown: it is for explain mode to rank lessons by |

_Table 4. What `school.mastery_rollup` returns for each group (RFC 5 Table 4.5, the words of §4.7). The four counts partition the group, so they always sum to `quizzes` and can always be said in words._

A block in two groups counts in both, so a lesson's quiz counts once for its lesson and once for its course; a block named twice in one group counts once. A quiz at exactly one half strength is holding. A quiz still settling adds its own strength to the mean, which may be more than 0; only a quiz not started is counted as 0.

`school.mastery_rollup(course text, groups jsonb, at timestamptz, delay_ms bigint)` returns one row, `item jsonb`, per key of `groups`, in byte order of the key (`COLLATE "C"`). `groups` is a jsonb object from a key to a jsonb array of block ids; `groups` that is not an object asks about nothing, a key whose value is not an array is an empty group, and a null in an array is not a block. It calls `school.mastery` once, with every distinct block asked, so both read the record by one definition. It is defined in `server/db/migrations/0013_mastery_rollup.sql`, is `STABLE` and `SECURITY DEFINER` with `search_path` fixed to `school, pg_temp`, writes nothing, and is granted to `school_app` by name (it is in `GRANTED_FUNCTIONS`). Listing 2 shows one lesson with a quiz in each state.

```json
{"key": "l1", "quizzes": 4, "notStarted": 1, "settling": 1, "holding": 1, "faded": 1, "strength": 0.2520}
```

_Listing 2. The row for a lesson of four quizzes at day 2: one never answered, one answered wrong at day 0, one answered cleanly at days 0 and 1 (strength 0.5^(1/2.5), about 0.758), and one answered cleanly at day 0 alone (strength 0.25). The mean is (0 + 0 + 0.758 + 0.25) / 4; the contract case is `mastery rollup: golden: ...`, and the value is shown to 4 places._

The port method is `LearningRecord.masteryRollup({ course, groups, now, delayMs })`, parsed with the `MasteryRollupQuery` and `MasteryRollup` schemas in `server/core/model.ts`. `server/schema/school.graphql` describes `MasteryRollup` and the rest of `MasteryRollupQuery` for Wesley; `groups`, a map from key to blocks, has no GraphQL form, so `server/schema/check.ts` compares the query without it.

In short: one function counts any group of quizzes into four states that always sum to the group, and a mean strength in which a quiz not started counts 0.
