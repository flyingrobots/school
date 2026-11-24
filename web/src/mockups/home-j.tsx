import * as React from "react"
import {
  ArrowRightIcon,
  BookOpenIcon,
  PlayIcon,
  SparklesIcon,
} from "lucide-react"

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
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel"
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
  FeedbackCard,
  ReviewList,
  Rhythm,
  RhythmLegend,
  day,
  fmtDay,
  markKey,
  marksFor,
  type Lane,
  type Mark,
} from "./parts"
import {
  BlueLine,
  BobGrid,
  Call,
  Centuries,
  Extents,
  NestedGraph,
  NeighboursSwap,
  Notation,
} from "./showcase"

const BELLS = "The Mathematics of Bells"
const AION = "AIΩN Foundations"

// Each hook is a question the lesson answers, written from its subtitle and objectives, with a
// picture computed from what it teaches.
const HOOKS: {
  course: string
  lesson: string
  where: string
  hook: string
  teaser: string
  picture: React.ReactNode
  started?: boolean
}[] = [
  {
    course: AION,
    lesson: "Graphs of Graphs",
    where: "Lesson 2 of 2",
    hook: "What does a graph made of graphs look like?",
    teaser:
      "The thing AIΩN transforms, and a picture of it you can draw from memory.",
    picture: <NestedGraph />,
    started: true,
  },
  {
    course: BELLS,
    lesson: "Writing changes down",
    where: "Lesson 2 of 7",
    hook: "How do ringers write hours of ringing on one line?",
    teaser:
      "They write down which bells stand still, and that's enough to rebuild everything.",
    picture: <Notation />,
  },
  {
    course: BELLS,
    lesson: "Every row once",
    where: "Lesson 4 of 7",
    hook: "Why are seven bells the sweet spot?",
    teaser:
      "Ring every order once: 5,040 rows on seven is one three-hour peal. On eight it's most of a day.",
    picture: <Extents />,
  },
  {
    course: BELLS,
    lesson: "Plain Bob",
    where: "Lesson 5 of 7",
    hook: "One small change, and all 24 rows ring once?",
    teaser:
      "Change one change in every eight, and the plain hunt stops repeating itself.",
    picture: <BobGrid />,
  },
  {
    course: BELLS,
    lesson: "Calls and truth",
    where: "Lesson 6 of 7",
    hook: "What happens when someone shouts “Bob!”?",
    teaser:
      "The whole band takes a different path through the rows, all at once.",
    picture: <Call />,
  },
  {
    course: BELLS,
    lesson: "Group theory, two centuries early",
    where: "Lesson 7 of 7",
    hook: "Were 17th-century ringers doing group theory?",
    teaser:
      "Stedman's books came out in 1668 and 1677. The mathematics got its name in the 1800s.",
    picture: <Centuries />,
  },
  {
    course: BELLS,
    lesson: "Bells that can't hurry",
    where: "Lesson 1 of 7",
    hook: "Why can a bell only move one place?",
    teaser:
      "A bell rung full circle can weigh more than a ton. Physics decides the rest.",
    picture: <NeighboursSwap />,
  },
]

const LANES: Lane[] = [
  {
    title: AION,
    studied: [-6, -5, -2, 0],
    returns: [
      { day: 1, items: 2 },
      { day: 4, items: 1 },
    ],
  },
  { title: BELLS, studied: [], returns: [], note: "not started yet" },
]
const MARKS = marksFor(LANES)

function Hero() {
  return (
    <Card className="overflow-hidden">
      <div className="grid items-center gap-6 md:grid-cols-[1fr_auto]">
        <CardHeader className="gap-4">
          <CardDescription className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              <SparklesIcon /> New for you
            </Badge>
            {BELLS} · 7 lessons
          </CardDescription>
          <CardTitle className="font-heading text-4xl leading-tight font-semibold text-balance md:text-5xl">
            Ever wonder why church bells never play a tune?
          </CardTitle>
          <p className="text-lg text-balance text-muted-foreground">
            English bells are rung full circle, some weigh more than a ton, and
            one physical rule follows. Instead of tunes, they ring patterns like
            this one, the plain hunt, where every bell weaves to the back and
            home again.
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="lg">
              <PlayIcon data-icon="inline-start" /> Start lesson 1<Kbd>↵</Kbd>
            </Button>
            <Button size="lg" variant="ghost">
              See all 7 lessons
            </Button>
          </div>
        </CardHeader>
        <div className="flex h-80 justify-center bg-background px-8 py-6 md:h-[26rem]">
          <BlueLine big />
        </div>
      </div>
    </Card>
  )
}

