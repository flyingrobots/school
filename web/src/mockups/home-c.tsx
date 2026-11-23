import {
  ArrowRightIcon,
  ChevronRightIcon,
  PresentationIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { COURSES, lessonCount, mount } from "./shell"

mount(
  {
    title: "C · Pick up where you left off",
    summary:
      "A daily learner almost always wants the lesson they were last in, so that's what the page leads with.",
    points: [
      "The featured card resumes the last lesson opened, showing its title, subtitle and how many of its quizzes are done. One click puts you back in it.",
      "'Present' sits next to 'Continue' because the slides view is the other way a lesson gets used, and it records nothing.",
      "Every other course stays one row away in a compact list, so the page never hides the library.",
      "It matches School's habit loop: open School, keep going. Choosing a course is the rare case, not the default.",
      "Trade-off: it needs a small new endpoint for the most recent view. The server already records views in POST /api/view, but nothing reads them back yet. A first-time learner sees only the list.",
    ],
    components:
      "Card, Progress, Badge, Button, Item, ItemGroup, ItemSeparator, Dialog, Separator, mode toggle.",
  },
  <>
    <Card>
      <CardHeader>
        <CardDescription>Continue · aion</CardDescription>
        <CardTitle className="text-xl">Lesson 2 · Warp graphs</CardTitle>
        <CardAction>
          <Badge variant="secondary">yesterday</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          How a graph rewrites itself, one tick at a time.
        </p>
        <div className="flex items-center gap-3">
          <Progress value={40} aria-label="Lesson progress" />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            2 of 5 quizzes
          </span>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline">
          <PresentationIcon data-icon="inline-start" />
          Present
        </Button>
        <Button>
          Continue
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </CardFooter>
    </Card>
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-sm font-medium text-muted-foreground">
        All courses
      </h2>
      <ItemGroup>
        {COURSES.map((c, i) => (
          <div key={c.name} className="contents">
            {i > 0 && <ItemSeparator />}
            <Item asChild size="sm">
              <a href="#">
                <ItemContent>
                  <ItemTitle>{c.name}</ItemTitle>
                  <ItemDescription>
                    {c.lessons === null
                      ? "its lessons could not be loaded"
                      : `${lessonCount(c.lessons)} · ${c.correct === 0 ? "not started" : `${c.correct} of ${c.quizzes} correct`}`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {c.lessons === null && (
                    <Badge variant="destructive">unreadable</Badge>
                  )}
                  <ChevronRightIcon className="size-4" />
                </ItemActions>
              </a>
            </Item>
          </div>
        ))}
      </ItemGroup>
    </div>
  </>
)
