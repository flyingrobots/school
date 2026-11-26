# Course format test plan

The contract ledger for [a course's folder](README.md): the course title (flyingrobots/school#143), the course manifest (flyingrobots/school#209), a lesson's hook (flyingrobots/school#164), [lesson blocks](blocks.md) (flyingrobots/school#196) `school check` (flyingrobots/school#197) and the `school` skill (flyingrobots/school#193).
Every case runs in `bun test`. The server cases call the loader and start the real School process
on PGlite over course folders the test writes; the browser cases drive Chrome through
playwright-core against the Vite dev server, with `/api` answered by that real server.

## The title (server)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| FORMAT-1 | Declared | `readCourseFile` gives the `title` of a `course.json`, and null for each manifest key | implemented | `server/course-title.test.ts`: `readCourseFile > a course.json with a title gives that title` |
| FORMAT-2 | Not declared | A course with no `course.json` declares no title and no manifest key | implemented | `readCourseFile > a course with no course.json declares no title` |
| FORMAT-3 | Not JSON | Refused with a `CourseFileError` naming the file | implemented | `readCourseFile > a course.json that is not JSON is refused, naming the file` |
| FORMAT-4 | Wrong shape | A non-string, empty or missing `title`, an unknown key, or an array is refused, naming the file and the field | implemented | `readCourseFile > a course.json with %s is refused, naming the file and the field` |
| FORMAT-5 | Course list | `GET /api/courses` gives each course's `title`, and its name when it declares none | implemented | `the course API > GET /api/courses gives each course's title, and the slug for a course that declares none` |
| FORMAT-6 | One course | `GET /api/courses/:course` gives `title`, falling back to the name | implemented | `the course API > GET /api/courses/:course gives the course's title, falling back to the slug` |
| FORMAT-7 | Unreadable lessons | The title is given even when `lessons` is null | implemented | `the course API > GET /api/courses/:course gives the title even when the lessons cannot be read` |
| FORMAT-8 | Malformed at start | The server exits 2, naming the course and the file | implemented | `a malformed course.json stops the server at start, naming the course and the file` |

## The manifest (server, flyingrobots/school#209)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| MANIFEST-1 | Full manifest | `readCourseFile` gives `summary`, `author`, `license` and `format: 1`, the strings trimmed | implemented | `server/course-manifest.test.ts`: `readCourseFile: the manifest > MANIFEST-1: a course.json with a summary, author, license and format 1 gives each, trimmed` |
| MANIFEST-2 | Title only | Every manifest key is null | implemented | `MANIFEST-2: a course.json with only a title declares nothing else` |
| MANIFEST-3 | No file | The title and every manifest key are null | implemented | `MANIFEST-3: a course with no course.json declares nothing` |
| MANIFEST-4 | SPDX expressions | SPDX 2.3 Annex D: a single id, `OR`, `WITH` an exception, parentheses with `AND`, a trailing `+`, `LicenseRef-`, `DocumentRef-…:LicenseRef-…`, a lowercase id, a listed exception in any case; each given as declared | implemented | `MANIFEST-4: the license %p is an SPDX expression, and is given as declared` |
| MANIFEST-5 | Invalid values | An empty, whitespace-only or wrongly typed `summary`, `author` or `license`; an unknown SPDX id, alone or in an expression; an unknown exception after `WITH`, a `LicenseRef-` after `WITH`; a license in words, a dangling operator, an unclosed parenthesis, a lowercase operator; a `format` that is a string, not an integer, or zero: refused, naming the file and the key | implemented | `MANIFEST-5: a course.json with %s is refused, naming the file and the key` |
| MANIFEST-6 | Another format | `format: 2` is refused, naming the key and both versions | implemented | `MANIFEST-6: a course in a format this School does not play is refused, naming both versions` |
| MANIFEST-7 | Unknown key | An unknown key is still refused beside a full manifest | implemented | `MANIFEST-7: a key School does not know is still refused beside a full manifest` |
| MANIFEST-8 | One course | `GET /api/courses/:course` gives the declared values | implemented | `the course API: the manifest > MANIFEST-8: GET /api/courses/:course gives the declared summary, author, license and format` |
| MANIFEST-8b | Unreadable lessons | `GET /api/courses/:course` for a course whose lessons cannot be read gives `lessons: null` and still the declared values | implemented | `the course API: the manifest > MANIFEST-8b: GET /api/courses/:course gives the manifest when the lessons cannot be read` |
| MANIFEST-9 | Undeclared | `GET /api/courses/:course` gives null for each key, title only or no file | implemented | `MANIFEST-9: GET /api/courses/:course gives null for each key a course does not declare` |
| MANIFEST-10 | Course list | `GET /api/courses` gives each course's values, null where undeclared | implemented | `MANIFEST-10: GET /api/courses gives each course's manifest, null where undeclared` |
| MANIFEST-11 | Invalid at start | A whitespace-only `author` stops the server, exit 2, naming the course, the file and the key; nothing is served | implemented | `MANIFEST-11: an invalid manifest value stops the server at start, naming the course, the file and the key` |
| MANIFEST-12 | Another format at start | `format: 2` stops the server, exit 2, naming the file and the key | implemented | `MANIFEST-12: a course in another format stops the server at start, naming the file and the key` |

Fuzz and stress cases are not applicable: the inputs are four short fields with fixed rules.

## The title on the pages (browser)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| FORMAT-9 | Sidebar | A course link's text is its title, or its slug when it declares none; its `href` is `/courses/<slug>` | implemented | `web/test/course-title.test.ts`: `the sidebar > names each course by its title, and by its slug when it declares none, linking by slug` |
| FORMAT-10 | Home's hero | The hero names its course by its title and links to it by slug | implemented | `Home > the hero names its course by its title` |
| FORMAT-11 | Home's carousel | A course that declares no title is named by its slug in what's ahead | implemented | `Home > what's ahead names a course that declares no title by its slug` |
| FORMAT-12 | Course page | The heading and breadcrumb are the title | implemented | `the course page > its heading and breadcrumb name the course by its title` |
| FORMAT-13 | Course page fallback | The heading and breadcrumb are the slug for a course with no title | implemented | `the course page > a course that declares no title is named by its slug` |
| FORMAT-14 | Reference breadcrumb | Home / <title> / Reference, the course crumb linking by slug | implemented | `breadcrumbs below a course > the reference page's breadcrumb names the course by its title and links by slug` |
| FORMAT-15 | Lesson breadcrumb | Home / <title> / <lesson>, the course crumb linking by slug | implemented | `breadcrumbs below a course > the lesson page's breadcrumb names the course by its title and links by slug` |
| FORMAT-16 | Slides breadcrumb | Home / <title> / <lesson> in the slides view | implemented | `breadcrumbs below a course > the slides view's breadcrumb names the course by its title` |
| FORMAT-17 | Lesson fallback | Home / <slug> / <lesson> for a course with no title, once the course list has answered | implemented | `breadcrumbs below a course > a lesson in a course that declares no title has its slug in the breadcrumb` |

## A lesson's hook (flyingrobots/school#164)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| FORMAT-18 | Hook loads | A page's `hook`, with or without `figure`, loads with the page; a page without one has no `hook` | implemented | `server/blocks.test.ts`: `a lesson may declare a hook, and it loads with the page` |
| FORMAT-19 | Hook malformed | A hook missing `question` or `teaser`, with a non-string `figure`, or not an object, is rejected naming the lesson | implemented | `server/blocks.test.ts`: `a hook without its question or teaser, or with a figure that isn't text, is rejected, naming the lesson` |
| FORMAT-20 | What's ahead | `GET /api/showcase` lists lessons with a quiz not yet answered correctly, in course order; a reading lesson and an unreadable course are left out; without a hook, the title and subtitle stand in | implemented | `server/showcase.test.ts`: `on a fresh record every lesson with a quiz is ahead, in course order; without a hook, its title and subtitle stand in` |
| FORMAT-21 | Started and finished | A wrong answer starts nothing; a right one marks the course started; a lesson with every quiz right is no longer listed | implemented | `server/showcase.test.ts`: `a wrong answer starts nothing; a right one starts the course; a lesson with every quiz right is no longer ahead` |

## Lesson blocks (flyingrobots/school#196)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| FORMAT-22 | Examples load | Every `json` example on [lesson blocks](blocks.md) loads through `loadLibrary`; one that is not a page is wrapped in one | implemented | `server/block-reference.test.ts`: `the block reference > example %d loads through loadLibrary` |
| FORMAT-23 | Examples cover the format | Between them the examples show all nine block types and a `ref` | implemented | `the block reference > shows every block type and a ref` |

## `school check` (flyingrobots/school#197)

Every case runs the program as a process, and every line it prints is validated against its schema in `server/schemas/check/`.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| CHECK-1 | Valid course | Exit 0; `start` then `done` with the title, each lesson's file, id, title, quiz and explain counts, and the course's totals, a reused quiz counted once | implemented | `server/check-course.test.ts`: `school check > CHECK-1: a valid course exits 0 with what School would serve` |
| CHECK-2 | Empty course | A folder with no `lessons/` and no `course.json` exits 0 with no lessons, a null title and null manifest keys | implemented | `CHECK-2: a folder with no lessons and no course.json is a valid, empty course` |
| CHECK-3 | Invalid course | A malformed or strict-failing `course.json`, a whitespace-only `summary`, an `author` that is not a string, an unknown SPDX id, an unknown exception or a `LicenseRef-` after `WITH`, `format: 2`, a lesson that is not JSON, a duplicate id, two correct choices, an unknown type, an unknown ref: exit 1, one `error.invalid` line naming the file (null for the ref) and the rule | implemented | `CHECK-3: %s exits 1, naming the file and the rule` |
| CHECK-4 | Usage | No folder, two, a missing folder or an unknown flag: exit 2, one `error.usage` line, nothing on stdout | implemented | `CHECK-4: %j is a usage error, exit 2, checking nothing` |
| CHECK-5 | Help and schemas | `--help` is a `help` line listing every message type, then each schema; `--schema` prints every schema | implemented | `CHECK-5: --help describes the command, then prints every schema; --schema prints them alone` |
| CHECK-6 | Prose | `--human` prints prose naming the title and the lesson count | implemented | `CHECK-6: --human prints prose, not JSON` |
| CHECK-7 | Launcher | `./school check <folder>` runs `server/check-course.ts`, passing `--human`, its lines and its exit code through, and opens no vault | implemented | `host/launcher.test.ts`: `the command line > CHECK-7: \`school check <folder>\` runs School's course check on it, passing its lines and exit code through; it needs no secret` |
| CHECK-8 | Manifest | A full manifest is on the `done` line, the strings trimmed | implemented | `CHECK-8: a course's summary, author, license and format are on the done line, trimmed` |
| CHECK-9 | Manifest in prose | `--human` names the summary, author, license and format | implemented | `CHECK-9: --human names the course's author, license and format` |

## The `school` skill (flyingrobots/school#193)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| SKILL-1 | Frontmatter | `SKILL.md` is named `school` and its description says it is for a School course | implemented | `server/school-skill.test.ts`: `the school skill > SKILL-1: its frontmatter names it school and says when to use it` |
| SKILL-2 | Example served | `school check` on `example/` exits 0 with a title, a summary, an author, a license, format 1 and at least two lessons | implemented | `SKILL-2: its worked example is a course School would serve` |
| SKILL-3 | Example covers the format | The example shows all nine block types and a `ref` | implemented | `SKILL-3: the example shows every block type and a ref` |
| SKILL-4 | Example's voice | Every explain prompt in the example is a question | implemented | `SKILL-4: every explain prompt in the example is a question` |
