# The reference page

Reference: what `/courses/:course/reference` shows. The page sits in the
[app shell](../app-shell/README.md) and reads one endpoint, `GET /api/courses/:course`, whose
`reference` field lists the file names of the course's reference documents.

## What it shows

- **Reference** as the page heading, under a breadcrumb: Home, the course by its title
  ([a course's folder](../course-format/README.md)), a link back to its
  [course page](../course-page/README.md), then Reference.
- Every document the API lists, in the server's order (by file name), as a link. Each shows its
  file name without `.html`, and says it opens in a new tab.

The documents fill a grid of one column on a phone, two from `sm`, three from `xl` and four from
`2xl`. A line under the grid shows the keys: `j` and `k` move between documents (the shell's focus
movement) and `↵` opens the focused one. The heading and the documents fade in by opacity only, so
every link can take focus while they animate.

## Opening a document

A document opens in a new tab at the address School serves it from,
`/courses/:course/reference/<file>`, with the course and file name URL-encoded. The page builds no
other path to a file, so School's own rules decide what is served: the server lists only `.html`
files that are regular files inside the course's `reference/` folder, and refuses any request that
resolves outside it, symlinks included (`server/hardening.test.ts`).

A new tab, rather than drawing the document inside the app, because a reference document is a
complete page of its own, authored by the course: it brings its own styles and scripts, and the app
neither renders nor restyles it. The app tab stays where it was.

Those addresses are served by School. The Vite dev server has no proxy to School, so under
`npm run dev` alone they do not reach a document.

## States

| When | The page shows |
| --- | --- |
| The request is in flight | A Spinner with "Loading the reference documents" and a grid of Skeletons |
| The course has no reference documents (`reference: []`, including a course with no reference folder) | An Empty state, "No reference documents" |
| The server answers 404 | An Empty state, "There is no course called …", with a link home |
| No usable answer: the server is unreachable, or the body is not the expected shape | A destructive Alert, "The reference documents could not be loaded", with **Try again** |

The response is parsed with Zod (`CourseReply` in `web/src/lib/school-api.ts`) before anything is
shown. A course whose lessons cannot be read still answers 200, with `lessons: null` and the
reason in `lessonsError`, and its `reference` list is shown as for any other course. The lesson
error is not shown here; the [course page](../course-page/README.md) shows it.

## Code and tests

The page is `web/src/pages/reference.tsx`, composed of stock shadcn components (Breadcrumb, Item,
Empty, Alert, Button, Skeleton, Spinner, Kbd). It shares `useCourse` (`web/src/lib/course.ts`) and
`loadCourse` with the course page. `web/test/reference.test.ts` drives it in Chrome against the
Vite dev server, with `/api` requests and document requests answered by a real School server over
course folders written by the test; [the test plan](test-plan.md) lists its cases.
