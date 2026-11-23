# The course page

Reference: what `/courses/:course` shows. The page sits in the [app shell](../app-shell/README.md)
and reads one endpoint, `GET /api/courses/:course`.

## What it shows

- The course's name as the page heading, under a breadcrumb back to Home.
- A **Reference** button to `/courses/:course/reference` (the [reference page](../reference-page/README.md)), only when the course has reference
  documents. It is shown even when the course's lessons cannot be read.
- Every lesson, in the server's order, as a link to `/courses/:course/lessons/:lesson`. Each shows
  its title, its subtitle when it has one, and its progress in words:

  | The API says | The page says |
  | --- | --- |
  | `quizzes: 3, answeredCorrectly: 2` | 2 of 3 quizzes answered correctly |
  | `quizzes: 1, answeredCorrectly: 0` | 0 of 1 quiz answered correctly |
  | `quizzes: 0` | No quizzes |

  A lesson whose quizzes are all answered correctly carries a check mark. Progress is never a
  percentage, a letter or a score, and there is no progress bar.

The lessons fill a grid of one column on a phone, two from `sm`, three from `xl` and four from
`2xl`. A line under the grid shows the keys: `j` and `k` move between lessons (the shell's focus
movement) and `↵` opens the focused one. A GSAP timeline brings the heading and then the lessons
in, animating opacity and position only (never visibility, so `j` reaches a lesson while it fades
in), unless the viewer prefers reduced motion.

## States

| When | The page shows |
| --- | --- |
| The request is in flight | A Spinner with "Loading the lessons" and a grid of Skeletons |
| The course has no lessons (`lessons: []`, including a course with no lessons folder) | An Empty state, "No lessons yet" |
| The server answers 404 | An Empty state, "There is no course called …", with a link home |
| The lessons cannot be read (`lessons: null`, the reason in `lessonsError`, for lessons that never validated) | A destructive Alert, "This course could not be read", with the server's reason |
| No usable answer: the server is unreachable, or the body is not the expected shape | A destructive Alert, "This course could not be loaded", with **Try again** |

The response is checked with Zod before anything is shown; a body of the wrong shape is the last
row, never a half-drawn page.

## Code and tests

The page is `web/src/pages/course.tsx`, composed of stock shadcn components (Breadcrumb, Button,
Item, Badge, Empty, Alert, Skeleton, Spinner, Kbd). `web/test/course.test.ts` drives it in Chrome
against the Vite dev server, with the page's `/api` requests answered by a real School server over
course folders written by the test; [the test plan](test-plan.md) lists its cases.
