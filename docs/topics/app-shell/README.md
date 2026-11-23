# The app shell

Reference: the frame every page of the web app (`web/`) sits in. The pages' own content is built
separately; a route whose page has not landed yet shows a placeholder.

## Routes

| Path | Page |
| --- | --- |
| `/` | Home |
| `/courses/:course` | A course ([the course page](../course-page/README.md)) |
| `/courses/:course/reference` | A course's reference |
| `/courses/:course/lessons/:lesson` | A lesson |
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
- The arrow keys move focus, so they do not scroll the page. Whether long pages keep that is
  flyingrobots/school#84.
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

## Theme

The theme switch in the header offers Light, Dark and System. System follows the device, live.
The choice is stored in this browser's `localStorage` (`vite-ui-theme`), so it belongs to one
viewer on one device. Where storage is blocked, the choice lasts for the visit.

## Layout

The stock shadcn `Sidebar`; on a phone it becomes a sheet behind the header's sidebar button. The
main area uses the full width: the placeholder grid has one column on a phone and up to four on
extra-wide screens. Page headings are large (`text-4xl` up to `text-6xl`). A GSAP timeline brings
each page's heading and placeholders in, unless the viewer prefers reduced motion.

## Tests

`web/test/shell.test.ts` drives the app in Chrome through playwright-core against the Vite dev
server. It runs in `bun test` from the repository root and needs `npm ci` in `web/` and Google
Chrome installed.
