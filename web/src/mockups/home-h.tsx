import * as React from "react"
import { BookOpenIcon, CalendarClockIcon } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { COMING_BACK, REVIEWS, STUDY_DAYS } from "./learner"
import { mount } from "./shell"
import {
  ContinueLine,
  FeedbackCard,
  MARKS,
  ReviewList,
  Rhythm,
  RhythmLegend,
  day,
  fmtDay,
  markKey,
  type Mark,
} from "./parts"

function Detail({ mark }: { mark: Mark }) {
  if (mark.kind === "today")
    return (
      <div className="flex flex-col gap-6">
        <h2 className="font-heading text-2xl font-medium">
          Today: your explanation was read, and {REVIEWS.length} questions came
          back.
        </h2>
        <FeedbackCard />
        <ReviewList />
        <ContinueLine />
      </div>
    )
  if (mark.kind === "studied")
    return (
      <Card>
        <CardHeader>
          <CardDescription>{mark.lane}</CardDescription>
          <CardTitle className="font-heading text-2xl">
            {fmtDay(day(mark.day))}, {-mark.day} days ago
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ItemGroup className="gap-2">
            {STUDY_DAYS[mark.lane].map((line) => (
              <Item key={line} variant="muted" size="sm">
                <ItemMedia variant="icon">
                  <BookOpenIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="font-normal">{line}</ItemTitle>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      </Card>
    )
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <CalendarClockIcon className="size-4" /> {mark.lane}
        </CardDescription>
        <CardTitle className="font-heading text-2xl">
          {mark.items} question{mark.items > 1 ? "s come" : " comes"} back on{" "}
          {fmtDay(day(mark.day))}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ReviewList items={COMING_BACK[mark.lane].slice(0, mark.items)} />
      </CardContent>
    </Card>
  )
}

function Page() {
  const [sel, setSel] = React.useState<Mark>({ kind: "today" })
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return
      const i = MARKS.findIndex((m) => markKey(m) === markKey(sel))
      if (e.key === "h" && i > 0) setSel(MARKS[i - 1])
      if (e.key === "l" && i < MARKS.length - 1) setSel(MARKS[i + 1])
      if (e.key === "t") setSel({ kind: "today" })
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [sel])
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-4xl font-semibold text-balance">
          You studied on 9 of the last 14 days.
        </h1>
        <p className="text-lg text-muted-foreground">
          Every mark opens. Today is open now.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <Rhythm selected={markKey(sel)} onSelect={setSel} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <RhythmLegend />
            <span data-key-hint className="flex items-center gap-1.5">
              <KbdGroup>
                <Kbd>h</Kbd>
                <Kbd>l</Kbd>
              </KbdGroup>
              earlier, later
              <Kbd>t</Kbd> today
            </span>
          </div>
        </CardContent>
      </Card>
      <Detail mark={sel} />
    </>
  )
}

mount(
  {
    title: "H · The timeline is the page",
    summary:
      "E's timeline becomes the way you move around, and F's letter is simply what 'today' says when you open it.",
    points: [
      "Instead of two sections, one idea: your study is a line through time, and every mark on it opens. Today is open when you arrive, so the newest feedback is still the first thing you read.",
      "Past dots open what you did that day, in words: what you read, what you answered, what you wrote. Rings ahead open the questions coming back and why each was scheduled.",
      "Seeing why a question is scheduled for Saturday makes delayed review feel deliberate rather than random, which is when learners trust it enough to come back.",
      "h and l step through the marks and t jumps back to today: the vim-style keys School already uses. Clicking and tapping work too.",
      "Everything is still words. The chart is a way to choose what to read, never a score.",
      "Needs: per-day summaries from encounters, answers and exposures, and the review schedule with its decision notes. All already in the record.",
      "Trade-off: it asks the learner to explore. Someone who never clicks a mark gets F with a chart on top, which is still good.",
    ],
    components:
      "Card, Item, ItemGroup, Badge, Alert, Button, Kbd, KbdGroup, mode toggle, and the d3 timeline with selectable marks.",
  },
  <Page />
)
