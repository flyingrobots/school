# A course's folder

Reference: what School reads from a course's folder, the one `SCHOOL_COURSES` (or `SCHOOL_COURSE`,
or `SCHOOL_UNTRUSTED_COURSES` for [an untrusted course](#trusted-and-untrusted-courses)) names, or that an install puts in the course store ([an installed course's folder](#an-installed-courses-folder)). School reads the folder and never writes to it ([ADR 6](../../adr/0006-separate-framework-lessons-and-learner-state.md)).

| Path | Required | Holds | Read |
| --- | --- | --- | --- |
| `course.json` | no | The course's declaration about itself: its title and, optionally, its summary, author, license and course format | Once, when the server starts |
| `lessons/*.json` | no | The lessons, one block-JSON page per file, in file-name order | On every request, so an edit shows without a restart |
| `reference/**` | no | Reference documents, and any file beside them, served read-only at `/courses/:course/reference/<path>` | On every request |

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
| `school.check.manifest` | stdout | `summary`, `author`, `license` and `format`, each null when not declared | Just before `done`, on success; not printed with `--human` |
| `school.check.done` | stdout | `ok`, `folder`, `title` (null when none is declared), `lessons` (each `file`, `id`, `title`, `quizzes`, `explains`), and the course's `quizzes` and `explains` | Last, before exit 0 |
| `school.check.error.invalid` | stderr | `error`, `code` (1), `file` (`course.json`, a lesson file, or null for a problem across files, such as an unknown ref), `message` | School would refuse the course |
| `school.check.error.usage` | stderr | `error`, `code` (2), `message` | A bad argument or no such folder |
| `school.check.error.failed` | stderr | `error`, `code` (1), `message` | Anything else went wrong |

A quiz or explain block reused through `ref` counts once. `school.check.done` stays at 1.0.0, so a consumer written against it still validates every line; the manifest has a message of its own. `--human` adds the summary, then the
author, license and format, on lines of their own after the lessons, leaving out any the course
does not declare.

The checks are also a function for code in `server/`: `checkCourse(folder)` in
`server/check-course.ts` returns, for a passing course, `ok: true` with the `done` line's fields
and a `manifest` holding the manifest line's four; for a refused one, `ok: false` with the
`folder`, `file` and `message` the error line would carry. A folder that does not exist is a
refusal with `file` null. The program prints its lines from this result.

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
{"_schema":{"id":"school.check.start","version":"1.0.0"},"kind":"school.check","event":"start","folder":"$DIR","run":"9cdab92a-44e4-4edf-a871-dfe8e02e92de","at":"2026-11-26T23:45:45.220Z"}
{"_schema":{"id":"school.check.manifest","version":"1.0.0"},"kind":"school.check","event":"manifest","summary":null,"author":null,"license":null,"format":null,"run":"9cdab92a-44e4-4edf-a871-dfe8e02e92de","at":"2026-11-26T23:45:45.223Z"}
{"_schema":{"id":"school.check.done","version":"1.0.0"},"kind":"school.check","event":"done","ok":true,"folder":"$DIR","title":"Rounds","lessons":[{"file":"0001-rounds.json","id":"rounds","title":"Rounds","quizzes":1,"explains":0}],"quizzes":1,"explains":0,"run":"9cdab92a-44e4-4edf-a871-dfe8e02e92de","at":"2026-11-26T23:45:45.223Z"}
$ ./school --human check $DIR
checking $DIR
ok: Rounds, 1 lesson, 1 quiz, 0 explain blocks
  0001-rounds.json  Rounds  (1 quiz, 0 explain blocks)
```

The same course once its `course.json` also declares
`"summary": "Ring the bells in order.", "license": "CC-BY-4.0", "format": 1`; only the `manifest`
line differs, and `done` carries nothing new:

```text
$ ./school check $DIR          # exit 0
{"_schema":{"id":"school.check.start","version":"1.0.0"},"kind":"school.check","event":"start","folder":"$DIR","run":"54ed9571-73c1-4045-9d62-abf613bd2cb6","at":"2026-11-26T23:45:45.360Z"}
{"_schema":{"id":"school.check.manifest","version":"1.0.0"},"kind":"school.check","event":"manifest","summary":"Ring the bells in order.","author":null,"license":"CC-BY-4.0","format":1,"run":"54ed9571-73c1-4045-9d62-abf613bd2cb6","at":"2026-11-26T23:45:45.364Z"}
{"_schema":{"id":"school.check.done","version":"1.0.0"},"kind":"school.check","event":"done","ok":true,"folder":"$DIR","title":"Rounds","lessons":[{"file":"0001-rounds.json","id":"rounds","title":"Rounds","quizzes":1,"explains":0}],"quizzes":1,"explains":0,"run":"54ed9571-73c1-4045-9d62-abf613bd2cb6","at":"2026-11-26T23:45:45.364Z"}
$ ./school --human check $DIR
checking $DIR
ok: Rounds, 1 lesson, 1 quiz, 0 explain blocks
  0001-rounds.json  Rounds  (1 quiz, 0 explain blocks)
summary: Ring the bells in order.
license CC-BY-4.0; format 1
```

## Extracting a course from a git commit

`extractCommit` in `server/extract-tree.ts` copies a course out of one commit of a bare git repository into a new folder, writing only what School reads and refusing anything that could escape the folder, run code or exhaust the disk. It is the extraction step of installing a course (RFC 7, "Installing courses", §4 and §6, which answers flyingrobots/school#188; this module is flyingrobots/school#235); nothing in School calls it yet, and fetching the commit is a separate step.

```ts
const result = await extractCommit({ repository: "/staging/abc/repo.git", commit: "<40 or 64 hex digits>", into: "/staging/abc/course" });
```

_Listing 1. Illustrative call. `into` must not exist and its parent must; `limits` (any of Table 2's fields) and `git` (the executable) are optional._

It reads the tree with `git ls-tree -r -t -l -z` and the files with one `git cat-file --batch`, never checking anything out. git runs with no system or global configuration, `HOME` set to `into`'s parent, `core.hooksPath=/dev/null`, replace objects off and literal pathspecs, so no hook, filter or attribute is ever consulted. Only entries under `course.json`, `lessons/` and `reference/` are listed. Every one of them is checked, and `git fsck --strict` asked about the commit, before anything is written; then the folder is created and each file written with exclusive creation and mode 0644, so an executable file is installed as an ordinary one. Of those entries it writes `course.json`, each `lessons/*.json` directly in `lessons/`, and every file anywhere under `reference/`; the rest (`lessons/notes.md`, `lessons/drafts/`) is skipped. Anything outside the three names, such as a `README.md`, `.github/` or a build script, is never read, written or refused.

On success it answers `{ ok: true, folder, commit, files, bytes }`, each file with its path and size. Otherwise it answers `{ ok: false, refusal: { reason, path, message } }` for the first problem found (every problem is a refusal; nothing is thrown for a commit's content), and `into` does not exist: a refusal found while writing deletes the folder. On 2026-11-26, a commit holding a `README.md` and a three-file course, then a commit whose `reference/passwd.html` is a symlink, with the scratch folder shown as `$STAGING`:

```text
{"ok":true,"folder":"$STAGING/good","commit":"e6b88299d432d5ed6f7b45ecd7d023f5b2262864","files":[{"path":"course.json","bytes":18},{"path":"lessons/0001-bells.json","bytes":3},{"path":"reference/glossary.html","bytes":12}],"bytes":33}
{"ok":false,"refusal":{"reason":"symlink","path":"reference/passwd.html","message":"\"reference/passwd.html\" is a symlink; School installs only regular files"}}
```

_Listing 2. Two results, printed with `JSON.stringify`. The README is not among the files written._

| `reason` | Refused when |
| --- | --- |
| `bad-destination` | `into` already exists, or its parent is not a folder |
| `not-a-commit` | `commit` is not a full lowercase hash, is not in the repository, or names a tree or blob |
| `unsafe-name` | A name is `.` or `..`, starts with `.git` in any case, holds `\` or a control character (C0, DEL or C1), or is not UTF-8; or git's own check finds a name holding `/` (`fullPathname`, such as a blob `a/b.html` beside a folder `a`) |
| `case-collision` | Two files, or two folders, are equal after Unicode NFC and full case folding (`ſ` and `s`, `ß` and `ss`, `ς` and `σ`, `ﬀ` and `ff`, `µ` and `μ`, the Kelvin sign and `k`), or one name appears twice in a tree (a blob and a folder included) |
| `symlink` | An entry is a symlink (mode `120000`), including `course.json` or `lessons` itself |
| `submodule` | An entry is a submodule (mode `160000`) |
| `lfs-pointer` | A file begins `version https://git-lfs.github.com/spec/v1`: School does not fetch LFS objects |
| `too-many-files` | More files than `files`, or more folders than `files × depth`, under the three names |
| `file-too-large` | An installed file is larger than `fileBytes` |
| `total-too-large` | The installed files together are larger than `totalBytes` |
| `path-too-long` | A file's path is longer than `pathBytes` bytes of UTF-8 (a folder's path is not measured) |
| `too-deep` | A file's path passes through more than `depth` folders (an empty folder's depth is not measured) |
| `timeout` | A git process ran longer than `gitMs`; it is killed |
| `git-failed` | git could not read the repository or the tree (an empty name is one: git refuses the tree itself) |

_Table 1. Every refusal. Sizes come from the listing, before any file is read; only the LFS check needs a file's content._

| Limit | Default |
| --- | --- |
| `files` | 2,000 |
| `fileBytes` | 8 MiB |
| `totalBytes` | 64 MiB |
| `pathBytes` | 255 |
| `depth` | 8 folders |
| `gitMs` | 60,000 ms per git process |

_Table 2. `DEFAULT_LIMITS`, RFC 7 Table 6.2's starting values. A caller may lower or raise any of them._

So a commit's course reaches disk only after every entry School would write has passed every check, and a refused one leaves nothing behind.

## An installed course's folder

An installed course is a course folder in the course store, `<SCHOOL_COURSE_STORE>/courses/<install id>/`, named by its install's id in the record, not by its course name (RFC 7 §5.1). It has the layout above and nothing else, since extraction writes only `course.json`, `lessons/*.json` and `reference/**`. School serves it under the name the record gives it ([the course list](../architecture/README.md#the-course-list)) and never writes to it after the install.

The record keeps the folder's content digest, `content_sha256`. `contentDigest` in `server/course-registry.ts` computes it:

1. Take every regular file under the folder, at any depth. Its path is relative to the folder, with `/` between names.
2. Write one line per file: the file's SHA-256 in lowercase hex, one space, its path, and a newline.
3. Sort the lines by path, comparing the paths' UTF-8 bytes.
4. The digest is the SHA-256 of all the lines together, in lowercase hex.

For example, a folder holding an empty `course.json` and `reference/deep/z.html` containing `abc` has this manifest:

```text
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 course.json
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad reference/deep/z.html
```

_Listing 3. The manifest of a two-file folder. The digest is the SHA-256 of these two lines, each ending in a newline._

A folder that holds anything but regular files and folders, such as a symlink, has no digest. School lists such a folder, or one whose digest is not the record's, or one that is missing, with `lessons: null` and the reason, and serves none of its files.

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

## Trusted and untrusted courses

A course from someone else can be served in safe mode, so its HTML cannot act as School. Name it in `SCHOOL_UNTRUSTED_COURSES` instead of `SCHOOL_COURSES`; the syntax is the same `name=path` pairs:

```sh
SCHOOL_COURSES=bells=/library/bells
SCHOOL_UNTRUSTED_COURSES=guest=/library/guest
```

_Listing 4. Two courses in `server/.env` (illustrative): `bells` is trusted, `guest` is in safe mode. Compose passes `SCHOOL_UNTRUSTED_COURSES` to the server as it does `SCHOOL_COURSES`._

A course in `SCHOOL_COURSES` or `SCHOOL_COURSE` is trusted, as it always was. An untrusted course is read from the same folder layout and works the same way, with four differences:

| What | For an untrusted course |
| --- | --- |
| Its reference documents and every other file under `reference/` | Served with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`: a page opened from it runs no script and cannot use School's API. An SVG file is served as `image/svg+xml` under the same sandbox |
| `GET /api/courses` and `GET /api/courses/:course` | `trusted: false` (a trusted course gives `trusted: true`); the course and lesson JSON carry the same two headers |
| Its hook figures on the home page | Drawn as an image, not inline SVG, so nothing in them runs; `GET /api/showcase` gives each item `trusted` |
| The course page and the sidebar | A note on the course page: "This course is shown in safe mode: its pages can’t run scripts." ([the course page](../course-page/README.md)); a **Safe mode** badge beside the course in the sidebar ([the app shell](../app-shell/README.md#the-sidebars-courses)) |

Lesson blocks are unchanged: their HTML is sanitised for every course, trusted or not ([lesson blocks](blocks.md)). A name in both lists, or a folder that is, contains or sits inside a trusted course's, stops the server at start with exit code 2, since the trusted course would serve the same files unsandboxed. So does a `SCHOOL_MOUNTS` or `SCHOOL_WEB` folder that is, contains or sits inside an untrusted course's. The headers and their reasons are in [trust and known defects](../architecture/README.md#trust-and-known-defects).

The choice is the operator's, never the course's: nothing in a course's folder can mark it trusted.

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
as declared or null when the course does not declare it. `school check` reports the last four on
its `manifest` line, and the title on `done`. The course page shows the summary, author and
license under its heading ([the course page](../course-page/README.md)).

### Licenses

`license` is an [SPDX license expression](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)
(SPDX 2.3, Annex D), checked by `server/spdx.ts`:

- Each license is an id on the [SPDX License List](https://spdx.org/licenses/), current or
  deprecated, matched without regard to case, optionally followed by `+` (this version or later);
  or a `LicenseRef-<name>` for a license of your own.
- `AND`, `OR` and `WITH` join them, in capitals. `WITH` binds tightest, then `AND`, then `OR`;
  parentheses group. The name after `WITH` is an id on the SPDX exceptions list, matched without
  regard to case; a `LicenseRef-` is not an exception.

The lists are `server/spdx-license-ids.ts`, copied from the `spdx-license-ids` package (3.0.24,
CC0-1.0), and `server/spdx-exception-ids.ts`, from `spdx-exceptions` (2.5.0, CC0-1.0), rather than
added as dependencies; a license or exception published after those releases is refused until the
lists are updated. School has no preference among licenses: any listed id is accepted.

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
| `figure` | no | SVG markup, kept to drawing; an untrusted course's is drawn as an image ([trusted and untrusted courses](#trusted-and-untrusted-courses)) |

A figure loses its `style` and `class` attributes and any `<style>` element before it is shown, so colour it with presentation attributes such as `fill="var(--primary)"` and `stroke="var(--chart-1)"`. A figure follows the light and dark themes when it is coloured with the theme's CSS variables:
`var(--primary)`, `var(--chart-1)` to `var(--chart-5)`, `var(--foreground)`,
`var(--muted-foreground)` and `var(--background)`. A hook missing its question or teaser, or with a
figure that is not a string, stops the lesson set from loading, like any other malformed block.

`GET /api/showcase` lists, in course order, every lesson with a quiz not yet answered correctly:
its course, the course's title, whether the course is trusted (`trusted`), whether the course is started (any of its quizzes answered
correctly), the lesson's id, title, subtitle and place, and its hook. A lesson without a hook
offers its title as the question and its subtitle as the teaser, with no figure. A lesson with no
quizzes is left out, as is a course whose lessons can't be read.
