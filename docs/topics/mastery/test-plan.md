# Mastery test plan

The contract ledger for [mastery](README.md) and its rollup. Every case runs in `bun test`. Contract cases are in `server/contract/learning-record.ts`, titled `<adapter>: mastery: <case>`, and run at fixed clocks with `delay_ms` of twenty hours. They run on PGlite (`server/adapters/postgres.test.ts`) and on a real Postgres through `Bun.SQL` (`server/adapters/bunsql.test.ts`); CI's gate fails a PGlite case that has no passing `Bun.SQL` counterpart. A strength is compared to 4 decimal places; a stability exactly while it is a whole number of milliseconds.

## The measure

Each case below is a contract case, so it names the behaviour through the port and holds on both drivers. The oracle is RFC 5: Table 4.1 for the values, Table 4.2 for how each first try moves them, and §4.3 for the worked example.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MA-G1 | Golden: one clean answer | Strength 1 at once, 0.7071 at twelve hours, 0.5 at one day and 0.25 at two; stability one day; settled; evidence the first try | implemented | `a clean answer has strength 1 at once, 0.7071 twelve hours later and 0.5 at one day, with a stability of one day` |
| MA-G2 | Golden: the worked example | RFC 5 Table 4.3: strength 0.5 just before each answer, then 1, with stability 1, 2.5, 6.25, 15.625, 39.0625 and 97.65625 days; evidence every first try | implemented | `RFC 5 Table 4.3: answered cleanly each time it fades, stability grows by 2.5 at each answer` |
| MA-1 | The delay boundary (edge) | A clean answer exactly `delay_ms` after the last answer grows stability to 2.5 days; one 1 ms sooner restarts the clock and keeps one day | implemented | `a clean answer exactly the delay after the last answer grows stability; one 1 ms sooner only restarts the clock` |
| MA-2 | Unknown aid | Restarts the clock and keeps stability, though it comes after the delay; not settled | implemented | `unknown aid restarts the clock and keeps stability, though it comes after the delay, and the quiz has not settled` |
| MA-3 | Aided | Restarts the clock and returns stability to one day, citing only that first try; a clean answer a delay later grows it to 2.5 days and settles it | implemented | `an aided first try restarts the clock and returns stability to one day; a clean answer a delay later grows it again` |
| MA-4 | Wrong | Strength 0 an hour later and thirty days later, though put right in the same encounter; stability one day; refreshed at the last right first try; the next right first try, within the delay, gives strength 1 and one day, citing only itself | implemented | `a wrong first try gives strength 0 until the next right first try, though it was put right in the same encounter` |
| MA-8 | Wrong resets the chain | Wrong, then a clean answer a day later: stability one day and strength 1 at once, not 2.5 days; the next spaced clean answer grows it to 2.5 | implemented | `after a wrong first try the next right first try starts again: wrong, then right a day later, gives one day and strength 1 at once` |
| MA-9 | Spacing from the last answer (mutant) | An episode with several answers: the next episode is spaced only a delay after its last answer, not its first | implemented | `spacing is measured from the previous episode's last answer, not its first` |
| MA-10 | The settled boundary (edge) | A clean answer exactly `delay_ms` after a weak episode's last answer settles the quiz; 1 ms sooner does not | implemented | `settled: a clean answer exactly the delay after a weak episode's last answer settles the quiz; 1 ms sooner does not` |
| MA-5 | Never answered (edge) | Strength, stability and refresh time null, not settled, no evidence; rows follow the order asked, each block once; another course's answers count for nothing; no blocks gives no rows | implemented | `a quiz never answered is null; rows follow the order asked, each block once; another course's answers are not this one's` |
| MA-6 | Ordering by `at` (known failure mode) | With `at` out of step with `seq`, the latest first try, the refresh time and the delay all follow `seq` | implemented | ``order is the record's, by seq, never by `at`: the latest first try, the refresh and the delay are read in seq order`` |
| MA-7 | Before the refresh, and long after | Strength 1 at a time before the refresh; close to 0, not an error, ten years after it | implemented | `strength is 1 at a time before the refresh, and reaches 0, not an error, ten years after it` |
| MA-F1 | A year of random first tries (fuzz) | Seeded (`SCHOOL_TEST_SEED`, 232 in CI): after every episode, strength is in [0, 1], stability never falls on a spaced clean answer, and both equal a step-by-step model of Table 4.2; every kind of first try is reached | implemented | `under a year of random first tries, strength stays in [0, 1], stability never falls on a spaced clean answer, and both follow Table 4.2` |

_Table 1. The measure's contract cases. Each names its RFC 5 oracle, and each runs on both drivers._

In short: the RFC's fixed-clock cases, the delay boundary, the null and ordering edges and a seeded year of history all hold through the port on PGlite and on Postgres.

## The function

These cases are SQL-level, on PGlite, in `server/db/mastery.test.ts` and the record's acceptance tests; they check what the port cannot see.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MA-S1 | Read-only | `mastery` is `STABLE`; calling it as `school_app` takes no sequence value | implemented | `server/db/mastery.test.ts`: `the measure is read-only: it is STABLE, and calling it takes no sequence value and stores nothing` |
| MA-S2 | Privileges (known failure mode) | `school_app` may execute `mastery`, a `SECURITY DEFINER` function with `search_path` fixed, and may not read `answers`, `exposures` or `encounters` | implemented | `server/db/mastery.test.ts`: `school_app reaches the measure only as a function, never the tables behind it` |
| MA-S3 | A long history (stress) | 150 daily clean answers: stability stops at one day × 2.5^100, a finite number, strength is 1 ten years on, and evidence keeps 100 | implemented | `server/db/mastery.test.ts`: `stability stops growing after 100 counted answers, so it stays a finite number however long the history` |
| MA-S8 | Evidence keeps the latest (mutant) | 150 daily clean answers: evidence is exactly the latest 100 first-try seqs, ascending | implemented | `server/db/mastery.test.ts`: `evidence keeps the latest 100 seqs, not the earliest` |
| MA-S4 | No clock | `mastery` and `quiz_episodes` call no clock function | implemented | `server/db/init.test.ts`: `no record function calls now() or any other clock` |
| MA-S5 | Granted by name | `mastery` is in `GRANTED_FUNCTIONS`, and no other new function is executable by `school_app` | implemented | `server/db/init.test.ts`: `no function is executable by a role without an explicit grant`; `server/adapters/app-login.test.ts` |
| MA-S6 | One function call | The port method is one call of `school.mastery`, as `school_app` | implemented | `server/adapters/postgres.test.ts`: `every port method is one call of its function, as school_app` |
| MA-S7 | Survives a backup | After a dump and restore, `mastery` reads the same as before | implemented | `server/backup/backup.test.ts`: `Bun.SQL: a dump taken after real writes restores into an empty database, and every read of the record returns the same` |

_Table 2. The function's SQL-level cases. They hold the privileges, the read-only promise and the finite stability to the database itself._

In short: the function reads only, is reached only by name, calls no clock, and stays finite over any history.

## The rollup

The rollup's contract cases are titled `<adapter>: mastery rollup: <case>`, in `server/contract/learning-record.ts`, at fixed clocks with `delay_ms` of twenty hours, on both drivers. The oracle is RFC 5 Table 4.5 for the states and the mean, with each quiz's strength from Table 4.1; the fuzz case's oracle is `school.mastery` itself. Its SQL-level cases are in `server/db/mastery-rollup.test.ts`, on PGlite.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MR-G1 | Golden: one lesson with a quiz in each state | One each of not started, settling, holding and faded; quizzes 4; mean (0.5^(1/2.5) + 0.25) / 4 at day 2 | implemented | `golden: one lesson with a quiz in each state counts one of each, and the mean counts the quiz not started as 0` |
| MR-1 | A settling quiz's strength (mutant) | An unknown-aid answer a day ago is settling with strength 0.5, and the mean is 0.5, not 0 | implemented | `a quiz still settling counts its strength in the mean, not 0` |
| MR-2 | The one-half boundary (edge) | Strength exactly 0.5 is holding; 1 ms later it is faded | implemented | `strength exactly one half is holding; 1 ms later it is ready for another look` |
| MR-3 | Empty group (edge) | Quizzes 0, every count 0, strength null; no groups gives no rows | implemented | `an empty group has no quizzes and a null strength; no groups gives no rows` |
| MR-4 | Shared block (edge; known failure mode: double counting) | A block in two groups counts in both; a block twice in one group counts once; rows in byte order of the key, not jsonb's order | implemented | `a block in two groups counts in both, a block twice in one group counts once, and rows are in byte order of the key` |
| MR-5 | Another course | A quiz answered only in another course is not started | implemented | `another course's answers are not this one's` |
| MR-F1 | Random groups (fuzz) | Seeded (`SCHOOL_TEST_SEED`, 232 in CI): 40 rounds of up to four random groups over eight quizzes with twenty days of random first tries; the four counts sum to the distinct quizzes, each count and the mean equal `school.mastery`'s rows placed by Table 4.5; every state, an empty group and a repeated block are reached | implemented | `under random groups, the four counts always sum to the group's distinct quizzes, and each count and the mean agree with mastery` |
| MR-S1 | Read-only | `mastery_rollup` is `STABLE`; calling it as `school_app` takes no sequence value | implemented | `server/db/mastery-rollup.test.ts`: `the rollup is read-only: it is STABLE, and calling it takes no sequence value and stores nothing` |
| MR-S2 | Privileges | `school_app` may execute it, a `SECURITY DEFINER` function with `search_path` fixed; it is in `GRANTED_FUNCTIONS` and the port calls only it | implemented | `server/db/mastery-rollup.test.ts`: `school_app reaches the rollup only as a function: SECURITY DEFINER with search_path fixed`; `server/db/init.test.ts`; `server/adapters/postgres.test.ts`: `every port method is one call of its function, as school_app` |
| MR-S3 | Malformed groups (edge) | `groups` not an object gives no rows; a value not an array is an empty group | implemented | `server/db/mastery-rollup.test.ts`: `groups that are not a jsonb object ask about nothing, and a group that is not an array is empty` |
| MR-S4 | Survives a backup | After a dump and restore, `mastery_rollup` reads the same as before | implemented | `server/backup/backup.test.ts`: `Bun.SQL: a dump taken after real writes restores into an empty database, and every read of the record returns the same` |

_Table 3. The rollup's cases. The counts' partition and the shared block are each held by a fixed case and by the seeded differential against `school.mastery`._

In short: the four counts partition every group, the mean counts a quiz not started as 0, an empty group is null and a shared block counts in each group, on both drivers.
