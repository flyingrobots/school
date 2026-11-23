# App shell test plan

The contract ledger for [the app shell](README.md)'s course list in the sidebar
(flyingrobots/school#95). Every case runs in `bun test`. The cases drive Chrome through
playwright-core against the Vite dev server, with the page's `/api` requests answered by a real
School server over real course folders (`server/testing/processes.ts`, on PGlite), or by a stubbed
route where the case is a slow answer or a failure. The shell's keys, palette and theme are covered
by `web/test/shell.test.ts`.

## The sidebar's courses (browser)

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| SIDEBAR-1 | Every course, every page | On `/`, `/settings`, a course, its reference, a lesson and a missing page: every course from `GET /api/courses`, in the server's order, each a link to `/courses/:course`, no Skeleton and no alert | implemented | `web/test/sidebar.test.ts`: `loaded > on %s it lists every course from the API, in order, each linking to its course page` |
| SIDEBAR-2 | Current course | Only the course in the address is marked (`data-active`, `aria-current=page`), on its page and the pages under it; none on Home or Settings | implemented | `loaded > marks the current course, on its page and every page under it, and none elsewhere` |
| SIDEBAR-3 | Client routing | A course link routes without a page load, and the mark moves to it | implemented | `loaded > a course link routes on the client, and the mark follows it` |
| SIDEBAR-4 | Keys | The course links are `data-nav` focus stops | implemented | `loaded > the course links are focus stops for j and k` |
| SIDEBAR-5 | Loaded once | Moving between pages in one visit asks for `GET /api/courses` once; a new visit asks once more | implemented | `loaded once > navigating between pages does not ask for the course list again` |
| SIDEBAR-6 | Loading | Skeletons and no links while the request is held, gone once it answers | implemented | `states > while the request is in flight it shows Skeletons and no links, then the courses` |
| SIDEBAR-7 | Failure | An unreachable server is shown as an alert with Try again, no Skeleton; Try again lists the courses | implemented | `states > a list that cannot be loaded is reported with Try again, which recovers` |
| SIDEBAR-8 | Wrong shape | A reply that is not a course list is a failure, not a list | implemented | `states > a reply of the wrong shape is a failure, not a list` |
| SIDEBAR-9 | Server's reason | A failure with School's `error` shows that reason | implemented | `states > the server's own reason is shown` |
| SIDEBAR-10 | Shared with Home | On `/` the sidebar and the page's course list come from one request, and the sidebar's Try again recovers both | implemented | `states > on the home page the sidebar and the page share one request, and one Try again recovers both` |
