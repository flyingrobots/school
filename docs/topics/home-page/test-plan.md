# Home page test plan

The contract ledger for [the home page](README.md). Every case runs in `bun test`. The server
cases run against the real School process and both adapters of the learning record; the page
cases drive Chrome through playwright-core against the Vite dev server, with the page's `/api`
requests answered by a real School server whose progress the test records through
`POST /api/answer`, or by a stubbed route where the case is a failure.

## Where the learner left off (server)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| HOME-S1 | Empty record | `lastStudied()` is null | planned | |
| HOME-S2 | Latest activity | The course and lesson of the latest opening, answer, explanation or view, with its time, after each one | planned | |
| HOME-S3 | Refused submissions | An answer the record refuses does not move it | planned | |
| HOME-R1 | Nothing studied | `resumeFrom(null, …)` starts the first lesson of the first course that has one | planned | |
| HOME-R2 | Mid-lesson | A lesson with a quiz not yet answered correctly is continued, with that quiz's question, in document order | planned | |
| HOME-R3 | Lesson finished | The next lesson after it that is not finished; a reading lesson (no quizzes) counts as not finished | planned | |
| HOME-R4 | End of course | Wraps to the first lesson of the course still to finish; when none is left, `finished` | planned | |
| HOME-R5 | Gone | A last lesson or course no longer served falls back to the course's start, or the first course | planned | |
| HOME-R6 | No lessons anywhere | `nothing` | planned | |
| HOME-A1 | Course progress | `GET /api/courses` gives each course's `quizzes` and `answeredCorrectly`, `null` for a course whose lessons cannot be read | planned | |
| HOME-A2 | Resume over HTTP | `GET /api/resume`: `start` on a fresh record, `continue` with the next question after an answer, `next` once the lesson is finished | planned | |

## The page (browser)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| HOME-1 | Every course | Every course from `GET /api/courses`, in order, with its progress in words computed from that response | planned | |
| HOME-2 | No scores | No `%`, "score", "grade", `N/M` or progress bar on the page | planned | |
| HOME-3 | Continue | The lesson from `GET /api/resume`: its title, progress in words and next question, linking to the lesson | planned | |
| HOME-4 | One key | On load, `↵` opens the lesson to continue | planned | |
| HOME-5 | First visit | A fresh record shows "Start here" with the first lesson | planned | |
| HOME-6 | Loading | Skeletons and a Spinner while the requests are held, gone once they answer | planned | |
| HOME-7 | Courses fail | A failure of `GET /api/courses` is shown with Try again, which recovers | planned | |
| HOME-8 | Resume fails | A failure of `GET /api/resume` is shown, and the courses are still listed | planned | |
| HOME-9 | No courses | An empty course list shows an Empty state | planned | |
| HOME-10 | Width | One column at 390 px; the lesson and the courses side by side at 1280 px | planned | |
| HOME-11 | Keys | `j` reaches every course in order and `↵` opens the focused one | planned | |
