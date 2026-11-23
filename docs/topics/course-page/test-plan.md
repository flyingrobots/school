# Course page test plan

The contract ledger for [the course page](README.md). Every case runs in `bun test` from
`web/test/course.test.ts`: Chrome through playwright-core, the Vite dev server, and a real School
server whose progress the test records through `POST /api/answer`.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| COURSE-1 | A course with lessons | Every lesson from `GET /api/courses/:c`, in order, with its title and "N of M quizzes answered correctly" (or "No quizzes") computed from that response | implemented | `a course with lessons > lists every lesson, in order, with its progress in words, matching the API` |
| COURSE-2 | No scores | No `%`, "score", "grade", `N/M` or progress bar on the page | implemented | `a course with lessons > shows no percentage, letter or score` |
| COURSE-3 | Lesson links | A lesson links to `/courses/:c/lessons/:l` and opens it without a page load | implemented | `a course with lessons > each lesson links to its lesson page, routed on the client` |
| COURSE-4 | Keys | `j` reaches the lessons in order and `↵` opens the focused one | implemented | `a course with lessons > the lessons are reachable with j and k, and Enter opens one` |
| COURSE-5 | Reference | A course with reference documents links to its reference page | implemented | `a course with lessons > links to the course's reference when it has reference documents` |
| COURSE-6 | Width | One column at 390 px, three lessons side by side at 1920 px | implemented | `a course with lessons > uses the width: one column on a phone, several on a wide screen` |
| COURSE-7 | Loading | Skeletons and a Spinner while the request is held, gone once it answers | implemented | `states > while the course loads, it shows Skeletons and a Spinner, then the lessons` |
| COURSE-8 | No lessons | A course with no lessons folder shows "No lessons yet" | implemented | `states > a course with no lessons says so` |
| COURSE-9 | Unreadable course | A course whose lessons fail validation answers 200 with `lessons: null` and `lessonsError`; the page shows "This course could not be read" and that reason | implemented | `states > an unreadable course says it could not be read, with the server's reason` |
| COURSE-10 | Unknown course | A 404 shows "There is no course called …" | implemented | `states > a course that does not exist says so` |
| COURSE-11 | Unreachable server | A refused connection shows "This course could not be loaded", not endless loading | implemented | `states > a server that cannot be reached is reported, not shown as loading forever` |
| COURSE-12 | Try again | After a failure, Try again asks again and shows the lessons | implemented | `states > Try again asks the server again and shows the lessons once it answers` |
| COURSE-13 | Reference with unreadable lessons | A course whose lessons fail validation still shows the Reference button to `/courses/:c/reference` (flyingrobots/school#115) | implemented | `states > an unreadable course still offers its reference documents` |
