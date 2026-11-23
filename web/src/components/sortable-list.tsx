import * as React from "react"
import { GripVerticalIcon } from "lucide-react"
import { createParts } from "@ui-sdk/react/primitive"

import { Button } from "@/components/ui/button"
import { Item, ItemGroup } from "@/components/ui/item"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"
import { sortableList } from "@/lib/sortable-list-behavior"

// A list reordered by each item's handle, with the pointer or the keyboard (lib/sortable-list-behavior.ts).
// Stock ItemGroup and Item draw it; the keys it takes are shown beneath it with Kbd.

const parts = createParts(sortableList, { root: "div", list: "div", keys: "p", item: "div", handle: "button" })

type RootProps = React.ComponentProps<typeof parts.Root>

function SortableList({ className, children, ...props }: RootProps) {
  return (
    <parts.Root data-slot="sortable-list" className={cn("flex w-full flex-col gap-3", className)} {...props}>
      {children}
    </parts.Root>
  )
}

function SortableListItems({ className, ...props }: React.ComponentProps<typeof parts.List>) {
  return <parts.List render={<ItemGroup />} className={cn("gap-3", className)} {...props} />
}

function SortableListItem({ className, ...props }: React.ComponentProps<typeof parts.Item>) {
  return (
    <parts.Item
      render={<Item variant="outline" />}
      className={cn(
        "touch-none bg-card data-grabbed:border-ring data-grabbed:ring-[3px] data-grabbed:ring-ring/50 data-dragging:relative data-dragging:z-10 data-dragging:translate-x-(--drag-x) data-dragging:translate-y-(--drag-y) data-dragging:shadow-lg",
        className
      )}
      {...props}
    />
  )
}

function SortableListHandle({ className, children, ...props }: React.ComponentProps<typeof parts.Handle>) {
  return (
    <parts.Handle render={<Button variant="ghost" size="icon-lg" />} className={cn("cursor-grab aria-pressed:bg-accent", className)} {...props}>
      {children ?? <GripVerticalIcon aria-hidden="true" />}
    </parts.Handle>
  )
}

function SortableListKeys({ className, ...props }: React.ComponentProps<typeof parts.Keys>) {
  return (
    <parts.Keys className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-base text-muted-foreground", className)} {...props}>
      <span className="inline-flex items-center gap-2">
        <Kbd>↵</Kbd> picks up and drops
      </span>
      <span className="inline-flex items-center gap-2">
        <KbdGroup>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
        </KbdGroup>
        or
        <KbdGroup>
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
        </KbdGroup>
        move
      </span>
      <span className="inline-flex items-center gap-2">
        <KbdGroup>
          <Kbd>Home</Kbd>
          <Kbd>End</Kbd>
        </KbdGroup>
        to either end
      </span>
      <span className="inline-flex items-center gap-2">
        <Kbd>Esc</Kbd> puts it back
      </span>
    </parts.Keys>
  )
}

export { SortableList, SortableListHandle, SortableListItem, SortableListItems, SortableListKeys }
