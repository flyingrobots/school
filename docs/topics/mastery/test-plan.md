# Mastery test plan

The contract ledger for [mastery](README.md). Every case runs in `bun test`. Contract cases are in `server/contract/learning-record.ts`, titled `<adapter>: mastery: <case>`, and run at fixed clocks with `delay_ms` of twenty hours. They run on PGlite (`server/adapters/postgres.test.ts`) and on a real Postgres through `Bun.SQL` (`server/adapters/bunsql.test.ts`); CI's gate fails a PGlite case that has no passing `Bun.SQL` counterpart. A strength is compared to 4 decimal places; a stability exactly while it is a whole number of milliseconds.

## The measure

Each case below is a contract case, so it names the behaviour through the port and holds on both drivers. The oracle is RFC 5: Table 4.1 for the values, Table 4.2 for how each first try moves them, and §4.3 for the worked example.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MA-G1 | Golden: one clean answer | Strength 1 at once, 0.7071 at twelve hours, 0.5 at one day and 0.25 at two; stability one day; settled; evidence the first try | implemented | `a clean answer has strength 1 at once, 0.7071 twelve hours later and 0.5 at one day, with a stability of one day` |
| MA-G2 | Golden: the worked example | RFC 5 Table 4.3: strength 0.5 just before each answer, then 1, with stability 1, 2.5, 6.25, 15.625, 39.0625 and 97.65625 days; evidence every first try | implemented | `RFC 5 Table 4.3: answered cleanly each time it fades, stability grows by 2.5 at each answer` |
| MA-1 | The delay boundary (edge) | A clean answer exactly `delay_ms` after the last answer grows stability to 2.5 days; one 1 ms sooner restarts the clock and keeps one day | implemented | `a clean answer exactly the delay after the last answer grows stability; one 1 ms sooner only restarts the clock` |
| MA-2 | Unknown aid | Restarts the clock and keeps stability, though it comes after the delay; not settled | implemented | `unknown aid restarts the clock and keeps stability, though it comes after the delay, and the quiz has not settled` |
| MA-3 | Aided | Restarts the clock and returns stability to one day, citing only that first try; a clean answer a delay later grows it to 2.5 days and settles it | implemented | `an aided first try restarts the clock and returns stability to one day; a clean answer a delay later grows it again` |
| MA-4 | Wrong | Strength 0 an hour later and thirty days later, though put right in the same encounter; stability one day; refreshed at the last right first try; the next right first try, within the delay, gives strength 1 and one day | implemented | `a wrong first try gives strength 0 until the next right first try, though it was put right in the same encounter` |
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
| MA-S4 | No clock | `mastery` and `quiz_episodes` call no clock function | implemented | `server/db/init.test.ts`: `no record function calls now() or any other clock` |
| MA-S5 | Granted by name | `mastery` is in `GRANTED_FUNCTIONS`, and no other new function is executable by `school_app` | implemented | `server/db/init.test.ts`: `no function is executable by a role without an explicit grant`; `server/adapters/app-login.test.ts` |
| MA-S6 | One function call | The port method is one call of `school.mastery`, as `school_app` | implemented | `server/adapters/postgres.test.ts`: `every port method is one call of its function, as school_app` |
| MA-S7 | Survives a backup | After a dump and restore, `mastery` reads the same as before | implemented | `server/backup/backup.test.ts`: `Bun.SQL: a dump taken after real writes restores into an empty database, and every read of the record returns the same` |

_Table 2. The function's SQL-level cases. They hold the privileges, the read-only promise and the finite stability to the database itself._

In short: the function reads only, is reached only by name, calls no clock, and stays finite over any history.
