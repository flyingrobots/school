# Theme sandbox (`/demo`)

> Agent-written, not human-reviewed.

The page at `/demo` shows School's theme on every stock shadcn component, one at a time, in the
light and dark modes. Use the mode toggle at the top right to switch.

| Key | Does |
| --- | --- |
| ← / → | previous or next component |
| ↑ / ↓ | previous or next example of that component |

The arrow keys belong to an example while focus is inside it, because sliders, tabs and menus use
them. Click outside the example, or use the buttons in the footer, to move on. The address keeps
the position, for example `/demo#/button/2`, so a link opens the same example.

## Where the content comes from

Every example on the page is a shadcn registry item (`@shadcn/<component>-example`), installed
with `shadcn add` and never edited. `test/demo.test.ts` checks each file against the hash the CLI
wrote. Each example file holds several `<Example title="…">` blocks, and those are the examples
↑ / ↓ cycles through.

The only code written here is the frame:

- `gallery.tsx`: the page. It uses stock shadcn Button, Kbd, Spinner and Toaster, the registry
  mode toggle, and ui-sdk's `useShortcut` for the arrow keys.
- `example.tsx`: stands in for shadcn's `@/components/example` frame. It has the same two exports,
  `Example` and `ExampleWrapper`, but shows one example at a time instead of a grid.
- `shims/`: the examples are written for shadcn's Next.js website, so these stand in for its
  modules: `next/link`, `next/image`, the chart example's style setting, and a type the message
  example imports.

`vite.config.ts` and `tsconfig.app.json` point those imports at this folder.

## What the page cannot show

- `direction` has no registry example; it is a provider that renders nothing of its own.
- No registry example uses `SidebarMenuButton variant="outline"`. The test lists it as a known gap,
  and fails if a future example starts showing it.
