# Mastery

Reference: how well School holds each quiz to be known at a given time, as a stability and a strength (RFC 5 §4.1, §4.2; flyingrobots/school#217).

A quiz answered cleanly last month is not held as surely as one answered cleanly this morning, and each clean answer given after a delay makes it last longer. `school.mastery` measures that for each quiz, from the append-only record, every time it is asked; nothing it returns is stored. It exists as the database function and the `LearningRecord.mastery` port method; no page or API reads it.

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