function Showcase() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-heading text-2xl font-medium">
            Still ahead in your courses
          </h2>
          <p className="text-muted-foreground">
            Questions your next lessons answer.
          </p>
        </div>
      </div>
      <Carousel opts={{ align: "start" }} className="px-0 md:px-12">
        <CarouselContent>
          {HOOKS.map((h) => (
            <CarouselItem
              key={h.lesson}
              className="basis-[85%] sm:basis-1/2 lg:basis-1/3"
            >
              <Card className="h-full overflow-hidden pt-0">
                <div className="flex h-40 items-center justify-center border-b bg-background p-4">
                  {h.picture}
                </div>
                <CardHeader>
                  <CardDescription className="flex flex-wrap items-center gap-2">
                    {h.started && <Badge>You're partway</Badge>}
                    {h.course}
                  </CardDescription>
                  <CardTitle className="text-lg leading-snug text-balance">
                    {h.hook}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex-1 text-sm text-muted-foreground">
                  {h.teaser}
                </CardContent>
                <CardFooter className="justify-between text-sm">
                  <span className="text-muted-foreground">
                    {h.where}: {h.lesson}
                  </span>
                  <ArrowRightIcon className="size-4" />
                </CardFooter>
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="hidden md:inline-flex" />
        <CarouselNext className="hidden md:inline-flex" />
      </Carousel>
    </section>
  )
}

function Detail({ mark }: { mark: Mark }) {
  if (mark.kind === "today")
    return (
      <div className="flex flex-col gap-6">
        <FeedbackCard />
        <div className="flex flex-col gap-3">
          <h3 className="font-heading text-xl font-medium">
            Ready for another look
          </h3>
          <ReviewList />
        </div>
      </div>
    )
  if (mark.kind === "studied")
    return (
      <Card>
        <CardHeader>
          <CardDescription>{mark.lane}</CardDescription>
          <CardTitle className="font-heading text-2xl">
            {fmtDay(day(mark.day))}
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
        <CardDescription>{mark.lane}</CardDescription>
        <CardTitle className="font-heading text-2xl">
          {mark.items} question{mark.items > 1 ? "s" : ""} for{" "}
          {fmtDay(day(mark.day))}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ReviewList items={COMING_BACK[mark.lane].slice(0, mark.items)} />
      </CardContent>
    </Card>
  )
}

function SinceLastTime() {
  const [sel, setSel] = React.useState<Mark>({ kind: "today" })
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = MARKS.findIndex((m) => markKey(m) === markKey(sel))
      if (e.key === "h" && i > 0) setSel(MARKS[i - 1])
      if (e.key === "l" && i < MARKS.length - 1) setSel(MARKS[i + 1])
      if (e.key === "t") setSel({ kind: "today" })
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [sel])
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-heading text-2xl font-medium">
          Since you were last here
        </h2>
        <p className="text-muted-foreground">
          Claude read your explanation, and {REVIEWS.length} questions are ready
          for another look.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Detail mark={sel} />
        </div>
        <div className="lg:col-span-5">
          <Card className="lg:sticky lg:top-6">
            <CardHeader>
              <CardTitle>You studied on 4 of the last 14 days</CardTitle>
              <CardDescription>
                Every mark opens. Today is open now.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Rhythm lanes={LANES} selected={markKey(sel)} onSelect={setSel} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <RhythmLegend />
                <span data-key-hint className="flex items-center gap-1.5">
                  <KbdGroup>
                    <Kbd>h</Kbd>
                    <Kbd>l</Kbd>
                  </KbdGroup>
                  <Kbd>t</Kbd>
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

mount(
  {
    title: "J · Something to look forward to",
    summary:
      "G and H, with a reason to come back on top: a showcase of what the learner's own courses are about to teach them, as questions with pictures.",
    points: [
      "Stats and feedback tell you where you've been. What makes someone open a lesson is curiosity about where they're going, so the page leads with a question worth answering.",
      "The hero picks one course you've installed but haven't started, and asks the question its first lesson answers. Beside it, the plain hunt draws itself, bell by bell: the pattern bells ring instead of tunes.",
      "'Still ahead in your courses' is a row of questions from lessons you haven't finished, each with a picture. Every picture is computed from the method the lesson teaches: the 24 rows of Plain Bob are really rung by applying its place notation, and the page checks them against the course's own claims.",
      "Only installed, unfinished courses appear, and only lessons not yet finished. A finished course never shows up here again.",
      "Below it sits G and H combined: the letter on the left (feedback, then questions ready for another look, each naming its course), and the timeline on the right, where every mark opens in the letter's place. h, l and t move along it.",
      "Needs: a hook per lesson, which a course could declare (a question and a teaser), or School could write from the lesson's subtitle and objectives when preparing it. The pictures would be a small set of figure blocks a course can use.",
      "Trade-off: the hooks are only as good as the course's writing. A course without them falls back to its lesson subtitles, which are already written to entice.",
    ],
    components:
      "Card, Carousel, Badge, Button, Item, Kbd, Popover, mode toggle, d3 for every picture and the timeline, and GSAP to draw the plain hunt.",
  },
  <>
    <Hero />
    <Showcase />
    <SinceLastTime />
  </>,
  "max-w-6xl"
)
