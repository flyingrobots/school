import { ArrowRightIcon, BotIcon, PenLineIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { CONTINUE, GRADED, verdictWord, type Verdict } from "./learner"
import { mount } from "./shell"
import { ReviewList } from "./parts"

const verdictVariant: Record<Verdict, "default" | "secondary" | "outline"> = {
  meets: "default",
  partly: "secondary",
  misses: "outline",
}

mount(
  {
    title: "F · Since you were last here",
    summary:
      "The most valuable thing School has to show is feedback the learner hasn't read yet. Lead with it, like a letter.",
    points: [
      "Grading happens after you leave a lesson, so its notes are easy to miss. Feedback you never read teaches nothing. The home page is where it belongs.",
      "Each criterion is a word (Meets, Partly, Not yet) with the grader's note beside it. No score, as RFC 2 §4.3 decides.",
      "The one action that follows feedback is to try again, so 'Rewrite it' is the first button. Reading on without acting is still one click away.",
      "Every review item names its course and lesson, and its (i) answers 'why am I being asked this?' Only questions you've answered can come back, so a course you haven't opened never sends you one.",
      "Anything AI did carries the robot label and names the model, so the learner always knows a judgment came from Claude and not from School's rules.",
      "When there's nothing new, the page shrinks to the lesson to continue. It's quiet on quiet days.",
      "Needs: a 'since' query over gradings and decision notes newer than your last visit, plus a 'read' mark recorded as an event.",
      "Trade-off: on a day with lots of feedback the page gets long. It would cap at three items and link to the rest.",
    ],
    components:
      "Card, Item, ItemGroup, Badge, Alert, Button, Kbd, Separator, mode toggle.",
  },
  <>
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Since you were last here, Sunday night
      </p>
      <h1 className="font-heading text-4xl font-semibold text-balance">
        Your explanation was read, and two questions came back.
      </h1>
    </div>

    <Card>
      <CardHeader>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <BotIcon /> graded by {GRADED.gradedBy}
          </Badge>
          {GRADED.lesson}, {GRADED.course}
        </CardDescription>
        <CardTitle className="font-heading text-2xl leading-snug text-balance">
          “{GRADED.prompt}”
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-lg leading-relaxed">{GRADED.summary}</p>
        <ItemGroup className="gap-2">
          {GRADED.criteria.map((c) => (
            <Item key={c.name} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>
                  {c.name}
                  <Badge variant={verdictVariant[c.verdict]}>
                    {verdictWord[c.verdict]}
                  </Badge>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {c.note}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button>
          <PenLineIcon data-icon="inline-start" /> Rewrite it
          <Kbd>↵</Kbd>
        </Button>
        <Button variant="ghost">Read my answer again</Button>
      </CardFooter>
    </Card>

    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-xl font-medium">Came back for review</h2>
      <ReviewList />
    </div>

    <Separator />

    <Alert>
      <ArrowRightIcon />
      <AlertTitle>
        Then: {CONTINUE.lesson}, lesson {CONTINUE.position} of {CONTINUE.of} in{" "}
        {CONTINUE.course}
      </AlertTitle>
      <AlertDescription>Next question: {CONTINUE.question}</AlertDescription>
    </Alert>
  </>
)
