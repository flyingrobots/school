# Course format test plan

The contract ledger for [a course's folder](README.md): the course title (flyingrobots/school#143), the course manifest (flyingrobots/school#209), a lesson's hook (flyingrobots/school#164), [lesson blocks](blocks.md) (flyingrobots/school#196) `school check` (flyingrobots/school#197), the `school` skill (flyingrobots/school#193) and untrusted courses (flyingrobots/school#210).
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
| SPDX-MSG | SPDX refusal messages | `WITH` after a parenthesised group, a second `WITH`, a lowercase or mixed-case operator, a `LicenseRef-` with `+` and an empty `license` are each refused with one message naming the rule broken; which expressions are accepted is unchanged | implemented | `server/spdx-messages.test.ts`: `SPDX-MSG-1` to `SPDX-MSG-6` |
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

CHECK-1 to CHECK-10 run the program as a process, and every line it prints is validated against its schema in `server/schemas/check/`. CHECK-11 to CHECK-16 call `checkCourse(folder)` (flyingrobots/school#231), the function the program prints from.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| CHECK-1 | Valid course | Exit 0; `start`, `manifest`, then `done` with the title, each lesson's file, id, title, quiz and explain counts, and the course's totals, a reused quiz counted once | implemented | `server/check-course.test.ts`: `school check > CHECK-1: a valid course exits 0 with what School would serve` |
| CHECK-2 | Empty course | A folder with no `lessons/` and no `course.json` exits 0 with no lessons, a null title and a manifest line of nulls | implemented | `CHECK-2: a folder with no lessons and no course.json is a valid, empty course` |
| CHECK-3 | Invalid course | A malformed or strict-failing `course.json`, a whitespace-only `summary`, an `author` that is not a string, an unknown SPDX id, an unknown exception or a `LicenseRef-` after `WITH`, `format: 2`, a lesson that is not JSON, a duplicate id, two correct choices, an unknown type, an unknown ref: exit 1, one `error.invalid` line naming the file (null for the ref) and the rule | implemented | `CHECK-3: %s exits 1, naming the file and the rule` |
| CHECK-4 | Usage | No folder, two, a missing folder or an unknown flag: exit 2, one `error.usage` line, nothing on stdout | implemented | `CHECK-4: %j is a usage error, exit 2, checking nothing` |
| CHECK-5 | Help and schemas | `--help` is a `help` line listing every message type, then each schema; `--schema` prints every schema | implemented | `CHECK-5: --help describes the command, then prints every schema; --schema prints them alone` |
| CHECK-6 | Prose | `--human` prints prose naming the title and the lesson count | implemented | `CHECK-6: --human prints prose, not JSON` |
| CHECK-7 | Launcher | `./school check <folder>` runs `server/check-course.ts`, passing `--human`, its lines and its exit code through, and opens no vault | implemented | `host/launcher.test.ts`: `the command line > CHECK-7: \`school check <folder>\` runs School's course check on it, passing its lines and exit code through; it needs no secret` |
| CHECK-8 | Manifest | A full manifest is on a `school.check.manifest` 1.0.0 line between `start` and `done`, the strings trimmed | implemented | `CHECK-8: a course's summary, author, license and format are on the manifest line, trimmed` |
| CHECK-9 | Manifest in prose | `--human` names the summary, author, license and format | implemented | `CHECK-9: --human names the course's author, license and format` |
| CHECK-10 | Done unchanged | The `done` line names `school.check.done` 1.0.0, has none of the four manifest keys, validates against main's 1.0.0 schema kept as `server/testing/fixtures/school.check.done.1.0.0.schema.json`, and the published schema is that schema | implemented | `CHECK-10: the done line is still school.check.done 1.0.0, valid against the schema main published, and carries no manifest key` |
| CHECK-11 | Golden | The skill's `example/` returns `ok: true` with its title, both lessons with their files, ids, titles and counts, the totals, and its summary, author, license and format 1 | implemented | `server/check-course-function.test.ts`: `checkCourse > CHECK-11: the skill's worked example passes, with its lessons, counts and manifest` |
| CHECK-12 | Bad course.json | A malformed `course.json` returns `ok: false`, `file` `course.json`, a message saying it is not valid JSON | implemented | `CHECK-12: a malformed course.json is refused, naming course.json` |
| CHECK-13 | Later lesson | A duplicate id in the second lesson names that lesson's file | implemented | `CHECK-13: a problem in a later lesson is refused, naming that lesson's file` |
| CHECK-14 | Across files | An unknown ref returns `ok: false` with `file` null | implemented | `CHECK-14: a refusal that spans files names no file` |
| CHECK-15 | Missing folder | A folder that does not exist returns `ok: false`, `file` null, `<folder> is not a folder` | implemented | `CHECK-15: a folder that does not exist is refused, naming no file` |
| CHECK-16 | No drift | On the example, the program's `done` line carries `checkCourse`'s result without `manifest`, and its `manifest` line carries `manifest` | implemented | `CHECK-16: school check prints checkCourse's result: done is it without the manifest, manifest is the manifest` |

## The `school` skill (flyingrobots/school#193)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| SKILL-1 | Frontmatter | `SKILL.md` is named `school` and its description says it is for a School course | implemented | `server/school-skill.test.ts`: `the school skill > SKILL-1: its frontmatter names it school and says when to use it` |
| SKILL-2 | Example served | `school check` on `example/` exits 0 with a title, at least two lessons, and a manifest line with a summary, an author, a license and format 1 | implemented | `SKILL-2: its worked example is a course School would serve` |
| SKILL-3 | Example covers the format | The example shows all nine block types and a `ref` | implemented | `SKILL-3: the example shows every block type and a ref` |
| SKILL-4 | Example's voice | Every explain prompt in the example is a question | implemented | `SKILL-4: every explain prompt in the example is a question` |

## Untrusted courses (flyingrobots/school#210)

The server cases start the real School on PGlite with one course in `SCHOOL_COURSES` and one in `SCHOOL_UNTRUSTED_COURSES`, each holding the same hostile files. The block cases render in happy-dom.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| TRUST-1 | Every route sandboxed | Each route that serves an untrusted course's bytes (reference HTML, nested HTML, an encoded nested path, SVG, JS, CSS, text, the course JSON, the lesson JSON in both views) answers 200 with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` | implemented | `server/untrusted.test.ts`: `an untrusted course > %s is sandboxed and never sniffed` |
| TRUST-2 | Exact policy | The reference page is served as written, as `text/html`, with the policy exactly `sandbox` (no `allow-scripts`, no `allow-same-origin`) | implemented | `an untrusted course > its reference page carries exactly the sandbox policy, with no allow-scripts or allow-same-origin` |
| TRUST-3 | SVG with script | Served as `image/svg+xml` with both headers | implemented | `an untrusted course > an SVG with script is served as SVG under the same sandbox, never as HTML` |
| TRUST-4 | Path tricks | A symlink out of `reference/` and encoded `..` paths are 404 and leak nothing | implemented | `an untrusted course > a symlink out of its reference folder is still refused`; `an untrusted course > a path that climbs out of its reference folder (%s) is still refused` |
| TRUST-5 | Trusted unchanged | The same routes for a trusted course carry neither header | implemented | `a trusted course > %s is served as before, with neither header` |
| TRUST-6 | API | `GET /api/courses` and `GET /api/courses/:course` give `trusted`, false for the untrusted course and true for the trusted one | implemented | `the course API reports trust > GET /api/courses gives each course's trusted`; `the course API reports trust > GET /api/courses/%s gives trusted: %p` |
| TRUST-7 | Configuration | `SCHOOL_UNTRUSTED_COURSES` registers untrusted courses; a course from `SCHOOL_COURSES` or `SCHOOL_COURSE` stays trusted; names and learner state follow `SCHOOL_COURSES`' rules | implemented | `server/config.test.ts`: `SCHOOL_UNTRUSTED_COURSES registers courses that are not trusted, beside trusted ones`; `a course from SCHOOL_COURSE or SCHOOL_COURSES stays trusted when nothing marks it`; `SCHOOL_UNTRUSTED_COURSES follows SCHOOL_COURSES' rules for names and learner state` |
| TRUST-8 | Both trusted and untrusted | A name in both lists, one folder under two names, or an untrusted folder inside or around a trusted one is refused; at start, exit 2 naming both variables, creating nothing | implemented | `server/config.test.ts`: `a name both trusted and untrusted is refused, naming both variables`; `one folder both trusted and untrusted, under two names, is refused`; `an untrusted folder %s is refused, since the trusted course would serve its files unsandboxed`; `server/startup.test.ts`: `a course both trusted and untrusted stops startup, naming both variables` |
| TRUST-9 | Compose | Compose passes `SCHOOL_UNTRUSTED_COURSES` through, empty by default | implemented | `server/docker.test.ts`: `compose passes SCHOOL_UNTRUSTED_COURSES through, empty by default (flyingrobots/school#210)` |
| TRUST-10 | Hostile blocks inert | 35 cross-site-scripting payloads (a `<script>`, an `onerror=`, a `javascript:` link and OWASP filter-evasion variants) through each of prose, card, quote and aside leave no element that runs or loads a document, no `on*` or `srcdoc` attribute, no script URL, and fire no callback. Calibrated: with the sanitiser replaced by raw `innerHTML`, 120 of 140 cases fail | implemented | `web/test/sanitise.test.tsx`: `a %s block renders %s inert` |
| TRUST-11 | Sanitiser keeps formatting | Bold, emphasis and a list survive, so TRUST-10 cannot pass by dropping everything | implemented | `a block keeps the formatting the sanitiser allows` |
| TRUST-12 | Hostile figures | 6 SVG figures with script, handlers, `foreignObject`, links, animation, `use` and `image` keep only their drawing through `safeFigure` | implemented | `a figure keeps only its drawing from %s` |
| TRUST-13 | Figure mutation XSS | 6 figures that hide `<img onerror>` in an attribute inside `noscript`, `noembed`, `noframes`, `xmp` or `style` within `<title>` or `<desc>` come back from `safeFigure`, inserted as the page inserts them, with no raw-text element and no hazard (flyingrobots/school#273). The evidence is that no raw-text element survives. happy-dom never runs `<img onerror>`, so the test's "no callback fired" check proves nothing there; the payloads fired nothing in a by-hand check in Chrome | implemented | `a figure cannot mutate into script through %s` |
| TRUST-14 | Figure overlay | No `style` or `class` attribute survives `safeFigure`, on the root or any shape | implemented | `a figure keeps no style or class that could lay it over the page` |
| TRUST-15 | Untrusted figure is an image | `HookFigure` draws an untrusted course's figure as one `<img>` whose `data:image/svg+xml` source holds the drawing, with no inline SVG; each `var(--token)` takes the theme's value, and again after a switch to dark; a trusted course's stays inline with its `var(--primary)` | implemented | `an untrusted course's figure is an image, with no inline SVG on the page`; `an untrusted course's figure takes the theme's colours, since an image cannot read the page's`; `an untrusted course's figure follows a switch to the dark theme`; `a trusted course's figure stays inline SVG, coloured by the page's own variables` |
| TRUST-16 | Showcase reports trust | `GET /api/showcase` gives each item its course's `trusted` | implemented | `server/untrusted.test.ts`: `the showcase reports trust > GET /api/showcase gives each lesson's course trusted, so the page can draw an untrusted figure as an image` |
| TRUST-17 | No mount or web folder over an untrusted course | A `SCHOOL_MOUNTS` or `SCHOOL_WEB` folder that is, contains or sits inside an untrusted course's folder (also through a symlink) is refused, naming both variables and folders; at start, exit 2 creating nothing; a mount beside one is accepted, serves its own files (the positive control) and cannot climb into it | implemented | `server/config.test.ts`: `a SCHOOL_MOUNTS folder that %s is refused`; `a SCHOOL_WEB folder that %s is refused`; `a mount reaching an untrusted course through a symlink is refused, since paths are compared resolved`; `a mount and a web folder beside an untrusted course, not over it, are accepted`; `server/startup.test.ts`: `%s holding an untrusted course stops startup, naming both variables and folders`; `server/untrusted.test.ts`: `a mount > over an untrusted course stops the server before it serves /lib/guest/reference/page.html`; `a mount > beside an untrusted course serves its own files`; `a mount > beside an untrusted course cannot climb into it (/lib/%s)` |
| TRUST-18 | Same folder by identity | An untrusted folder that is, holds or sits inside a trusted course, a mount or the web folder by `(st_dev, st_ino)`, as with a Docker bind mount realpath cannot see, is refused, naming both variables and folders and saying they are one folder under two names; folders that differ by identity are accepted; inodes that differ only above 2^53 stay apart, and School's own stat reads them as bigint. A fake stat stands in for the bind mount (flyingrobots/school#280). Not covered: part of a trusted folder bind-mounted where an untrusted course lives, which School does not detect | implemented | `server/config.test.ts`: `an untrusted folder that is %s, by device and inode, is refused`; `folders with different device and inode stay accepted under the same fake stat`; `two folders whose inodes differ only above 2^53 are told apart`; `School's own stat reads inodes as bigint, so none is rounded` |
| TRUST-19 | Lone surrogate | An untrusted figure holding a lone high or low surrogate becomes an image with U+FFFD in its place, and the home page still renders it | implemented | `web/test/sanitise.test.tsx`: `a figure with a lone %s surrogate becomes an image with U+FFFD in its place`; `an untrusted course's figure with a lone %s surrogate still renders as an image` |
| TRUST-20 | Balanced var() | An untrusted figure's `var(--primary)`, `var(--primary, rgb(1, 2, 3))` with the token set and unset, and nested `var()` fallbacks resolve as CSS's var() grammar says | implemented | `web/test/sanitise.test.tsx`: `an untrusted figure’s fill %s resolves as var() says` |
