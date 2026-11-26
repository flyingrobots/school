# A course's folder

Reference: what School reads from a course's folder, the one `SCHOOL_COURSES` (or `SCHOOL_COURSE`)
names. School reads the folder and never writes to it ([ADR 6](../../adr/0006-separate-framework-lessons-and-learner-state.md)).

| Path | Required | Holds | Read |
| --- | --- | --- | --- |
| `course.json` | no | The course's declaration about itself: its title and, optionally, its summary, author, license and course format | Once, when the server starts |
| `lessons/*.json` | no | The lessons, one block-JSON page per file, in file-name order | On every request, so an edit shows without a restart |
| `reference/*.html` | no | Reference documents, served read-only at `/courses/:course/reference/<file>` | On every request |

Anything else in the folder (`README.md`, `OBJECTIVES.md`, `RESOURCES.md`) is for the course's
authors and readers; School does not read it.

The blocks a lesson file is written in, and every rule they must meet, are in
[lesson blocks](blocks.md).

An agent writes and revises courses with the `school` skill,
[`.agents/skills/school/`](../../../.agents/skills/school/SKILL.md), which links to these pages
and ends with `school check`. Its `example/` is a small complete course.

## Checking a course

```text
./school check <folder> [--human]
./school check --help | --schema
```

`school check` loads a course folder with School's own loader, the one the server uses for
`course.json` and `lessons/`, and says whether School would serve it. It reads the folder, writes
nothing, and needs no secret and no Docker. Run it before saying a course is ready. The loader
stops at the first problem, so that is the one reported; fix it and run the check again.

| Exit | Means |
| --- | --- |
| 0 | School would serve the course; or `--help` or `--schema` printed |
| 1 | School would refuse it: the error line names the first problem. Or the check itself failed |
| 2 | No folder, more than one, an unknown argument, or a folder that does not exist. Nothing was checked |

