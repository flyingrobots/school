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
- A saved explanation can be revised (Revise, or `r`): the learner writes again from the saved
  text and saves a new explanation. Both stay in the record.
- There is no outbox yet: an answer made while School is down is not queued
  (flyingrobots/school#28).

## The help it records

The page opens every lesson with `?aid=1`: it declares aid capture version 1 (RFC 2 §3), so its
encounters are tracked. It then records, through `POST /api/exposure`, each time it shows help for
a block:

| Kind | When the page records it |
| --- | --- |
| `feedback` | A quiz shows its explanation ("Why"): after a right answer, or on load for a quiz already answered right |
| `model-answer` | An explain block shows its model answer: after an explanation is saved, or on load for one already saved |
| `reference` | One of an explain block's sources is opened |
| `hint` | Never: no block type carries a hint yet |

- Each showing is recorded once, under a UUID the page makes, so a resend is stored once. Showing
  the same help again (a reload, or the model answer after a revision) is a new showing and a new
  record. Collapsing and reopening the model answer is not; closing and reopening a source is.
- The quiz and explain blocks say when they show help (`onWhyShown`, `onModelShown`,
  `onSourceOpened`); `web/src/pages/lesson.tsx` turns each call into one exposure.
- Before a block's next answer or explanation, the page resends any of that block's exposures that
  School has not answered and waits for them, so School sees the help before the work that came
  after it. While one cannot be sent, the submission is not sent either, and the block says it was
  not saved.
- An exposure School answers 400 or 409 is final and not resent, and so is 501, which a record that
  stores no exposures would answer (the server on Postgres never does). Nothing about exposures is
  ever shown to the learner.
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

The help the page records is tested at two levels. `web/test/quiz.test.tsx` and
`web/test/explain.test.tsx` check that each block calls `onWhyShown`, `onModelShown` and
`onSourceOpened` exactly once per showing, under React strict mode, and that Revise works. In
`web/test/lesson.test.ts`, against School on `pglite:`, the "aid tracking", "every exposure the
page shows is recorded once per showing", "RFC 2 Figure 4 over the page" and "an exposure that did
not reach School" groups check `?aid=1`, one exposure per kind and showing, the order submit,
model answer, revision, resends by the same id, and that 400, 409 and 501 are final. The Figure 4
case reads the derived aid from `GET /api/aid/:submissionId`: no recorded aid for the first
explanation, aided for the revision.
