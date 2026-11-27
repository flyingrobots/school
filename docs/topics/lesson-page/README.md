# The lesson page

Reference: what `/courses/:course/lessons/:lesson` in the web app (`web/`) does.

## What it shows

The page opens the lesson in the web view with `POST /api/courses/:course/lessons/:lesson`, a
JSON request with `?aid=1` and the browser's `?tz=`. That opens the learner's encounter, or
resumes the one already open. The open is a POST so that no other page can open an encounter
with a GET, such as an `<img>` (flyingrobots/school#321). Opening twice, as a reload or React's
development double effect does, resumes the same encounter.

The page renders the lesson's blocks in order:

| Block | Rendered with |
| --- | --- |
| `page` | The frame: breadcrumb (Home, the course by its title from the sidebar's course list, or by its name until that answers; see [a course's folder](../course-format/README.md)), title, subtitle, then its children |
| `section` | A heading (`h2`, one level deeper per nested section) and its children |
| `prose`, `card`, `quote`, `aside` | The block's HTML through the registry `markdown` item, which sanitises it; plain, in a Card, in an Item, in an Alert |
| `quiz` | The registry `quiz` block, answering through `POST /api/answer` |
| `explain` | The registry `explain` block, saving through `POST /api/explanation` and grading through `POST /api/grade` |
| `nest` | The registry `nest` block |

A link in that HTML to School's own site, relative (`/aion/README.md`) or with School's own
origin written out, is a plain link and opens in the same tab, as a full page load. A link to any
other origin opens Streamdown's "Open external link?" confirmation first, and opens in a new tab
once confirmed. The `markdown` item decides this by resolving the link against the page's address;
it cannot tell an app route from a file under a source mount, so both open in the same tab.

From the `xl` breakpoint an outline of the lesson's sections sits beside the blocks. Links to the
previous and next lessons close the page; the first lesson has no previous link and the last no
next one.

