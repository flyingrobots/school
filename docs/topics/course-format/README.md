# A course's folder

Reference: what School reads from a course's folder, the one `SCHOOL_COURSES` (or `SCHOOL_COURSE`)
names. School reads the folder and never writes to it ([ADR 6](../../adr/0006-separate-framework-lessons-and-learner-state.md)).

| Path | Required | Holds | Read |
| --- | --- | --- | --- |
| `course.json` | no | The course's declaration about itself: its title | Once, when the server starts |
| `lessons/*.json` | no | The lessons, one block-JSON page per file, in file-name order | On every request, so an edit shows without a restart |
| `reference/*.html` | no | Reference documents, served read-only at `/courses/:course/reference/<file>` | On every request |

Anything else in the folder (`README.md`, `OBJECTIVES.md`, `RESOURCES.md`) is for the course's
authors and readers; School does not read it.

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
{ "title": "AIΩN Foundations" }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `title` | non-empty string | What the pages call the course: the sidebar, Home, the course page and every breadcrumb. Surrounding spaces are trimmed. |

The course's **name**, the `name` in `SCHOOL_COURSES=name=path`, stays its slug: it is what
addresses carry (`/courses/aion`) and what the record stores. A course with no `course.json` is
called by its name everywhere a title would show.

`GET /api/courses` and `GET /api/courses/:course` give both: `name`, the slug, and `title`, the
course's title or, when it declares none, its name.

### When the file is malformed

`course.json` is checked with Zod (`server/course-file.ts`) when the server starts. A file that is
there but is not JSON, is not an object, has no `title`, has a `title` that is not a string or is
empty, or has any other key, stops the start with exit code 2 and a line naming the course and the
file. For a course at `/courses/aion` whose `title` is `42`, it prints:

```text
school: course "aion": /courses/aion/course.json is not a course file: "title" Invalid input: expected string, received number. It must be an object such as {"title": "My Course"}
```

The file is read only at start, so a changed title shows after a restart. Unknown keys are refused
rather than ignored, so a misspelt `tilte` is caught instead of silently showing the slug.

The cases are in the [test plan](test-plan.md).

Lessons are written in [School's voice](../voice/README.md): an explain block's prompt is a
question, never a command.