Its output keeps [the programs' output contract](../program-output/README.md#the-contract): JSON
Lines on stdout and stderr, each line naming its schema in `server/schemas/check/`, with `kind`
`school.check`, an `event`, the invocation's `run` and the time (`at`). `--human` prints prose.

| `_schema.id` | Stream | Fields beyond the envelope | When |
| --- | --- | --- | --- |
| `school.check.help` | stdout | `command`, `usage`, `summary`, `options`, `exit`, `output` | First line of `--help` |
| `school.check.schema` | stdout | `id`, `version`, `schema` | `--schema`, and `--help` after its help line |
| `school.check.start` | stdout | `folder`, as an absolute path | First, once the arguments are accepted |
| `school.check.done` | stdout | `ok`, `folder`, `title`, `summary`, `author`, `license` and `format` (each null when not declared), `lessons` (each `file`, `id`, `title`, `quizzes`, `explains`), and the course's `quizzes` and `explains` | Last, before exit 0 |
| `school.check.error.invalid` | stderr | `error`, `code` (1), `file` (`course.json`, a lesson file, or null for a problem across files, such as an unknown ref), `message` | School would refuse the course |
| `school.check.error.usage` | stderr | `error`, `code` (2), `message` | A bad argument or no such folder |
| `school.check.error.failed` | stderr | `error`, `code` (1), `message` | Anything else went wrong |

A quiz or explain block reused through `ref` counts once. `--human` adds the summary, then the
author, license and format, on lines of their own after the lessons, leaving out any the course
does not declare.

On 2026-11-25, a one-lesson course in a temporary folder shown as `$DIR`, its quiz with two
correct choices:

```text
$ ./school check $DIR          # stdout
{"_schema":{"id":"school.check.start","version":"1.0.0"},"kind":"school.check","event":"start","folder":"$DIR","run":"0b1bfe66-e936-4db6-9c24-4b8e374fc0d8","at":"2026-11-25T12:50:55.941Z"}
$ ./school check $DIR          # stderr; exit 1
{"_schema":{"id":"school.check.error.invalid","version":"1.0.0"},"kind":"school.check","event":"error","error":"invalid","code":1,"file":"0001-rounds.json","message":"0001-rounds.json > rounds > q1: exactly one choice must be correct","run":"0b1bfe66-e936-4db6-9c24-4b8e374fc0d8","at":"2026-11-25T12:50:55.942Z"}
$ ./school --human check $DIR
checking $DIR
error (invalid) in 0001-rounds.json: 0001-rounds.json > rounds > q1: exactly one choice must be correct
```

On 2026-11-26, the same course with the second choice made wrong, its `course.json` declaring
only `{ "title": "Rounds" }`:

```text
$ ./school check $DIR          # exit 0
{"_schema":{"id":"school.check.start","version":"1.0.0"},"kind":"school.check","event":"start","folder":"$DIR","run":"a0854dcb-c3b6-46f4-865a-d5730b509292","at":"2026-11-26T22:33:04.028Z"}
{"_schema":{"id":"school.check.done","version":"1.1.0"},"kind":"school.check","event":"done","ok":true,"folder":"$DIR","title":"Rounds","summary":null,"author":null,"license":null,"format":null,"lessons":[{"file":"0001-rounds.json","id":"rounds","title":"Rounds","quizzes":1,"explains":0}],"quizzes":1,"explains":0,"run":"a0854dcb-c3b6-46f4-865a-d5730b509292","at":"2026-11-26T22:33:04.029Z"}
$ ./school --human check $DIR
checking $DIR
ok: Rounds, 1 lesson, 1 quiz, 0 explain blocks
  0001-rounds.json  Rounds  (1 quiz, 0 explain blocks)
```

The same course once its `course.json` also declares
`"summary": "Ring the bells in order.", "license": "CC-BY-4.0", "format": 1`:

```text
$ ./school check $DIR          # the done line; exit 0
{"_schema":{"id":"school.check.done","version":"1.1.0"},"kind":"school.check","event":"done","ok":true,"folder":"$DIR","title":"Rounds","summary":"Ring the bells in order.","author":null,"license":"CC-BY-4.0","format":1,"lessons":[{"file":"0001-rounds.json","id":"rounds","title":"Rounds","quizzes":1,"explains":0}],"quizzes":1,"explains":0,"run":"6eccee2d-a9aa-4813-b604-27af2dc6d539","at":"2026-11-26T22:33:04.131Z"}
$ ./school --human check $DIR
checking $DIR
ok: Rounds, 1 lesson, 1 quiz, 0 explain blocks
  0001-rounds.json  Rounds  (1 quiz, 0 explain blocks)
summary: Ring the bells in order.
license CC-BY-4.0; format 1
```

## More than one course under `./school up`

Compose mounts the course in `SCHOOL_COURSE_DIR` at `/course`. School calls that course `course`.
To serve more courses beside it, set two optional lines in `server/.env`:

```sh
SCHOOL_LIBRARY_DIR=../../school-bells   # mounted read-only at /library
SCHOOL_COURSES=bells=/library           # name=path pairs, paths inside the container
```

For a folder holding several courses, point `SCHOOL_LIBRARY_DIR` at the folder and name each one:
`SCHOOL_COURSES=bells=/library/bells,chess=/library/chess`. Without `SCHOOL_LIBRARY_DIR`, `/library`
is the course folder again, and nothing reads it unless `SCHOOL_COURSES` says so. Run `./school up`
again after changing either line.

## `course.json`

```json
{
  "title": "AIΩN Foundations",
  "summary": "The ideas under AIΩN, one question at a time.",
  "author": "The AIΩN authors",
  "license": "Apache-2.0",
  "format": 1
}
```

Only `title` is required. Every other key is optional, and a course that declares only a title, or
has no `course.json`, loads exactly as one did before they existed.

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `title` | yes | non-empty string | What the pages call the course: the sidebar, Home, the course page and every breadcrumb. Surrounding spaces are trimmed. |
| `summary` | no | non-empty string | What the course is, in a sentence. Surrounding spaces are trimmed. |
| `author` | no | non-empty string | Who wrote it. Surrounding spaces are trimmed. |
| `license` | no | SPDX license expression | The terms a learner, or anyone copying the course, may use it on, such as `MIT`, `MIT OR Apache-2.0` or `GPL-2.0-or-later WITH Classpath-exception-2.0`. Surrounding spaces are trimmed. |
| `format` | no | positive integer | The course format the course is written in. Today's, and the only one this School plays, is `1`. |

The course's **name**, the `name` in `SCHOOL_COURSES=name=path`, stays its slug: it is what
addresses carry (`/courses/aion`) and what the record stores. A course with no `course.json` is
called by its name everywhere a title would show.

`GET /api/courses` and `GET /api/courses/:course` give `name`, the slug; `title`, the course's
title or, when it declares none, its name; and `summary`, `author`, `license` and `format`, each
as declared or null when the course does not declare it. `school check` reports the same five on
its `done` line.

### Licenses

`license` is an [SPDX license expression](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)
(SPDX 2.3, Annex D), checked by `server/spdx.ts`:

- Each license is an id on the [SPDX License List](https://spdx.org/licenses/), current or
  deprecated, matched without regard to case, optionally followed by `+` (this version or later);
  or a `LicenseRef-<name>` for a license of your own.
- `AND`, `OR` and `WITH` join them, in capitals. `WITH` binds tightest, then `AND`, then `OR`;
  parentheses group. An exception after `WITH` is checked for its form only, since School carries
  no list of exceptions.

The list is `server/spdx-license-ids.ts`, copied from the `spdx-license-ids` package (3.0.24,
CC0-1.0) rather than added as a dependency; a license published after that release is refused
until the list is updated. School has no preference among licenses: any listed id is accepted.

### The course format

`format` says which course format the course is written in, so a School that does not play it says
so instead of serving it wrongly. This School plays format `1`. A course that declares any other
format is refused, naming both: `"format" is 2, but this School plays course format 1`. A course
that declares no format is played as format `1`.

### When the file is malformed

`course.json` is checked with Zod (`server/course-file.ts`) when the server starts, and by
`school check`. A file that is there but is not JSON, is not an object, has no `title`, has any
key above that is empty, only spaces, or of the wrong type, has a `license` that is not an SPDX
expression or names a license not on the list, declares a `format` other than `1`, or has any
other key, stops the start with exit code 2 and a line naming the course, the file and the key.
School does not start, so no course is half-loaded; `school check` exits 1 with the same message.
For a course at `/courses/aion` whose `title` is `42`, the server prints:

```text
school: course "aion": /courses/aion/course.json is not a course file: "title" Invalid input: expected string, received number. It must be an object such as {"title": "My Course"}
```

and for one whose `license` is `Frobnicate-1.0`:

```text
school: course "aion": /courses/aion/course.json is not a course file: "license" must be an SPDX license expression, such as "MIT OR Apache-2.0": unknown license "Frobnicate-1.0"; it is not on the SPDX License List (use LicenseRef-<name> for one of your own). It must be an object such as {"title": "My Course"}
```

The file is read only at start, so a change shows after a restart. Unknown keys are refused rather
than ignored, so a misspelt `tilte` or `licence` is caught instead of silently ignored.

The cases are in the [test plan](test-plan.md).

Lessons are written in [School's voice](../voice/README.md): an explain block's prompt is a
question, never a command.

## A lesson's hook

A lesson's page block may carry a `hook`: the question the lesson answers, a one-line teaser, and an
optional picture. The home page shows hooks for the lessons still ahead (`GET /api/showcase`, below).

```json
{
  "type": "page",
  "id": "the-plain-hunt",
  "title": "The plain hunt",
  "subtitle": "Repeat two changes and every bell starts weaving.",
  "hook": {
    "question": "Why does every bell trace the same zigzag?",
    "teaser": "Two changes, repeated, walk each bell to the back and home again.",
    "figure": "<svg viewBox=\"0 0 100 100\">…</svg>"
  },
  "children": []
}
```

*Abridged: the figure's markup is cut.*

| Key | Required | Holds |
| --- | --- | --- |
| `question` | yes | The question the lesson answers, in [School's voice](../voice/README.md) |
| `teaser` | yes | One line that makes the question worth answering |
| `figure` | no | SVG markup, trusted like a prose block's HTML |

A figure follows the light and dark themes when it is coloured with the theme's CSS variables:
`var(--primary)`, `var(--chart-1)` to `var(--chart-5)`, `var(--foreground)`,
`var(--muted-foreground)` and `var(--background)`. A hook missing its question or teaser, or with a
figure that is not a string, stops the lesson set from loading, like any other malformed block.

`GET /api/showcase` lists, in course order, every lesson with a quiz not yet answered correctly:
its course, the course's title, whether the course is started (any of its quizzes answered
correctly), the lesson's id, title, subtitle and place, and its hook. A lesson without a hook
offers its title as the question and its subtitle as the teaser, with no figure. A lesson with no
quizzes is left out, as is a course whose lessons can't be read.