Under the title a **Slides** button (`P`) opens the same lesson in [the slides view](#the-slides-view),
and **Read aloud** (`R`) reads the lesson aloud, with a playback bar at the bottom of the page and
none of its answers ([reading aloud](../reading-aloud/README.md)).

The frame and the reading blocks are the `@flyingrobots/lesson` registry block
(`web/src/components/lesson.tsx`, installed with the shadcn CLI, never edited here). School's own
code, `web/src/pages/lesson.tsx` and `web/src/lib/school-api.ts`, loads the lesson and wires the
blocks to the API.

## Review items

A lesson can open with quizzes from elsewhere in the course brought back for delayed review
([due review](../due-review/README.md)). They arrive inside the lesson the API returns, in a section
titled "Review" at its top (id `school:review`), and the reply's `review` lists each one's reason.
The page renders that section like any other. Above each review quiz it shows a stock `Alert`
titled "Ready for another look", with the reason in words, for example "On 21 November, you found
this one on a second go. It's back so you can answer it from memory.", then the lesson it is from as a link to
that lesson: "It's from Orbits." A review quiz is answered and recorded
like the lesson's own. The review is part of the encounter's snapshot, so a reload shows the same
items with the same reasons.

## What it records, and what it shows on load

- Every verdict and grading on screen is the server's. The lesson JSON carries each choice's
  `correct` flag; the page's parser drops it, so nothing in the page can read it.
- The page shows a verdict or a saved state only after the server answered with it. An answer or
  explanation goes through the outbox (below); a grading attempt is one request, and one that fails
  leaves the block as it was, with an error and a retry. Typed text is kept.
- On load the page shows what the encounter holds: each quiz by its latest answer (settled when it
  is right, wrong with the other choices open when it is not), each explain block by its latest
  explanation and that explanation's latest grading (saved, graded, or not graded with a retry).
  This is `pageShows` in `server/contract/learner-history.ts`. Every answer stays in the record; a
  quiz answered wrong then right shows as settled on the right one.
- Each submission's `ms` is the time since the lesson was shown.
- A saved explanation can be revised (Revise, or `r`): the learner writes again from the saved
  text and saves a new explanation. Both stay in the record.

## The outbox

Every answer, explanation and exposure goes through an outbox (`web/src/lib/outbox.ts`,
flyingrobots/school#28) so that a submission made while School cannot be reached survives the tab
closing. It is a delivery queue, never a record of progress.

- Each item is written to IndexedDB (`school-outbox`, committed with strict durability) under the
  id it will be stored with, before it is sent. It leaves the outbox only when School has answered
  it for good: stored or `duplicate` (delivered), or refused (400 or 409; for an exposure also
  501). Because the id is the one it was made with, a resend is stored once (ADR 9).
- Items are sent one at a time in the order they were made, across tabs. A pass stops at the first
  item School cannot be reached for, so an exposure is always sent before the submission made after
  it, and two answers to one block arrive in order and the first stays the first try.
- It is resent at once, then with backoff (0.5 s doubling to 5 s), when the browser fires `online`,
  when the tab is shown again, and when any page of the app is opened (`web/src/main.tsx`).
- While a submission waits, its block shows it as **Not sent yet** with a Spinner: the quiz on the
  chosen answer, the explain block on Save, the text kept and the model answer still hidden. Nothing
  else can be chosen or saved in that block until School answers. The registry blocks' `queued`
  state and `pending` prop do this.
- On load the page reads the outbox before the lesson, then shows what School's record holds plus
  the waiting submissions of the same encounter, each marked not sent yet until School answers it.
  The outbox never supplies a verdict or a saved explanation; those come from School's reply.
- A refusal is shown in the block, "School refused this answer (conflict) …", and the submission is
  dropped, never retried. A refusal of a submission from a tab that is gone is shown the next time
  a lesson page in this tab opens; it is held in memory only, so if every tab closes first it is not
  shown.
- When this browser will not keep it (IndexedDB missing, refusing or failing, as in some private
  modes), items are kept in memory only, and a submission is send-or-fail: if School cannot be
  reached at once, it is dropped and the block says that School could not be reached, that this
  browser cannot keep it to send later, and that it was not recorded.
- Pending items of another encounter (a lesson whose encounter changed while they waited) are still
  sent to their own encounter but are not shown on the new one.

## The help it records

The page opens every lesson with `?aid=1`: it declares aid capture version 1 (RFC 2 §3), so its
encounters are tracked. It then records, through `POST /api/exposure`, each time it shows help for
a block:

| Kind | When the page records it |
| --- | --- |
| `feedback` | A quiz shows its explanation ("Why"): after a right answer, or on load for a quiz already answered right |
| `model-answer` | An explain block shows its model answer: after an explanation is saved, or on load for one already saved |
| `feedback` | An explain block shows a succeeded grading's findings: after a grading succeeds, or on load for an explanation already graded. A failed grading is never feedback. It is help for that block alone (RFC 8 §4.6) |
| `reference` | One of an explain block's sources is opened |
| `hint` | Never: no block type carries a hint yet |

- Each showing is recorded once, under a UUID the page makes, so a resend is stored once. Showing
  the same help again (a reload, the model answer after a revision, or the grading of a revision)
  is a new showing and a new record. Collapsing and reopening the model answer is not; closing and reopening a source is.
- The quiz and explain blocks say when they show help (`onWhyShown`, `onModelShown`,
  `onFeedbackShown`, `onSourceOpened`); `web/src/pages/lesson.tsx` turns each call into one
  exposure.
- Exposures go through the outbox ahead of anything submitted after them, so School sees the help
  before the work that came after it. While one cannot be sent, the submission waits behind it and
  the block shows it as not sent yet.
- An exposure School answers 400 or 409 is final and not resent, and so is 501, which a record that
  stores no exposures would answer (the server on Postgres never does). Nothing about exposures is
  ever shown to the learner.
## The slides view

`/courses/:course/lessons/:lesson?view=slides` presents the lesson as slides (flyingrobots/school#43),
through the `@flyingrobots/slides` registry block (`web/src/components/slides.tsx`). It records
nothing.

- The page asks `GET /api/courses/:course/lessons/:lesson?view=slides`, with no `?aid=`. The
  server answers with the lesson and its neighbours and opens no encounter (ADR 9, RFC 1 "Views").
  The page sends no write request: no answer, explanation, exposure or grading. It does not read
  or write the outbox. The outbox that every page of the app starts (`web/src/main.tsx`) still
  delivers submissions an earlier web view left waiting; the slides view adds none.
- Each top-level block of the lesson is one slide, and a section is one slide with everything in
  it. Only the current slide is in the page. The lesson's title and breadcrumb stay above it.
- Blocks render as they do in the web view, except that quizzes and explain blocks are read only.
  A quiz shows its question and its choices, all disabled, marked **Read only**, with no key hints
  and no "Why". An explain block shows its prompt only, with no field, Save button, model answer or
  sources. Nothing on a slide can be answered, and no help is shown that would need recording. The
  review section is never part of it, because review comes with an encounter.
- The position is in words, "Slide 2 of 5", announced politely, with a Progress bar under it.
- A GSAP timeline brings each slide in from the side it came from, then its blocks in order. With
  reduced motion the slide is simply there.
- **Web view** (`Esc`) goes back to the web view of the lesson, on the client.

| Keys | Do |
| --- | --- |
| `←` `↑` `h` `k` `PageUp` | Previous slide |
| `→` `↓` `l` `j` `PageDown` | Next slide |
| `Home`, `End` | First slide, last slide |
| `Esc` | The web view |

Every key's `Kbd` hint is on screen under the slides, and Previous, Next and Web view carry theirs.
The slides take focus when they open. Their keys act while focus is in the slides or on the page
itself, never while it is in the sidebar, so the app shell's keys still work there. In the slides
the vertical keys move between slides rather than focus, which is the issue's acceptance ("arrows
and hjkl move between slides"); a slide taller than the window scrolls with the mouse or trackpad.

## States

| State | Shows |
| --- | --- |
| Loading | Skeletons in the lesson's shape and a Spinner |
| Not found | "Lesson not found", when School answers 404 for the course or the lesson, with a link back to the course |
| Did not load | "The lesson did not load", when School cannot be reached or its reply is not a lesson, with Try again |

The slides view shows the same three states.

## Browser title

The tab reads `<lesson title> · <course> · School` in both views, `Lesson not found · <course> · School`
when the lesson is missing, and `<course> · School` while it loads or when it did not load. Checked by
`browser title > names the lesson, its course and School, in the web view and in slides` and
`browser title > a lesson that is not found says so in the title` in `web/test/lesson.test.ts`.

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
`web/test/explain.test.tsx` check that each block calls `onWhyShown`, `onModelShown`,
`onFeedbackShown` and `onSourceOpened` exactly once per showing, under React strict mode, and that
Revise works. In `web/test/lesson.test.ts`, against School on `pglite:`, the "aid tracking", "every
exposure the page shows is recorded once per showing", "RFC 2 Figure 4 over the page" and "an
exposure that did not reach School" groups check `?aid=1`, one exposure per kind and showing, the
order submit, model answer, revision, resends by the same id, and that 400, 409 and 501 are final.
Its "feedback for an explanation" test reads the record itself, with School stopped: one `feedback`
exposure to the explain block once a grading succeeds, none for a failed one, a second on reload,
and none to any other block.

The outbox is tested in the "the outbox (flyingrobots/school#28)" group, with each context's
network switched off in its `/api` route and tabs closed and reopened in one browser profile: an
answer and an explanation made offline, the tab closed and reopened online, each stored once under
its own id; a lost reply resent as a `duplicate`, one row; no IndexedDB (private mode) as
send-or-fail with its message; a queued answer answered 409 or 400 shown and never resent; two
answers to one block queued from two tabs, stored in order with the first as the first try; and 50
queued answers flushed at once, each sent once, in order. "the server down" and "an exposure that
did not reach School" check that a submission waits as not sent yet and goes by itself once School
is back. The blocks' queued state and pending prop are tested in `web/test/quiz.test.tsx` and
`web/test/explain.test.tsx`. The Figure 4
case reads the derived aid from `GET /api/aid/:submissionId`: no recorded aid for the first
explanation, aided for the revision.

The "links in lesson prose (flyingrobots/school#125)" group serves a course of its own, written
when the test starts so its prose can name the Vite server's origin: a relative, a same-origin
and an external link. The first two must be links with an `href` that open the course's orbits lesson in the
same tab with no confirmation and no new tab; the external one must show the confirmation and
neither navigate nor open a tab.

The "the slides view (flyingrobots/school#43)" group uses a School of its own for its first case:
it walks every slide, tries to answer the read-only quiz, and checks that no request other than a
GET was sent, that every lesson request was `?view=slides` with no `?aid=`, and that
`GET /api/resume` and the record itself (`lastStudied`, read with School stopped) hold no activity.
The web view of the same lesson then opens an encounter, so the oracle can see one. The other cases
check that each pair of keys and Home and End move between slides with the position in words, that
a slide animates in its first frame unless the context asks for reduced motion, and that the Slides
button, `P`, `Esc` and Web view go between the two views on the client. `web/test/slides.test.tsx`
tests the registry slides block on its own, including that its keys do nothing while focus is
elsewhere; `web/test/quiz.test.tsx` and `web/test/explain.test.tsx` test the read-only blocks.

The "delayed review" group seeds the record with an answer from two days ago before School starts.
It checks that the Review section and its reason come before the lesson's own quiz, and that a
reload after answering shows the same reason with the quiz settled.
