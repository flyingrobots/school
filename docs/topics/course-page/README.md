# The course page

Reference: what `/courses/:course` shows. The page sits in the [app shell](../app-shell/README.md)
and reads one endpoint, `GET /api/courses/:course`.

## What it shows

- The course's title as the page heading, under a breadcrumb back to Home: the `title` of
  `GET /api/courses/:course`, which is the course's name when it declares none
  ([a course's folder](../course-format/README.md)). Before that answers, the title from the
  sidebar's course list, or the name from the address.
- What the course's `course.json` declares about itself ([a course's folder](../course-format/README.md)),
  under the heading: its `summary` as a line of muted text, then its `author` ("By …") and
  `license` ("License: …", the SPDX expression as declared) as outline Badges. Each shows only when
  the course declares it, so a course that declares none shows nothing more. It is shown even when
  the course's lessons cannot be read, since the API still gives it.
- A **Reference** button to `/courses/:course/reference` (the [reference page](../reference-page/README.md)), only when the course has reference
  documents. It is shown even when the course's lessons cannot be read.
- For an untrusted course (`trusted: false`; [trusted and untrusted courses](../course-format/README.md#trusted-and-untrusted-courses)), a note under the heading, **Shown in safe mode**: "This course is shown in safe mode: its pages can’t run scripts. Its lessons and quizzes work as usual." It is the registry's Alert in its default variant, the card's colours in light and dark, with the role `note` rather than `alert`, since nothing is wrong. A trusted course shows no note.
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

## Each lesson's mastery

`GET /api/courses/:course` also gives each lesson `mastery`, how its quizzes are holding now (RFC 5 §4.5; flyingrobots/school#220). The page does not show it yet; RFC 5 step 5 puts it in words on each lesson's card.

| Field | Counts the lesson's quizzes that are | The learner will read it as |
| --- | --- | --- |
| `notStarted` | Never answered in this course | Not started yet |
| `settling` | Answered, but due review's weak rules still hold them | Still settling |
| `holding` | Settled, at half strength or more | Holding |
| `faded` | Settled, below half strength | Ready for another look |

_Table 1. The four counts in `mastery`, as [mastery](../mastery/README.md#rolling-up-to-lessons-and-courses) defines them. They partition the lesson's quizzes, so they sum to its `quizzes`._

```json
{"id": "l1", "title": "Orbits", "subtitle": "Round and round", "quizzes": 4, "answeredCorrectly": 2,
 "mastery": {"notStarted": 1, "settling": 1, "holding": 1, "faded": 1}}
```

_Listing 1. One lesson of `lessons`, with one quiz in each state, as `server/course-mastery.test.ts` reads it._

The server reads the counts from `school.mastery_rollup`, one group per lesson, at its own clock and with the twenty-hour delay due review uses (`REVIEW_DELAY_MS`), so they agree with the review a lesson opens with. Nothing the client sends moves that clock. A lesson with no quizzes has zero in every state. The counts are never a percentage or a score, and the rollup's mean strength is not in the response. Every other field is as before; a course whose lessons cannot be read still has `lessons: null`, and an untrusted course's response keeps its safe-mode headers.

In short: each lesson says how many of its quizzes are not started, settling, holding or faded, now, by the server's clock.

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

The browser title is `<course> · School`, with the course's name as the API lists it.
