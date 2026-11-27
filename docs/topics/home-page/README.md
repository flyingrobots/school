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
   | A served course is not started yet (none of its quizzes answered correctly) | The first lesson still ahead in the first such course | "New for you", or "Start here" before the learner has studied anything | Start lesson N |
   | Every course is started, and `GET /api/resume` says `continue` | The lesson to continue | "Pick up where you left off" | Continue |
   | Every course is started, and resume says `next` or `start` | That lesson | "Up next" | Start |
   | Otherwise | The first lesson still ahead | "Up next" | Start |

   It names the course by its title and the lesson's place ("The Mathematics of Bells · Lesson 1
   of 7: Bells that can't hurry"), and links to the course's lessons. A lesson without a hook
   shows its title as the question and its subtitle as the teaser, with no figure. The figure is
   the course's SVG, kept to drawing (`web/src/lib/figure.ts`): it must be one `<svg>` element, and
   scripts, `foreignObject`, embedded documents, styles, raw-text elements, anything outside the
   SVG namespace, animation, event handlers, links and `style` and `class` attributes are removed
   before it is shown. A trusted course's figure is drawn inline and its lines draw themselves
   unless the viewer prefers reduced motion; an untrusted course's is drawn as an image, in the
   theme's current colours.
2. **Still ahead in your courses**: every other lesson from `GET /api/showcase`, as a carousel of
   cards, each with its question, teaser, figure (or a book icon), course and place, linking to the
   lesson. The lesson the learner is partway through (resume's `continue`) comes first, marked
   "You're partway".
3. **Since you were last here**: one column at every width.
   - **First**, the timeline, as wide as the page and drawn at that width so its labels stay one size (`GET /api/activity?days=14`): a lane per course, a dot per
     [study day](../../glossary.md#study-day) (a day with a quiz answered or an explanation saved; a
     visit alone is not one) in the last 14 days, and a ring per day questions come back in the next 14, larger for
     more, including a quiz on the day it fades. Each lane's heading says in words how the course's quizzes are holding
     today ([below](#how-each-course-is-holding)). The heading counts the days studied in
     words. Every mark is a button: a past day opens "You studied on <day>" below it, in the letter's place, a
     ring opens how many questions come back that day and why. Today opens the letter again.
   - **Below it**, today's letter: the newest feedback (`GET /api/feedback`), titled "Your
     explanation of <lesson>", with its prompt, the grader's summary, each criterion as a word
     (Meets, Partly, Not yet; never a score) with its note, a robot badge naming who graded it, and
     **Write a new draft**, linking to the explanation in its lesson, and **Read aloud** (`R`),
     which reads the feedback aloud ([reading aloud](../reading-aloud/README.md)). Then **Ready for another
     look** (`GET /api/review`): each question with its course and lesson, the day it was
     answered, an ⓘ button that answers "Why am I being asked this?" on hover or tap (questions that took a second go or a little help, and ones found from memory a while ago, to see how they feel now), and
     **Answer**, which opens the next lesson ahead in its course, where the question comes back.
     When there is neither, it says "Nothing new since you were last here".

## How each course is holding

Each lane names its course, then says how its quizzes are holding today, one Badge (the registry's,
`secondary`) per state that has any, in the words of [mastery](../mastery/README.md#rolling-up-to-lessons-and-courses)
(RFC 5 §4.7, §4.8; flyingrobots/school#222). The heading wraps on a narrow screen, and the lane
grows to fit it.

| `mastery` | The lane says |
| --- | --- |
| `holding` | "2 of 3 quizzes holding" |
| `settling` | "1 still settling" |
| `faded` | "1 ready for another look" |
| `notStarted`, some quizzes answered | "1 not started yet" |
| `notStarted`, no quiz answered, no study day and nothing coming back | "Not started yet", alone |

_Table 1. The words for each count. "Not started yet" alone is for a course with no study day and
nothing coming back, and with no quiz answered or no quizzes at all. A course with a study day and
no quiz answered (a lesson with only an explanation, say) says "3 not started yet" like any other
state; a course with no quizzes and a study day or a return says nothing._

The counts come from `GET /api/activity`: for each course, `quizzes` and `mastery`, read from
`school.mastery_rollup` with one group holding every quiz the course serves, at the server's clock
and with due review's twenty-hour delay, so they agree with **Ready for another look**. They are
never a percentage, and the rollup's mean strength is not in the response.

```json
{"course": "geo", "courseTitle": "Geology", "trusted": true, "studied": ["2026-11-24", "2026-11-25", "2026-11-27"],
 "due": [{"day": "2026-11-30", "items": 1}], "quizzes": 3,
 "mastery": {"notStarted": 1, "settling": 0, "holding": 1, "faded": 1}}
```

_Listing 1. One course of `courses` on 27 November: one quiz faded, one holding that has faded by
30 November, one never answered, as `server/activity-mastery.test.ts` reads it._

A faded quiz needs nothing of its own on the timeline: the rings ask [due review](../due-review/README.md#faded-quizzes)
at each day ahead, at that day's time, so a quiz comes back on the day its strength falls below
one half. One that has faded already is in today's review, not a ring. Nothing is kept in browser
storage: the page asks the server, which asks the database.

In short: each lane says how many of its course's quizzes are holding, settling, ready for another
look or not started, today, and each ring ahead includes the quizzes that fade that day.

## Keys

When the page loads, focus starts on the hero's button, unless something else already has it, so
`↵` starts the lesson. `[` and `]` step to the earlier and later mark on the timeline, and `t`
returns to today; the timeline shows these keys. `r` reads the newest feedback aloud, and while it
reads, `,` `.` `/` and `Esc` step, pause and stop ([the playback bar](../reading-aloud/README.md#the-playback-bar)). `j` and `k` move between the page's links and
buttons as everywhere in the shell. Key hints are hidden on touch screens.

## States

| Part | Loading | Failed |
| --- | --- | --- |
| Hero and carousel | A Spinner, "Finding what's next", and a Skeleton | "What's ahead could not be loaded", with the reason when given, and **Try again** |
| Feedback | A Skeleton | "Your feedback could not be loaded" and **Try again** |
| Review | A Skeleton, also while what's ahead loads, since each Answer opens a lesson from it (flyingrobots/school#205) | "Questions to review could not be loaded" and **Try again** |
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
`server/server.ts`, and `activity` in `server/core/school.ts`. [The test plan](test-plan.md) lists every case and its test.

The page sets the browser title to `School`, through `useDocumentTitle` (see [the app shell](../app-shell/README.md#browser-titles)).
