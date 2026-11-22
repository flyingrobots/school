import { ChevronRightIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { COURSES, initials, lessonCount, mount } from "./shell"

mount(
  {
    title: "A · Quiet list",
    summary: "The homepage is a doorway, not a destination. Get the learner into a course in one click and get out of the way.",
    points: [
      "School is for long, focused reading. A plain list with no hero, no stats and no colour keeps the calm, editorial tone the theme was built for.",
      "One row per course scans fastest when there are only a handful of courses, which is School's real case: one learner and a few courses.",
      "It uses only what /api/courses already returns (name, lesson count, reference count), so it needs no new requests or endpoints.",
      "A course that fails to load still gets a row with an 'unreadable' badge, so a broken course is visible and never silently missing.",
      "Trade-off: there is no progress and no 'continue'. Coming back to a lesson takes two clicks instead of one.",
    ],
    components: "Item, ItemGroup, ItemSeparator, Avatar, Badge, Button, Dialog, Separator, mode toggle.",
  },
  <>
    <div className="flex flex-col gap-1">
      <h1 className="font-heading text-2xl font-medium">School</h1>
      <p className="text-sm text-muted-foreground">{COURSES.length} courses installed.</p>
    </div>
    <ItemGroup>
      {COURSES.map((c, i) => (
        <div key={c.name} className="contents">
          {i > 0 && <ItemSeparator />}
          <Item asChild>
            <a href="#">
              <ItemMedia>
                <Avatar>
                  <AvatarFallback>{initials(c.name)}</AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{c.name}</ItemTitle>
                <ItemDescription>
                  {c.lessons === null ? (
                    <>
                      <Badge variant="destructive">unreadable</Badge> its lessons could not be loaded
                    </>
                  ) : (
                    `${lessonCount(c.lessons)}${c.reference > 0 ? ` · ${c.reference} reference` : ""}`
                  )}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <ChevronRightIcon className="size-4" />
              </ItemActions>
            </a>
          </Item>
        </div>
      ))}
    </ItemGroup>
  </>
)
