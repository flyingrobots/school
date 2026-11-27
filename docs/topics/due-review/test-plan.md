# Due review test plan

The contract ledger for [due review](README.md). Every case runs in `bun test`. Contract cases are
in `server/contract/learning-record.ts`, titled `<adapter>: due review: <case>`. They run on
PGlite (`server/adapters/postgres.test.ts`) and on a real Postgres through `Bun.SQL`
(`server/adapters/bunsql.test.ts`). CI's gate fails a PGlite case that has no passing `Bun.SQL`
counterpart.

## The selector

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| DR-G1 | Golden: the learner-history fixture | On day three, both quizzes come back as wrong first tries. The closest planet cites the wrong answer, the feedback shown and the correction; the moons cite Mars and the second try. The next lesson shows them in a Review section with their reasons, and a reload shows the same. A right first try a day later clears the closest planet. | implemented | `server/contract/learner-history.ts`: `learner history replays, and each step reads as it happened` (both drivers) |
| DR-1 | Wrong first, then corrected after help | Not due until the delay has passed since the block was last answered, then due, citing the wrong answer, the exposure and the correction; asking again gives the same | implemented | `an item answered wrong first returns after its delay, citing the wrong answer, the help shown and the correction` |
| DR-2 | Wrong, never put right | Due, `corrected: false`, citing every answer in that encounter | implemented | `an item never put right returns, citing every answer in that encounter` |
| DR-3 | Right only after an exposure | `due-review/aided-first-try`, citing the exposure and the answer; help after the answer is not cited | implemented | `an item answered right only after an exposure returns as aided, citing the exposure and the answer` |
| DR-4 | Unknown aid | A right first try in an untracked encounter is due as `due-review/unknown-aid`, citing the encounter row; it never clears an item answered wrong earlier | implemented | `unknown aid: a right first try School was not watching returns, citing its untracked encounter, and never clears an item` |
| DR-5 | No items due | An empty record, no blocks asked about, right first tries, an item seen 1 ms less than the delay ago, a due block not asked about, and another course all return nothing | implemented | `no items due: an empty record, right first tries, items seen within the delay, and blocks not asked about` |
| DR-6 | Clearing needs the delay | A right first try within the delay of the last wrong answer does not clear; one after it does; a later wrong first try makes it due again | implemented | `a right first try with no recorded aid clears an item only once the delay has passed since it was last wrong` |
| DR-7 | Ordering by `at` (known failure mode) | With `at` out of step with `seq`: the first try, the help before it, the time last seen and the order of items all follow `seq` | implemented | `order is the record's, by seq, never by \`at\`: first try, prior help, last seen and the order of items` |
| DR-8 | Ranking and the limit | Wrong first tries, then aided, then unknown aid, oldest first within a rule; `limit` bounds the list, and 0 returns none | implemented | `items rank by rule, wrong first tries, then aided, then unknown aid, oldest first within a rule, bounded by the limit` |
| DR-9 | A year of history (stress) | A year of synthetic history, three sessions a day, is read touching at most 100 buffer pages per page the school schema holds (EXPLAIN (ANALYZE, BUFFERS), counted as work, not time, so the bound holds at any machine speed; flyingrobots/school#354), and returns exactly `REVIEW_LIMIT` items | implemented | `server/db/due-review.test.ts`: `postgres (PGlite): due review: a year of synthetic history is read touching at most 100 pages per page of the record, and bounded by the limit`, and its `postgres (Bun.SQL)` counterpart |
| DR-10 | Read-only | `due_review` is `STABLE`; calling it takes no sequence value | implemented | `server/db/due-review.test.ts`: `the selector is read-only: it is STABLE, and calling it takes no sequence value and stores nothing` |
| DR-11 | Privileges | `school_app` may execute `due_review` and `open_lesson_encounter`, and may not read `encounters` | implemented | `server/db/due-review.test.ts`: `school_app reaches the selector and the review open only as functions, never the tables behind them` |
| DR-12 | Flagged items excluded | A flagged item's answers drive no review (RFC 2 §2) | planned: not applicable until flags exist, because the record has no flag rows before generated quizzes (RFC 2 step 3) | none |

## Faded quizzes

RFC 5 §4.6 and §4.7 (flyingrobots/school#219). The oracle is RFC 5 Table 4.6 and the worked
example of §4.3: a clean answer's stability is one day and grows by 2.5 with each clean answer a
delay later, so strength is exactly one half one stability after the refresh, and below it a
millisecond later. Contract cases are titled `<adapter>: due review: faded...`, on both drivers.

DR-5, DR-6 and DR-H1 used to ask about a clean quiz more than one stability after its answer. With
this rule, that quiz comes back, so their queries now sit inside one stability. Their expected
outputs and what each tests are unchanged ([RFC 5 Table 4.6a](../../rfc/0005-mastery-that-fades.md#46-due-review-one-added-rule)).

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| DR-F-G1 | Golden: RFC 5 §4.3 | A quiz answered cleanly is not due one day on, at exactly one half; 1 ms later it is `due-review/faded`, with `answeredAt` and `lastSeen` its answer, `corrected: false`, `shown: []` and `school.mastery`'s evidence. Answered cleanly then, it returns 2.5 days on, citing both first tries | implemented | `faded, golden (RFC 5 §4.3): a quiz answered cleanly comes back once a whole stability has passed, citing mastery's evidence` |
| DR-F-1 | Within one stability | A settled quiz at strength 0.5^0.8, past the delay, does not come back | implemented | `faded: a settled quiz still within one stability of its refresh does not come back, though the delay has passed` |
| DR-F-2 | Ranking and the limit (edge) | Wrong, aided, unknown aid, then faded, lowest strength first, then by `seq`; limits 10, 5, 4, 3 (already filled by the weak rules), 2 and 0 | implemented | `faded: items rank after the three weak rules, lowest strength first, then by seq, and fill only what the weak ones leave of the limit` |
| DR-F-3 | Weak and faded (edge) | An aided and an unknown-aid quiz at strength 0.5^10 each come back once, under their weak rule | implemented | `faded: a quiz both weak and below one half in strength comes back once, under its weak rule` |
| DR-F-4 | Seen within the delay | A faded quiz answered again in its own episode waits `delay_ms` from that answer, and then cites the first try that refreshed it | implemented | `faded: a faded quiz answered again within the delay, after its first try, waits for the delay from that answer` |
| DR-F-5 | The three rules did not move (known failure mode, differential) | Seeded (`SCHOOL_TEST_SEED`), on PGlite: on random histories, at random times and limits, the weak items are exactly 0012's `due_review`'s, at the head of the list; the faded items are, by an independent reading of `school.mastery`, every eligible quiz in order, cut to the room left; with no faded quiz the two functions agree exactly. The seed reaches each kind of case | implemented | `server/db/faded-review.test.ts`: `on random histories the three weak rules return exactly what 0012's due_review does, and faded items only fill what they leave` |
| DR-F-6 | The function kept its shape | After 0014, `due_review` has 0012's signature, result, volatility, `SECURITY DEFINER`, `search_path` and grant | implemented | `server/db/faded-review.test.ts`: `0014 replaces due_review keeping its signature, result, volatility, security, search_path and grant` |
| DR-F-7 | A year of history (stress) | DR-9, unchanged: the weak rules fill the limit, so `school.mastery` is not read | implemented | DR-9 |
| DR-F-8 | A year of history, faded read in full (stress) | A year of synthetic history at limit 10,000 reads `school.mastery` for every settled quiz, returns fewer than the limit including `due-review/faded` items, and touches at most 100 buffer pages per page of the record, as in DR-9 | implemented | `server/db/due-review.test.ts`: `postgres (PGlite): due review: a year of history at limit 10000 reads mastery for every quiz touching at most 100 pages per page of the record`, and its `postgres (Bun.SQL)` counterpart |
| DR-F-C1 | The reason | RFC 5 §4.7's sentence; no score and no measure; the voice test refuses "forgot" and "attempt" too | implemented | `server/core/school.test.ts`: `due review on opening a lesson > a faded quiz's reason recalls the day it was found from memory and asks how it feels now`, and `... > each reason says in words why the item came back, ...` |

## Placing the items

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| DR-P1 | Snapshot and notes | The review is the encounter's snapshot. One note per item is stored for the block of this lesson and this encounter, citing the selector's evidence. The review block is answered in this encounter. | implemented | `opening a lesson with review snapshots the review and stores one note per item for the encounter` |
| DR-P2 | Reload shows the same | Inside the resume window, a reload resumes with the same page and notes, whether nothing is due now or other items are offered. An edited lesson, or a reload past the window, is a new encounter. | implemented | `a reload inside the resume window shows the same review, whatever the selector says now` |
| DR-P3 | Encounters before review | An encounter opened before migration 0006 (no `lesson_hash`) resumes; a change of capture version still starts a new one | implemented | `an encounter opened without review resumes when the lesson is opened with review machinery and nothing due` |
| DR-P4 | One write | A note the record refuses opens no encounter | implemented | `opening with a note the record refuses opens nothing: the encounter and its notes are one write` |
| DR-P5 | Two opens at once | Raced inside the database on a real Postgres: one encounter, opened by one caller and resumed by the other, with one set of notes | implemented | `server/adapters/bunsql.concurrency.test.ts`: `two opens of one lesson with review at once: one encounter, one set of notes (50 times)` |
| DR-P6 | READ COMMITTED | `open_lesson_encounter` refuses REPEATABLE READ, like `open_encounter`, and stores nothing | implemented | `server/adapters/bunsql.concurrency.test.ts`: `REPEATABLE READ > open_lesson_encounter refuses to run under it, and stores nothing` |
| DR-C1 | The core builds the page | The course's other quizzes are asked about, the lesson's own (nested included) are not, and the due ones go in a `school:review` section at the top, with one note each | implemented | `server/core/school.test.ts`: `due review on opening a lesson > the record is asked about the course's other quizzes, and the due ones go at the top in a Review section, a note each` |
| DR-C2 | Gone, or nothing due | An item the course no longer has is skipped; nothing due leaves the lesson as written | implemented | `due review on opening a lesson > an item the course no longer has is skipped; nothing due leaves the lesson as written` |
| DR-C3 | Not asked | No other quizzes, or a record that keeps no exposures, asks the selector nothing | implemented | `due review on opening a lesson > no other quizzes, or a record that keeps no exposures, asks for no review` |
| DR-C4 | Reasons in words | Each rule's reason as in the README, with no score | implemented | `due review on opening a lesson > each reason says in words why the item came back, with the day of the answer that decided it` |
| DR-B1 | Reserved ids | An authored id starting `school:` is refused; `schoolwork` is not | implemented | `server/blocks.test.ts`: `a block id under school: is School's own, for what it adds to a lesson (its Review section), and is rejected` |
| DR-H1 | Over HTTP | The next lesson's `lesson` has the Review section at its top and `review` the reason; a reload has the same encounter, page and reason; the review answer is not progress in that lesson | implemented | `server/review.test.ts`: `the next lesson opens with the item due in a Review section at its top, its reason in words, and a reload shows the same` |
| DR-H2 | Slides | The slides view carries no review | implemented | `server/review.test.ts`: `the slides view records nothing, so it carries no review` |
| DR-W1 | The page | In Chrome, the Review heading and the item come before the lesson's own quiz, under "Ready for another look" and its reason; after an answer, a reload shows the same reason and the quiz settled | implemented | `web/test/lesson.test.ts`: `delayed review (flyingrobots/school#32) > an item answered wrong first comes back at the top of the next lesson with its reason in words, and a reload shows the same` |

## Help for the whole encounter

RFC 6 §5.1 and Table 5.2 (flyingrobots/school#224). The oracle is the rule itself: an `ai-help`
exposure aids every quiz answer and explanation of its encounter with a larger `seq`. Contract
cases are titled `<adapter>: aid: ai-help: <case>`, `<adapter>: due review: ai-help: <case>` or
`<adapter>: mastery: ai-help: <case>`, on both drivers.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| AH-G1 | Golden: help, then first tries | Every quiz answer and explanation after it in the encounter is aided | implemented | `ai-help, golden: help for the whole encounter before a first try makes every quiz and explain block in it aided` |
| AH-1 | Help after the first try | The answers before it keep no recorded aid; the ones after it are aided | implemented | `ai-help: help after a first try leaves it unaided, and aids the answers after it` |
| AH-2 | Another encounter | Help in one encounter aids nothing in another | implemented | `ai-help: help in one encounter aids nothing in another` |
| AH-3 | Aid not tracked | An untracked or unknown encounter is `rejected`, and nothing is stored | implemented | `ai-help: an untracked or unknown encounter is rejected, and nothing is stored` |
| AH-4 | Stored once | A resend is `duplicate`; the id naming another encounter, or a block's exposure, is `conflict` either way | implemented | `ai-help: help is stored once: a resend is a duplicate, and its id naming something else a conflict` |
| AH-5 | Two helps | Each is its own row of evidence, with no block | implemented | `ai-help: help is evidence of its encounter with no block, and two helps are two rows` |
| AH-6 | Due as aided | Every quiz answered right after help is `due-review/aided-first-try`, `shown: ["ai-help"]`, citing the help and the first try | implemented | `ai-help: every quiz answered right after help returns as aided, citing the help and its first try` |
| AH-7 | Due review after the first try | Help after a right first try brings nothing back; a quiz first tried after it comes back | implemented | `ai-help: help after a right first try does not bring it back; a quiz first tried after it does come back` |
| AH-8 | Two helps cited | Both helps and a block's hint are cited in `seq` order; `ai-help` is named once | implemented | `ai-help: two helps before a first try are both cited, and named once` |
| AH-9 | Wrong first try | The help before the correction is cited and named | implemented | `ai-help: a wrong first try cites the help shown before its correction` |
| AH-10 | Mastery reads it | A first try after help returns stability to one day and the quiz has not settled | implemented | `mastery: ai-help: a first try after help for the whole encounter is aided there too: stability returns to one day` |
| AH-F1 | Random interleavings (fuzz) | Seeded (`SCHOOL_TEST_SEED`): a submission is aided exactly when a help precedes it by `seq`; the seed reaches helps, aided and unaided answers | implemented | `ai-help: under random interleavings of help and answers, a submission is aided exactly when a help precedes it` |
| AH-S1 | NULL block for another kind (known failure mode) | The table refuses a NULL `block_id` for every other kind, and a block for `ai-help` (`exposures_block`) | implemented | `server/db/ai-help.test.ts`: `the table refuses an exposure of any other kind with no block, and an ai-help exposure with one` |
| AH-S2 | Only the server's function stores it | `record_lesson_help` refuses every other kind; `record_exposure` never stores `ai-help` | implemented | `server/db/ai-help.test.ts`: `record_lesson_help stores only ai-help, and record_exposure never stores it` |
| AH-S3 | Signatures | `record_lesson_help` is added; `record_exposure`, `submission_aid`, `due_review`, `quiz_episodes` and `mastery` keep theirs | implemented | `server/db/ai-help.test.ts`: `0012 adds record_lesson_help(exposure_id, encounter_id, kind, at), and every reader of aid keeps its signature` |
| AH-S4 | Exposures before 0012 | A database at 0011 with an exposure migrates, and it still aids only its block | implemented | `server/db/ai-help.test.ts`: `a database with exposures recorded before 0012 migrates, and those exposures still aid only their own block` |
| AH-H1 | Over HTTP | `POST /api/exposure` refuses `ai-help` with a block, a NULL block or none (400), and stores nothing | implemented | `server/exposure.test.ts`: `POST /api/exposure refuses an ai-help exposure, and nothing is stored` |
| AH-C1 | The reason | `ai-help` is "asking about the lesson", as RFC 6 Table 5.2 words it | implemented | `server/core/school.test.ts`: `due review on opening a lesson > help for the whole encounter is named as asking about the lesson` |
