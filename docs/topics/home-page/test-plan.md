# Home page test plan

The contract ledger for [the home page](README.md). Every case runs in `bun test`. The server
cases run against the real School process and both adapters of the learning record; the page
cases drive Chrome through playwright-core against the Vite dev server, with the page's `/api`
requests answered by a real School server whose progress the test records through
`POST /api/answer`, or by a stubbed route where the case is a failure.

## Where the learner left off (server)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| HOME-S1 | Empty record | `lastStudied()` is null | implemented | `server/contract/learning-record.ts`, run per adapter: `where the learner left off is null on an empty record` |
| HOME-S2 | Latest activity | The course and lesson of the latest opening, answer, explanation or view, with its time, after each one | implemented | `server/contract/learning-record.ts`: `where the learner left off is the lesson of their latest opening, answer, explanation or view` |
| HOME-S3 | Refused submissions | An answer the record refuses does not move it | implemented | `server/contract/learning-record.ts`: `an answer the record refuses does not move where the learner left off` |
| HOME-R1 | Nothing studied | `resumeFrom(null, …)` starts the first lesson of the first course that has one | implemented | `server/core/school.test.ts`: `resumeFrom > nothing studied starts the first lesson of the first course that has one` |
| HOME-R2 | Mid-lesson | A lesson with a quiz not yet answered correctly is continued, with that quiz's question, in document order | implemented | `resumeFrom > a lesson with a quiz still to answer correctly is continued, with that quiz's question, in document order` |
| HOME-R3 | Lesson finished | The next lesson after it that is not finished; a reading lesson (no quizzes) counts as not finished | implemented | `resumeFrom > a finished lesson leads to the next one not finished, and a reading lesson counts as not finished` |
| HOME-R4 | End of course | Wraps to the first lesson of the course still to finish; when none is left, `finished` | implemented | `resumeFrom > at the end of a course it wraps to the first lesson still to finish, and says when none is left` |
| HOME-R5 | Gone | A last lesson or course no longer served falls back to the course's start, or the first course | implemented | `resumeFrom > a lesson or course no longer served falls back to its course's start, or the first course` |
| HOME-R6 | No lessons anywhere | `nothing` | implemented | `resumeFrom > with no lessons anywhere there is nothing to study` |
| HOME-A1 | Course progress | `GET /api/courses` gives each course's `quizzes` and `answeredCorrectly`, `null` for a course whose lessons cannot be read | implemented | `server/home.test.ts`: `a fresh record starts the first lesson, and every course's progress is told in counts` |
| HOME-A2 | Resume over HTTP | `GET /api/resume`: `start` on a fresh record, `continue` with the next question after an answer, `next` once the lesson is finished | implemented | `server/home.test.ts`: that case, `after an answer the lesson is continued, with the next question still to answer`, `once the lesson is finished, the next lesson is up` |

## The page (browser)

Every case is in `web/test/home.test.ts`, over two records the test writes: one where Astronomy is
started and Biology is not, and one where both are.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| HOME-1 | Hero, new course | The question of a course not started yet is the `h1`, with "New for you", the course title and place, the teaser and the figure; nothing in the figure runs; `↵` on load opens the lesson | implemented | `the hero > asks the question of a course not started yet, with its teaser and figure, and Enter starts it` |
| HOME-2 | Hero, all started | The lesson to continue, "Pick up where you left off" and Continue; a lesson without a hook shows its title | implemented | `the hero > when every course is started, it is the lesson to study now, with Continue` |
| HOME-14 | Hero, studied before | With every started course finished, a new course is "New for you", not "Start here" | implemented | `the hero > a learner who has studied, with every started course finished, is offered the new course as new, not as a start` |
| HOME-3 | Still ahead | The other unfinished lessons, the one partway through first and marked, each linking to its lesson | implemented | `still ahead > lists the other unfinished lessons, the one partway through first and marked, each linking to its lesson` |
| HOME-4 | Feedback | Lesson, course, prompt, summary, each criterion as Meets / Partly / Not yet, graded-by badge, Write a new draft linking to the explanation | implemented | `since you were last here > the newest feedback names its lesson and course, each criterion in words, and links to a new draft` |
| HOME-5 | Review | Course and lesson, question, Answer opening another lesson in the course, and the why popover with the reason in School's voice | implemented | `since you were last here > a question ready for another look names its course and lesson, and says why it's back` |
| HOME-6 | Timeline | Days studied counted in words; a past mark opens its day in the letter's place; `t` returns to today and `[` steps back | implemented | `since you were last here > the timeline shows the days studied, and a mark opens its day in the letter's place; t comes back to today` |
| HOME-7 | No scores | No `%`, "score", "points" or letter grade on the page | implemented | `words, not scores > shows no percentage, letter grade or score anywhere` |
| HOME-8 | Loading | A Spinner and a Skeleton while what's ahead loads, then the hero | implemented | `states > while what's ahead loads, it shows a Spinner and a Skeleton, then the hero` |
| HOME-9 | What's ahead fails | The Alert with the server's reason; feedback still shows; Try again recovers the hero | implemented | `states > what's ahead failing is reported with Try again, and the rest of the page still loads` |
| HOME-10 | Parts fail alone | Feedback, review and the timeline each fail with their own Alert, and the hero still shows | implemented | `states > feedback, review and the timeline each fail on their own` |
| HOME-11 | Quiet day | No feedback and nothing to review says "Nothing new since you were last here" | implemented | `states > a quiet day says nothing is new` |
| HOME-12 | Nothing ahead | An empty showcase says "Nothing ahead right now" | implemented | `states > nothing ahead says so` |
| HOME-13 | Width | No sideways scroll at 390, 768, 1024 and 1440 px | implemented | `layout > never scrolls sideways, from a phone to a wide screen` |
| HOME-14 | Timeline width | At 1440 px the timeline card spans the section above today's detail, every label inside the timeline and at least 12 px tall | implemented | `layout > the timeline spans the section above today's detail, at a readable size, every label inside it` |
| HOME-17 | Learner's zone | With the browser in Pacific/Kiritimati, the home page's activity and review requests and a lesson's request each send `tz=Pacific/Kiritimati`; the server reads days and reasons in the zone sent and refuses one that is not a zone | implemented | `the learner's zone > the home page and a lesson send the browser's time zone with every request that names a day`; `server/since.test.ts`: `activity reads days in the zone the page sends, and refuses one that is not a zone`, `a question's reason names the day it was answered in the zone the page sends`; `server/review.test.ts`: `a lesson opened with the learner's zone names the day in it, and refuses a zone that is not one` |
