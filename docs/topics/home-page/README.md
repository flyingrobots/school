# The home page

Reference: what `/` shows. The page sits in the [app shell](../app-shell/README.md) and reads two
endpoints, `GET /api/resume` and `GET /api/courses`, independently: one failing does not hide the
other.

## What it shows

The page answers "what do I study now?" first.

1. **The heading, Home,** and a line saying when the learner last studied, in words ("You last
   studied 2 hours ago."), or that their first lesson is ready.
2. **The lesson to study now**, from `GET /api/resume`, as one card: a label, the lesson's place
   ("Lesson 2 of 4 in Astronomy", the course named by its title from the course list, or by its
   name until that answers), its title in large type, its subtitle, its progress in words,
   and, mid-lesson, **the next question still to answer**, written out. Its button opens the lesson
   at `/courses/:course/lessons/:lesson`; a second button opens the course.

   | `kind` | Label | Button | When |
   | --- | --- | --- | --- |
   | `continue` | Pick up where you left off | Continue | The lesson last studied has a quiz not yet answered correctly; the question shown is the first such quiz, in document order |
   | `next` | Up next | Start | That lesson is finished: the next lesson after it not yet finished (a reading lesson ahead counts as not finished), or, past the end, the first lesson with a quiz still to answer |
   | `start` | Start here | Start | Nothing studied yet, or the last course is no longer served: the first lesson of the first course that has one |
   | `finished` | Course finished | Open the course | Every quiz in the last course is answered correctly |
   | `nothing` | | | No course has a lesson: "Nothing to study yet" |

   "Last studied" is the latest encounter opened, answer or explanation stored, or view recorded
   (the record's `lastStudied`, see [architecture](../architecture/README.md)).
3. **Your courses**: every course from `GET /api/courses`, in the server's order (by name), each
   named by its title ([a course's folder](../course-format/README.md)) and a link to
   `/courses/:course`, with its lesson count, whether it has reference documents, and its
   progress in words. The list is the one the sidebar shows (see
   [the app shell](../app-shell/README.md#the-sidebars-courses)); opening the page asks for it
   again in the background, so the progress is current:

   | The API says | The page says |
   | --- | --- |
   | `quizzes: 8, answeredCorrectly: 3` | 3 of 8 quizzes answered correctly |
   | `quizzes: 0` (with lessons) | No quizzes |
   | `lessons: 0` | No lessons yet |
   | `lessons: null` | Its lessons could not be read |

   A course whose quizzes are all answered correctly carries a check mark. Progress is never a
   percentage, a letter or a score, and there is no progress bar (RFC 2 §4.3).

## Keys

When the page loads, focus starts on the card's button, unless something else already has it, so
`↵` opens the lesson to study now. The button shows its `↵` hint. `j` and `k` (the shell's focus
movement) move through the card's buttons and the courses, and `↵` opens the focused one; a line
under the courses shows those keys.

## Layout

One column on a phone: the card, then the courses. From `sm` the courses sit two to a row under the
card. From `lg` the card takes seven of twelve columns with the courses in one column beside it, and
from 2200 px wide the courses go two to a row again. Type steps up at `2xl`. A GSAP timeline brings
in the heading, the card and its parts, and the courses, animating opacity and position only (never
visibility, so the button can take focus while it comes in), unless the viewer prefers reduced
motion.

## States

| When | The page shows |
| --- | --- |
| A request is in flight | A Spinner with "Finding where you left off", a Skeleton in the card's place and Skeletons for the courses |
| `GET /api/courses` answers `[]` | An Empty state, "No courses yet", in place of the card and the list |
| `GET /api/courses` fails (unreachable, an error, or the wrong shape) | A destructive Alert, "Your courses could not be loaded", with the server's reason when it gave one, and **Try again** |
| `GET /api/resume` fails | A destructive Alert in the card's place, "Where you left off could not be loaded", with the reason when given, and **Try again**; the courses are still listed |

Both responses are checked with Zod before anything is shown.

## Code and tests

The page is `web/src/pages/home.tsx`, composed of stock shadcn components (Card, Badge, Button,
Item, Empty, Alert, Skeleton, Spinner, Kbd). The server side is `resumeFrom` and the `lastStudied`
use case in `server/core/school.ts`, the port method in both adapters, migration
`server/db/migrations/0003_last_studied.sql`, and `coursesJson` and `resumeJson` in
`server/server.ts`. [The test plan](test-plan.md) lists every case and its test.

The page sets the browser title to `School`, through `useDocumentTitle` (see [the app shell](../app-shell/README.md#browser-titles)).
