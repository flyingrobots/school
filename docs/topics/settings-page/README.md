# The settings page

Reference: what `/settings` shows and does. It is a page over the settings API
(`/api/settings/*`, listed in [Architecture](../architecture/README.md)); every rule about what
can be saved is the server's, and the page shows what the server answers.

Every reply is parsed with Zod in `web/src/lib/settings-api.ts` before the page reads it. A reply
of the wrong shape is shown as an error in the card that asked for it, naming the request; the
page never shows a status, an agent list or a form built from it. A refusal shows the server's
own reason.

## Bridge

The address and the token School uses to reach the bridge.

- **The token is write-only.** The field is a password field that starts empty. Its placeholder
  says whether a token is saved. After a save the field is cleared, and no token appears anywhere
  in the page.
- **Generate a token** asks the server for a new random token, saves it, and shows it once, in a
  read-only field, so the learner can start the bridge with it. **I have stored it** removes it
  from the page; a reload never shows it again.
- **A new address clears the saved token** (the server sends a token only to the address it was
  saved with). While the typed address differs from the saved one and no token is typed, the field
  says so; after saving, an alert says the saved token was cleared and must be entered again.
- **Locked fields say why.** A field set in the server's environment (`SCHOOL_BRIDGE_URL`,
  `SCHOOL_BRIDGE_TOKEN`) is disabled and names its variable. With `SCHOOL_BRIDGE_TOKEN` there, the
  address is locked too, since it can only be changed beside the token. A token from the
  environment (or mounted as `SCHOOL_BRIDGE_TOKEN_FILE`, as under `./school up`) is sent only to
  a `SCHOOL_BRIDGE_URL` from the environment, never to an address saved on this page: with only a
  saved address, the status is `none` and its message says to set `SCHOOL_BRIDGE_URL`.
- A refused save (a bad address, a short token) shows the server's reason under the fields.

## Connection and agents

The bridge's status, from `GET /api/settings/status`, with **Check again** to ask once more.
While it loads the card shows `Skeleton`s, and the button a `Spinner`.

| Connection | The page says |
| --- | --- |
| `none` | No bridge is connected |
| `unreachable` | School could not reach the bridge, and why |
| `unauthorised` | The bridge refused the token |
| `unconfigured` | The bridge has no agents yet, and the file on its computer to declare them in |
| `misconfigured` | The bridge's file has a problem, and what it is |
| `ok` | Connected, and the agents in the order they are tried |

When connected, each agent shows whether its program was found on the bridge's computer, a switch
to use it or not, and **Test**. Its handle reorders it: drag it, or focus it and press `Enter` to
pick it up, `↑` `↓` (or `j` `k`) to move it, `Home` `End` for either end, `Enter` to drop it and
`Esc` to put it back. The keys are shown beneath the list with `Kbd`. Each change is saved to the
bridge's file at once (`POST /api/settings/agents`), and the list shows the order the bridge saved.

A note says that each agent's command is written only in the bridge's file, naming it, and that
the page can only reorder, switch and test what it declares (flyingrobots/school#18). There is no
field for a command.

## Agent test

**Test** runs one declared agent for real through the bridge (`POST /api/settings/agents/test`),
so it is marked as AI with a robot icon, as is the card that shows the result: whether it
succeeded, and each attempt the bridge made, with its status, time, exit code and error.

## Built from

Stock shadcn `Card`, `Field`, `Input`, `Button`, `Switch`, `Badge`, `Alert`, `Item`, `Skeleton`,
`Spinner` and `Breadcrumb`, and the `@flyingrobots/sortable-list` registry block
(`web/src/components/sortable-list.tsx`, `web/src/lib/sortable-list-behavior.ts`), installed with
the shadcn CLI and never edited here. The block is ui-sdk's `createReorder` behind a handle, drawn
with stock `ItemGroup`, `Item`, `Button` and `Kbd`. The page itself is `web/src/pages/settings.tsx`.

On a phone the cards stack; from `xl` the bridge and the agents sit side by side with the test
below them, and from `2xl` the three share one row, the agents two columns wide. A GSAP timeline brings the heading and then the cards in, animating
opacity and position only (never visibility, so every field and button can take focus while it
fades in), unless the viewer prefers reduced motion.

## Tests

`web/test/settings.test.ts` drives the page in Chrome against the Vite dev server, with every
`/api` request forwarded to a real School and a real bridge, each started by the port helper
(`server/testing/processes.ts`). It covers each connection state, the loading skeletons, the token
never appearing after a save or a reload, a malformed reply shown as an error, the one-time generated token, the cleared-token notice,
the environment locks, reordering by keyboard (arrows, `j`, `Esc`) read back from the bridge's
file, switching an agent off, a test's attempts, and keys pressed during the intro (`j` reaches each
stop up to the first field, and every stop takes focus, with the page's clock held). It runs in `bun test` from the repository root.

The browser title is `Settings · School`; `web/test/settings.test.ts` checks it (`connecting the bridge > the browser title is Settings · School`).
