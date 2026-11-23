# The lesson page

Reference: what `/courses/:course/lessons/:lesson` in the web app (`web/`) does.

## What it shows

The page asks `GET /api/courses/:course/lessons/:lesson` for the lesson in the web view, which
opens or resumes the learner's encounter, and renders the lesson's blocks in order:

| Block | Rendered with |
| --- | --- |
| `page` | The frame: breadcrumb, title, subtitle, then its children |
| `section` | A heading (`h2`, one level deeper per nested section) and its children |
| `prose`, `card`, `quote`, `aside` | The block's HTML through the registry `markdown` item, which sanitises it; plain, in a Card, in an Item, in an Alert |
| `quiz` | The registry `quiz` block, answering through `POST /api/answer` |
| `explain` | The registry `explain` block, saving through `POST /api/explanation` and grading through `POST /api/grade` |
| `nest` | The registry `nest` block |

From the `xl` breakpoint an outline of the lesson's sections sits beside the blocks. Links to the
previous and next lessons close the page; the first lesson has no previous link and the last no
next one.

The frame and the reading blocks are the `@flyingrobots/lesson` registry block
(`web/src/components/lesson.tsx`, installed with the shadcn CLI, never edited here). School's own
code, `web/src/pages/lesson.tsx` and `web/src/lib/school-api.ts`, loads the lesson and wires the
blocks to the API.

## What it records, and what it shows on load

- Every verdict and grading on screen is the server's. The lesson JSON carries each choice's
  `correct` flag; the page's parser drops it, so nothing in the page can read it.
- An answer, a saved explanation and a grading attempt are each one request. The page shows a
  verdict or a saved state only after the server answered with it; a request that fails (School
  down, a refusal, a reply of the wrong shape) leaves the block as it was, with an error, and the
  learner can try again. Typed text is kept.
- On load the page shows what the encounter holds: each quiz by its latest answer (settled when it
  is right, wrong with the other choices open when it is not), each explain block by its latest
  explanation and that explanation's latest grading (saved, graded, or not graded with a retry).
  This is `pageShows` in `server/contract/learner-history.ts`. Every answer stays in the record; a
  quiz answered wrong then right shows as settled on the right one.
- Each submission's `ms` is the time since the lesson was shown.
- The page opens the lesson without `?aid=`: it does not record the help it shows, so its
  encounters have aid tracking off (flyingrobots/school#51).
- There is no outbox yet: an answer made while School is down is not queued
  (flyingrobots/school#28).

## States

| State | Shows |
| --- | --- |
| Loading | Skeletons in the lesson's shape and a Spinner |
| Not found | "Lesson not found", when School answers 404 for the course or the lesson, with a link back to the course |
| Did not load | "The lesson did not load", when School cannot be reached or its reply is not a lesson, with Try again |

## Keys

Each section heading and each block is a focus stop for the app shell's key layer, outside the Tab
order. `j`/`k` and `↓`/`↑` step through the lesson in reading order, and the browser scrolls each
stop into view. Inside a block, its own keys win: a quiz's number keys and arrows, the nest's tree
keys, a text field's typing. Tab moves into a block's controls. See the decision in
[the app shell's keys](../app-shell/README.md#keys).

## Tests

`web/test/lesson.test.ts` drives the page in Chrome through playwright-core against the Vite dev
server; each browser context answers the page's `/api` requests from a real School process serving
the development course in `web/test/fixtures/course`, and a fake bridge fails or succeeds each
grading on cue. Like the shell
tests, it needs `npm ci` in `web/` and Google Chrome.

