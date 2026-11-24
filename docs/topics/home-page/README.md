# The home page

Reference: what `/` shows. The page sits in the [app shell](../app-shell/README.md). It leads with
something to look forward to, then shows what happened since the learner was last here
(flyingrobots/school#166). It reads five endpoints independently, so one failing never hides the
others, and checks every reply with Zod (`web/src/lib/home-api.ts`) before showing it.

## What it shows

1. **The hero**: one lesson, as the question it answers, its teaser and its figure, from
   `GET /api/showcase` ([a lesson's hook](../course-format/README.md#a-lessons-hook)). Its question
   is the page's `h1`.

   | When | The hero | Label | Button |
   | --- | --- | --- | --- |
   | A served course is not started yet (none of its quizzes answered correctly) | The first lesson still ahead in the first such course | "New for you", or "Start here" when no course is started | Start lesson N |
   | Every course is started, and `GET /api/resume` says `continue` | The lesson to continue | "Pick up where you left off" | Continue |
   | Every course is started, and resume says `next` or `start` | That lesson | "Up next" | Start |
   | Otherwise | The first lesson still ahead | "Up next" | Start |

   It names the course by its title and the lesson's place ("The Mathematics of Bells · Lesson 1
   of 7: Bells that can't hurry"), and links to the course's lessons. A lesson without a hook
   shows its title as the question and its subtitle as the teaser, with no figure. The figure is
   the course's SVG, kept to drawing (`web/src/lib/figure.ts`): it must be one `<svg>` element, and
   scripts, `foreignObject`, embedded documents, styles, animation, event handlers and links are
   removed before it is shown. Its lines draw themselves unless the viewer prefers reduced motion.
2. **Still ahead in your courses**: every other lesson from `GET /api/showcase`, as a carousel of
   cards, each with its question, teaser, figure (or a book icon), course and place, linking to the
   lesson. The lesson the learner is partway through (resume's `continue`) comes first, marked
   "You're partway".
3. **Since you were last here**: two columns from `lg`, one on a phone.
   - **On the left**, today's letter: the newest feedback (`GET /api/feedback`), titled "Your
     explanation of <lesson>", with its prompt, the grader's summary, each criterion as a word
     (Meets, Partly, Not yet; never a score) with its note, a robot badge naming who graded it, and
     **Write a new draft**, linking to the explanation in its lesson. Then **Ready for another
     look** (`GET /api/review`): each question with its course and lesson, the day it was
     answered, an ⓘ button that answers "Why am I being asked this?" on hover or tap, and
     **Answer**, which opens the next lesson ahead in its course, where the question comes back.
     When there is neither, it says "Nothing new since you were last here".
   - **On the right**, the timeline (`GET /api/activity?days=14`): a lane per course, a dot per day
     studied in the last 14 days, and a ring per day questions come back in the next 14, larger for
     more. A course with neither says "not started yet". The heading counts the days studied in
     words. Every mark is a button: a past day opens "You studied on <day>" in the letter's place, a
     ring opens how many questions come back that day and why. Today opens the letter again.

## Keys

When the page loads, focus starts on the hero's button, unless something else already has it, so
`↵` starts the lesson. `[` and `]` step to the earlier and later mark on the timeline, and `t`
returns to today; the timeline shows these keys. `j` and `k` move between the page's links and
buttons as everywhere in the shell. Key hints are hidden on touch screens.

## States

| Part | Loading | Failed |
| --- | --- | --- |
| Hero and carousel | A Spinner, "Finding what's next", and a Skeleton | "What's ahead could not be loaded", with the reason when given, and **Try again** |
| Feedback | A Skeleton | "Your feedback could not be loaded" and **Try again** |
| Review | A Skeleton | "Questions to review could not be loaded" and **Try again** |
| Timeline | A Skeleton | "Your timeline could not be loaded" and **Try again** |

When `GET /api/showcase` answers with nothing, the page says "Nothing ahead right now".

## Layout

The page never scrolls sideways, from a phone to a wide screen. The carousel's arrows sit inside its
padding, and the carousel is kept from widening the page (`contain: inline-size`). The hero's
figure takes a column of at most 22rem from `md`, below the text on a phone.

## Code and tests

The page is `web/src/pages/home.tsx`, with `web/src/components/home-letter.tsx` (feedback and
review) and `web/src/components/home-timeline.tsx`, composed of stock shadcn components (Card,
Carousel, Badge, Button, Item, Popover, Alert, Empty, Skeleton, Spinner, Kbd). The server side is
`showcaseJson`, `feedbackJson`, `reviewJson`, `activityJson` and `resumeJson` in
`server/server.ts`. [The test plan](test-plan.md) lists every case and its test.

The page sets the browser title to `School`, through `useDocumentTitle` (see [the app shell](../app-shell/README.md#browser-titles)).
