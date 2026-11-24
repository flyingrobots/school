import { BotIcon, CheckIcon, PlayIcon } from "lucide-react"

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
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { CONTINUE, COURSES, REVIEWS, WAITING } from "./learner"
import { mount } from "./shell"

const steps = [
  {
    label: "Review",
    title: `${REVIEWS.length} questions came back`,
    body: REVIEWS.map((r) => r.reason),
    minutes: 3,
  },
  {
    label: "Continue",
    title: `${CONTINUE.lesson}, lesson ${CONTINUE.position} of ${CONTINUE.of}`,
    body: [`Next question: ${CONTINUE.question}`],
    minutes: CONTINUE.minutes,
  },
  {
    label: "Write",
    title: `Explain: ${WAITING.lesson}`,
    body: [WAITING.prompt],
    minutes: 5,
    ai: true,
  },
]
const total = steps.reduce((n, s) => n + s.minutes, 0)

mount(
  {
    title: "D · Tonight's session",
    summary:
      "The learner doesn't want to choose. They want to be told what tonight is, and to know when they're done.",
    points: [
      "Self-study fails on the start, not the content. A short plan with a finite end, about 20 minutes, is easier to begin than an open list of courses.",
      "The order is the learning science: review first (spacing works best before new material crowds it out), then new reading, then writing an explanation (retrieval and generation, the strongest kind).",
      "Every step says why it's there in words, from the decision notes, so the plan never feels arbitrary.",
      "One button starts the whole session and walks the steps in order. The finish line is explicit: 'that's tonight'.",
      "Courses drop to a single line at the bottom. You can still leave the plan, but it isn't the default.",
      "Needs: a 'session' endpoint that joins due review, resume and unwritten explanations. All three already exist as queries.",
      "Trade-off: it decides for you. On a night you want to wander, it's one more click.",
    ],
    components:
      "Card, Item, ItemGroup, Badge, Button, Kbd, Separator, mode toggle. The numbered items work as a stepper.",
  },
  <>
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">Tuesday evening</p>
      <h1 className="font-heading text-4xl font-semibold text-balance">
        Tonight is about {total} minutes.
      </h1>
      <p className="text-lg text-muted-foreground">
        Three steps, in this order. When they're done, you're done.
      </p>
    </div>

    <Card>
      <CardContent>
        <ItemGroup className="gap-2">
          {steps.map((s, i) => (
            <Item key={s.label} variant={i === 0 ? "muted" : "default"}>
              <ItemMedia variant="icon">
                <span className="font-heading text-lg font-semibold">
                  {i + 1}
                </span>
              </ItemMedia>
              <ItemContent>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={i === 0 ? "default" : "secondary"}>
                    {s.label}
                  </Badge>
                  {s.ai && (
                    <Badge variant="outline">
                      <BotIcon /> graded by Claude
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    about {s.minutes} min
                  </span>
                </div>
                <ItemTitle className="text-base">{s.title}</ItemTitle>
                {s.body.map((b) => (
                  <ItemDescription key={b} className="line-clamp-none">
                    {b}
                  </ItemDescription>
                ))}
              </ItemContent>
              {i === 0 && (
                <ItemFooter className="text-xs text-muted-foreground">
                  You're here.
                </ItemFooter>
              )}
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-3">
        <Button size="lg">
          <PlayIcon data-icon="inline-start" />
          Start tonight's session
          <Kbd>↵</Kbd>
        </Button>
        <Button variant="ghost">Skip review tonight</Button>
      </CardFooter>
    </Card>

    <Card className="border-dashed shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckIcon className="size-4" /> After step 3
        </CardTitle>
        <CardDescription>
          The page says "That's tonight" and tells you when the next questions
          come back: one tomorrow and one on Thursday.
        </CardDescription>
      </CardHeader>
    </Card>

    <Separator />
    <p className="text-sm text-muted-foreground">
      Or go straight to a course:{" "}
      {COURSES.map((c, i) => (
        <span key={c.slug}>
          {i > 0 && " · "}
          <a href="#" className="underline underline-offset-4">
            {c.title}
          </a>
        </span>
      ))}
    </p>
  </>
)
