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

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| HOME-1 | Every course | Every course from `GET /api/courses`, in order, with its progress in words computed from that response | implemented | `web/test/home.test.ts`: `a learner who has studied > lists every course, in order, with its progress in words, matching the API` |
| HOME-2 | No scores | No `%`, "score", "grade", `N/M` or progress bar on the page | implemented | `a learner who has studied > shows no percentage, letter or score` |
| HOME-3 | Continue | The lesson from `GET /api/resume`: its title, progress in words and next question, linking to the lesson | implemented | `a learner who has studied > comes first with the lesson to continue: its progress and the next question, linking to it` |
| HOME-4 | One key | On load, `↵` opens the lesson to continue | implemented | `a learner who has studied > Enter, straight after the page loads, continues the lesson` |
| HOME-5 | First visit | A fresh record shows "Start here" with the first lesson | implemented | `a fresh record > starts at the first lesson of the first course` |
| HOME-6 | Loading | Skeletons and a Spinner while the requests are held, gone once they answer | implemented | `states > while the requests are in flight, it shows Skeletons and a Spinner, then the page` |
| HOME-7 | Courses fail | A failure of `GET /api/courses` is shown with Try again, which recovers | implemented | `states > a course list that cannot be loaded is reported, and Try again recovers` |
| HOME-8 | Resume fails | A failure of `GET /api/resume` is shown, and the courses are still listed | implemented | `states > where the learner left off failing is reported, and the courses are still listed` |
| HOME-9 | No courses | An empty course list shows an Empty state | implemented | `states > no courses at all says so` |
| HOME-10 | Width | One column at 390 px; the lesson and the courses side by side at 1280 px | implemented | `a learner who has studied > uses the width: one column on a phone, the lesson and the courses side by side on a laptop` |
| HOME-11 | Keys | `j` reaches every course in order and `↵` opens the focused one | implemented | `a learner who has studied > j reaches every course in order, and Enter opens the focused one` |
| HOME-12 | Browser title | The tab reads `School` | implemented | `a learner who has studied > the browser title is School` |
