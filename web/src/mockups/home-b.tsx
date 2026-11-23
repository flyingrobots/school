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
import { Progress } from "@/components/ui/progress"
import { COURSES, lessonCount, mount } from "./shell"

mount(
  {
    title: "B · Course cards",
    summary:
      "Progress is the point of studying, so the homepage shows how far along each course is.",
    points: [
      "Each course gets a card with a progress bar of quizzes answered correctly. Taken from the database, it shows at a glance what's done and what's untouched.",
      "The main button changes with progress ('Start', 'Continue', 'Review'), so the next action is obvious without reading.",
      "Reference material gets its own button on the card, because it's something a learner comes back for, not a footnote.",
      "The grid scales from one column on a phone to two on a desktop, and cards suit a library that grows.",
      "Trade-off: it needs one /api/courses/:c request per course for the counts, and the cards are visually heavier than a list.",
    ],
    components:
      "Card (header, action, content, footer), Progress, Badge, Button, Dialog, Separator, mode toggle.",
  },
  <>
    <div className="flex flex-col gap-1">
      <h1 className="font-heading text-2xl font-medium">Your courses</h1>
      <p className="text-sm text-muted-foreground">
        Quizzes answered correctly, per course.
      </p>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      {COURSES.map((c) => {
        const pct =
          c.quizzes === 0 ? 0 : Math.round((c.correct / c.quizzes) * 100)
        const action =
          c.correct === 0
            ? "Start"
            : c.correct === c.quizzes
              ? "Review"
              : "Continue"
        return (
          <Card key={c.name}>
            <CardHeader>
              <CardTitle>{c.name}</CardTitle>
              <CardDescription>
                {c.lessons === null
                  ? "Its lessons could not be loaded."
                  : lessonCount(c.lessons)}
              </CardDescription>
              {c.lessons === null && (
                <CardAction>
                  <Badge variant="destructive">unreadable</Badge>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Progress value={pct} aria-label={`${c.name} progress`} />
              <p className="text-xs text-muted-foreground tabular-nums">
                {c.correct} of {c.quizzes} quizzes correct
              </p>
            </CardContent>
            <CardFooter className="justify-end gap-2">
              {c.reference > 0 && <Button variant="outline">Reference</Button>}
              <Button disabled={c.lessons === null}>{action}</Button>
            </CardFooter>
          </Card>
        )
      })}
    </div>
  </>
)
