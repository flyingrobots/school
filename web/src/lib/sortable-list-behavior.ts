import { createChange, createReorder, definePrimitive, type ChangeDetails, type ReorderDraft, type ReorderReason } from "@ui-sdk/core"

// A list whose items are reordered by a handle, with the pointer or the keyboard. ui-sdk's
// createReorder keeps the draft and the announcements; each item may hold its own controls,
// so only the handle picks it up (the APG's advice for items with nested controls). Enter picks
// up and drops, the arrows or j and k move, Home and End go to either end, Esc puts it back.
// j and k are taken before createReorder so a page's own vim keys do not also move focus.

export type SortableListOptions = {
  value?: string[]
  defaultValue?: string[]
  onValueChange?: (value: string[], details: ChangeDetails<ReorderReason>) => void
  /** What screen readers call an item, when its text says more than its name. */
  itemLabel?: (value: string) => string | undefined
}

export const sortableList = definePrimitive({
  name: "sortable-list",
  options: { value: "list", defaultValue: "list", onValueChange: "callback", itemLabel: "value" },
  state: (options: SortableListOptions) => ({ value: options.value ?? options.defaultValue ?? [], moving: null as ReorderDraft | null }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context)
    const reorder = createReorder(context, {
      slot: "item",
      key: "value",
      draft: "moving",
      set: (value, details) => change("value", value, details),
      label: (key) => context.options().itemLabel?.(key),
    })
    const vim = (event: KeyboardEvent, key: string) => {
      const moving = context.store.get().moving
      if (moving?.key !== key || (event.key !== "j" && event.key !== "k") || event.metaKey || event.ctrlKey || event.altKey) return false
      event.preventDefault()
      const at = moving.order.indexOf(key)
      reorder.moveTo(Math.min(Math.max(at + (event.key === "j" ? 1 : -1), 0), moving.order.length - 1))
      return true
    }
    return {
      reorder,
      keydown(event: KeyboardEvent, key: string) {
        if (vim(event, key) || reorder.keydown(event, key)) event.stopPropagation()
      },
      move: (key: string, index: number) => reorder.move(key, index),
    }
  },
  slots: (slot) => ({
    root: slot({}),
    list: slot<Record<never, never>, { order: string[] }>({
      role: "list",
      state: (state, { api }) => ({ order: api.reorder.order(state) }),
      attrs: (_state, part) => ({ "aria-describedby": `${part.id}-keys` }),
    }),
    keys: slot({
      attrs: (_state, part) => ({ id: `${part.id}-keys` }),
    }),
    item: slot<{ value: string }, { grabbed: boolean; position: number }>({
      role: "listitem",
      props: { value: "string" },
      state: (state, { api, key }) => ({ grabbed: api.reorder.moving(state, key), position: api.reorder.order(state).indexOf(key) + 1 }),
      attrs: (state, { api, key }) => ({
        "data-grabbed": api.reorder.moving(state, key) ? "" : undefined,
        "data-dragging": api.reorder.dragging(state, key) ? "" : undefined,
      }),
      bind: (el, part) => part.api.reorder.bind(el, part),
    }),
    handle: slot<{ value: string }, { grabbed: boolean }>({
      role: "button",
      focus: "native",
      press: { none: "Enter is handled on keydown, so the press never reaches a click; the pointer drags." },
      props: { value: { kind: "string", from: "item", required: true } },
      state: (state, { api, key }) => ({ grabbed: api.reorder.moving(state, key) }),
      attrs: (state, { api, key, id }) => ({
        type: "button",
        "aria-pressed": String(api.reorder.moving(state, key)),
        "aria-describedby": `${id}-keys`,
      }),
      on: {
        keydown: (event, { api, key }) => api.keydown(event as KeyboardEvent, key),
        pointerdown: (event, { api, key }) => api.reorder.pointerdown(event as PointerEvent, key),
      },
    }),
  }),
  agent: { actions: ["move"] },
})
