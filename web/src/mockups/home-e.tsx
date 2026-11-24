import { ArrowRightIcon } from "lucide-react"
import * as d3 from "d3"

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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Kbd } from "@/components/ui/kbd"
import { CONTINUE, RHYTHM } from "./learner"
import { mount } from "./shell"

const W = 720
const LANE = 56
const PAD = { top: 28, left: 8, right: 8, bottom: 8 }
const H = PAD.top + LANE * RHYTHM.lanes.length + PAD.bottom
const day = (n: number) => d3.timeDay.offset(RHYTHM.today, n)
const x = d3
  .scaleTime()
  .domain([day(-14), day(14)])
  .range([PAD.left, W - PAD.right])
const fmt = d3.timeFormat("%a %-d %b")
const weeks = d3.timeMonday.range(day(-14), day(15))

function Rhythm() {
  return (
    <TooltipProvider>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full overflow-visible"
        role="img"
        aria-label="Days you studied over the last two weeks, and when questions come back over the next two"
      >
        <rect
          x={x(day(0))}
          y={PAD.top - 8}
          width={x(day(14)) - x(day(0))}
          height={H - PAD.top}
          className="fill-muted"
          rx={6}
        />
        {weeks.map((w) => (
          <g key={+w}>
            <line
              x1={x(w)}
              x2={x(w)}
              y1={PAD.top - 8}
              y2={H}
              className="stroke-border"
            />
            {Math.abs(+w - +RHYTHM.today) > 2 * 864e5 && (
              <text
                x={x(w) + 4}
                y={12}
                className="fill-muted-foreground text-[11px]"
              >
                {d3.timeFormat("%-d %b")(w)}
              </text>
            )}
          </g>
        ))}
        <line
          x1={x(day(0))}
          x2={x(day(0))}
          y1={PAD.top - 12}
          y2={H}
          className="stroke-foreground"
          strokeWidth={2}
        />
        <text
          x={x(day(0)) + 4}
          y={PAD.top - 14}
          className="fill-foreground text-[11px] font-semibold"
        >
          today
        </text>
        {RHYTHM.lanes.map((lane, i) => {
          const y = PAD.top + LANE * i + LANE / 2
          return (
            <g key={lane.title}>
              <text
                x={PAD.left}
                y={y - 14}
                className="fill-muted-foreground text-[12px]"
              >
                {lane.title}
              </text>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y + 4}
                y2={y + 4}
                className="stroke-border"
                strokeDasharray="2 4"
              />
              {lane.studied.map((d) => (
                <Tooltip key={d}>
                  <TooltipTrigger asChild>
                    <circle
                      cx={x(day(d))}
                      cy={y + 4}
                      r={6}
                      className="fill-primary"
                    />
                  </TooltipTrigger>
                  <TooltipContent>Studied {fmt(day(d))}</TooltipContent>
                </Tooltip>
              ))}
              {lane.returns.map((r) => (
                <Tooltip key={r.day}>
                  <TooltipTrigger asChild>
                    <circle
                      cx={x(day(r.day))}
                      cy={y + 4}
                      r={5 + r.items * 2}
                      className="fill-background stroke-chart-2"
                      strokeWidth={2}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {r.items} question{r.items > 1 ? "s come" : " comes"} back{" "}
                    {fmt(day(r.day))}
                  </TooltipContent>
                </Tooltip>
              ))}
            </g>
          )
        })}
      </svg>
    </TooltipProvider>
  )
}

mount(
  {
    title: "E · Rhythm",
    summary:
      "Delayed review only works if the learner trusts the spacing. So show it: when you studied, and when things come back.",
    points: [
      "School's strongest evidence is a correct answer after a delay (RFC 2 §5). That's a feature about time, and time is the one thing a list can't show. A timeline can.",
      "Left of 'today' is what you did: a dot per day you studied. Right of it is what's coming: a ring per day review items return, bigger for more items. Gaps are visible without a streak counter or a score.",
      "It answers the quiet question behind 'did I study enough?' honestly: the dots are the record. Nothing is a percentage or a points total.",
      "d3 earns its place here: a time scale, week ticks and day positions. Everything is drawn in theme tokens, so it follows light and dark.",
      "The headline says it in words for anyone who doesn't read charts, and the lesson to continue sits right under it.",
      "Needs: an endpoint for study days per course (from encounters) and the due-review schedule projected forward.",
      "Trade-off: a gap of empty days is visible, which can sting. It's shown as fact, never as a broken streak.",
    ],
    components:
      "Card, Badge, Button, Kbd, Tooltip, mode toggle, and an SVG laid out with d3 scales.",
  },
  <>
    <div className="flex flex-col gap-2">
      <h1 className="font-heading text-4xl font-semibold text-balance">
        You studied on 9 of the last 14 days.
      </h1>
      <p className="text-lg text-muted-foreground">
        One question comes back tomorrow, and four more by Saturday.
      </p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Two weeks back, two weeks ahead</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5">
            <svg viewBox="0 0 12 12" className="size-3">
              <circle cx={6} cy={6} r={5} className="fill-primary" />
            </svg>
            studied
          </span>
          <span className="flex items-center gap-1.5">
            <svg viewBox="0 0 12 12" className="size-3">
              <circle
                cx={6}
                cy={6}
                r={4.5}
                className="fill-background stroke-chart-2"
                strokeWidth={1.5}
              />
            </svg>
            questions come back (bigger ring, more questions)
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Rhythm />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardDescription>
          Lesson {CONTINUE.position} of {CONTINUE.of} in {CONTINUE.course}
        </CardDescription>
        <CardTitle className="font-heading text-2xl">
          {CONTINUE.lesson}
        </CardTitle>
        <CardAction>
          <Badge variant="secondary">about {CONTINUE.minutes} min</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-muted-foreground">
        Next question: {CONTINUE.question}
      </CardContent>
      <CardFooter>
        <Button>
          Continue <ArrowRightIcon data-icon="inline-end" />
          <Kbd>↵</Kbd>
        </Button>
      </CardFooter>
    </Card>
  </>
)
