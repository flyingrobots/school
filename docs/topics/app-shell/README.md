# The app shell

Reference: the frame every page of the web app (`web/`) sits in. The pages' own content is built
separately; today every route shows a placeholder.

## Routes

| Path | Page |
| --- | --- |
| `/` | Home |
| `/courses/:course` | A course |
| `/courses/:course/reference` | A course's reference |
| `/courses/:course/lessons/:lesson` | A lesson |
| `/settings` | Settings |
| anything else | Not found |
| `/demo` | The theme sandbox, outside the shell ([`web/src/demo/README.md`](../../../web/src/demo/README.md)) |

Routing is on the client (React Router). The server serves `web/dist/index.html` for every path
that is not a file or the API, so a deep link loads directly.

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
- `Space` is the leader key even on a focused button, so it does not press it. `Enter` does. A lone
  `Space` waits 1.5 seconds for its second key, and the header shows that it is waiting.
- Every key that acts shows a `Kbd` hint: the sidebar's Keys list names them all, sidebar links,
  the Commands button and palette items show their own, and the palette's footer shows its keys.

The keys are in `web/src/shell/`: `keys.ts` (the hints), `use-key-layer.ts` (the bindings, through
ui-sdk's `useShortcut`, plus a capture-phase listener for `Space`) and `focus.ts` (focus movement
over elements marked `data-nav` inside regions marked `data-nav-region`).

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
