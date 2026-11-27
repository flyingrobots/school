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
| COURSE-13 | Keys during the intro | With the page's clock paused before it loads, so the lessons are held before they fade in, pressing `j` once per focus stop in the main region reaches each one in order; the intro then finishes with every lesson at full opacity | implemented | `a course with lessons > j pressed during the intro reaches every focus stop in order` |
| COURSE-14 | Reference with unreadable lessons | A course whose lessons fail validation still shows the Reference button to `/courses/:c/reference` (flyingrobots/school#115) | implemented | `states > an unreadable course still offers its reference documents` |
| COURSE-15 | Browser title | The tab reads `<course> · School` (the course name the API lists) | implemented | `a course with lessons > the browser title names the course` |
| COURSE-16 | Safe-mode note | An untrusted course (`trusted: false` from `GET /api/courses/:c`) shows one Alert with role `note` and the safe-mode words (flyingrobots/school#210) | implemented | `an untrusted course > shows a neutral safe-mode note, as the API reports it untrusted` |
| COURSE-17 | No note when trusted | A trusted course shows no safe-mode note | implemented | `an untrusted course > a trusted course shows no such note` |
| COURSE-18 | Note's colours | In a light and a dark colour scheme, the note's background and text are the resolved `--card` and `--card-foreground`, and differ between the two | implemented | `an untrusted course > the note takes the theme's card colours, in light and in dark` |
| COURSE-19 | Declaration | The example course (`.agents/skills/school/example`): `GET /api/courses/:c` gives its `course.json`'s summary, author and license, and the page shows the summary, "By <author>" and "License: <license>", the last two as Badges (flyingrobots/school#277) | implemented | `a course's declaration > the example course shows its summary, author and license, as the API gives them` |
| COURSE-20 | Nothing declared | A course with no `course.json` (the API gives null for each key) shows no part of a declaration | implemented | `a course's declaration > a course that declares none of them shows nothing extra` |
| COURSE-21 | Declaration with unreadable lessons | A course whose lessons cannot be read still shows the summary, author and license its `course.json` declares | implemented | `a course's declaration > a course whose lessons cannot be read still shows its declaration` |
| COURSE-22 | Declaration's colours | In a light and a dark colour scheme, the summary's text is the resolved `--muted-foreground`, and the license Badge's text and border the resolved `--foreground` and `--border`, its text differing between the two | implemented | `a course's declaration > the summary and badges take the theme's colours, in light and in dark` |
