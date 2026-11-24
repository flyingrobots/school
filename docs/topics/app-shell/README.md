# The app shell

Reference: the frame every page of the web app (`web/`) sits in. The pages' own content is built
separately; a route whose page has not landed yet shows a placeholder.

## Routes

| Path | Page |
| --- | --- |
| `/` | Home ([the home page](../home-page/README.md)) |
| `/courses/:course` | A course ([the course page](../course-page/README.md)) |
| `/courses/:course/reference` | A course's reference documents ([the reference page](../reference-page/README.md)) |
| `/courses/:course/lessons/:lesson` | A lesson ([the lesson page](../lesson-page/README.md)) |
| `/settings` | Settings |
| anything else | Not found |
| `/demo` | The theme sandbox, outside the shell ([`web/src/demo/README.md`](../../../web/src/demo/README.md)) |

Routing is on the client (React Router). The server serves `web/dist/index.html` for every path
that is not a file or the API, so a deep link loads directly. The `/demo` sandbox also shows the
shell on its own (`app-shell-example`), with its keys acting only while focus is inside it.

## Keys

| Key | Does |
| --- | --- |
| `⌘K` (`Ctrl K` off Apple), or `Space` `Space` | Opens the command palette |
| `Esc` | Closes the palette or a menu. It never opens anything |
| `Space` `h` | Home |
| `Space` `s` | Settings |
| `Space` `t` | Opens the theme menu |
| `⌘B` (`Ctrl B`) | Shows or hides the sidebar |
| `j` `k`, `↓` `↑` | Focus the next or previous item in the sidebar or the main area |
| `h` `l`, `←` `→` | Focus the sidebar or the main area, back on the item last focused there |

- In a text field, every key except the `⌘`/`Ctrl` ones is text: `j` types `j`, `Space` types a space.
- While the palette, a menu or the mobile sidebar is open, its own keys win and the page's wait.
- The arrow keys move focus, so they do not scroll the page, on long pages too (decision below).
  The browser scrolls the newly focused item into view. A control that uses the arrows itself gets
  them first: a quiz's choices, the nest's tree, and the theme button, whose menu opens on `↓`.
- `Space` is the leader key even on a focused button, so it does not press it. `Enter` does. A lone
  `Space` waits 1.5 seconds for its second key, and the header shows that it is waiting.
- Every key that acts shows a `Kbd` hint: the sidebar's Keys list names them all, sidebar links,
  the Commands button and palette items show their own, and the palette's footer shows its keys.

The shell is the `@flyingrobots/app-shell` registry block, installed with the shadcn CLI and never
edited here: `web/src/components/app-shell.tsx` (layout, palette, Kbd hints) and
`web/src/lib/app-shell-keys.ts` (the key layer, on ui-sdk's `useShortcut`, plus a capture-phase
listener for `Space`, and focus movement over elements marked `data-nav` inside regions marked
`data-nav-region`). The theme menu is `@flyingrobots/theme-switch`. School's own code only wires the
block to React Router and the pages, in `web/src/App.tsx`. Changes to the shell go to the registry
(`flyingrobots/shadcn-registry`) and are reinstalled as `web/test/fixtures/README.md` describes.

### Decision: on a long page the arrows still move focus (flyingrobots/school#84)

Taken for the lesson page (flyingrobots/school#42), the first page that scrolls; reversible by a
change to the registry block and a reinstall. Section 2d of flyingrobots/school#84 names the
maintainer as the one who decides, so this stands until they confirm or overturn it.

- **Chosen: A, the arrows move focus everywhere.** A long page gives the key layer something to
  move through: the lesson page makes every section heading and every block a focus stop
  (`@flyingrobots/lesson`), so `↓` and `j` step through a lesson in reading order and the browser
  scrolls each stop into view. The arrows stay hjkl's twin (RFC 2), the `Kbd` hints do not change,
  and the block needs no change. Reading inside a block taller than the window scrolls by mouse,
  trackpad, `PageDown`/`PageUp` or `Home`/`End`. Most study is on a phone, which has no arrow keys.
- Rejected: B, `j`/`k` move focus and the arrows scroll. It matches the browser but breaks the
  arrows' documented role as hjkl's twin and changes every `Kbd` hint, for a page that already
  scrolls as focus moves.
- Rejected: C, the arrows move focus until a region runs out, then scroll. On a lesson with stops
  throughout, the region rarely runs out before the end, so it buys little for more behaviour in
  the key layer.
- Rejected for now: D, a page hands the arrows back to scrolling. It is the fallback if reading by
  stops proves awkward: a region attribute in the block, set by the lesson page.

## Theme

The theme switch in the header offers Light, Dark and System. System follows the device, live.
The choice is stored in this browser's `localStorage` (`vite-ui-theme`), so it belongs to one
viewer on one device. Where storage is blocked, the choice lasts for the visit.

## The sidebar's courses

Below the pages, the sidebar's **Courses** group lists every course from `GET /api/courses`, on
every page, in the server's order (by name). Each shows the course's title, or its name when it
declares none ([a course's folder](../course-format/README.md)), and is a link to `/courses/:course`. The course in
the address is marked active, on its own page and on the pages under it (its reference, its
lessons); on Home, Settings and Not found none is. The links are focus stops for `j` and `k`.

| State | The group shows |
| --- | --- |
| Loading | Three Skeleton rows, and no links |
| Loaded | The course links |
| Failed (unreachable, an error, or a reply that is not a course list) | A destructive Alert, "Courses could not be loaded", with the server's reason when it gave one, and **Try again** |

The list is asked for once per visit and shared: `web/src/lib/courses.ts` holds the one answer the
sidebar and the course pages read, and moving between pages does not ask again. The reply is
parsed with Zod in `web/src/lib/school-api.ts` (`listCourses`). The [home page](../home-page/README.md)
does not ask for the list; a failure there is the sidebar's alone. A
**Try again** in either place retries the shared request, so it recovers both.

The group is composed from stock shadcn sidebar parts in `web/src/App.tsx` and passed through the
block's `sidebar` slot; the block itself is unchanged.

## Layout

The stock shadcn `Sidebar`; on a phone it becomes a sheet behind the header's sidebar button. The
main area uses the full width: the placeholder grid has one column on a phone and up to four on
extra-wide screens. Page headings are large (`text-4xl` up to `text-6xl`). A GSAP timeline brings
each page's heading and placeholders in, unless the viewer prefers reduced motion. Every page's
intro animates opacity and position only, never visibility (GSAP's `autoAlpha`), because an element
under `visibility: hidden` cannot take focus and `j` pressed during the intro would skip it;
`web/test/motion.test.ts` fails on any `autoAlpha` tween under `web/src`.

## Tests

`web/test/shell.test.ts` drives the app in Chrome through playwright-core against the Vite dev
server. It runs in `bun test` from the repository root and needs `npm ci` in `web/` and Google
Chrome installed. The sidebar's course list is `web/test/sidebar.test.ts`, against a real School;
its cases are in [the test plan](test-plan.md).

## Browser titles

Every page names itself in the browser tab, history and tab switcher with `useDocumentTitle`
(`web/src/lib/document-title.ts`), School's own hook rather than an installed component. It joins the
parts it is given, most specific first, with ` · ` and ends with `School`: Home `School`, a course
`<course> · School`, a lesson `<lesson> · <course> · School`, `Reference · <course> · School`,
`Settings · School`, `Not found · School`. `web/index.html` carries `School` as the title before
any page runs. Each page's test reads `page.title()`; see that page's test plan.
