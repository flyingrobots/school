import * as React from "react"
import * as d3 from "d3"
import {
  ArrowRightIcon,
  BotIcon,
  PenLineIcon,
  RotateCcwIcon,
} from "lucide-react"

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
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import {
  CONTINUE,
  GRADED,
  REVIEWS,
  RHYTHM,
  verdictWord,
  type Verdict,
} from "./learner"

export const verdictVariant: Record<
  Verdict,
  "default" | "secondary" | "outline"
> = {
  meets: "default",
  partly: "secondary",
  misses: "outline",
}

export function FeedbackCard({ compact = false }: { compact?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <BotIcon /> graded by {GRADED.gradedBy}
          </Badge>
          {GRADED.lesson}, {GRADED.course}
        </CardDescription>
        <CardTitle
          className={
            compact
              ? "text-lg leading-snug text-balance"
              : "font-heading text-2xl leading-snug text-balance"
          }
        >
          “{GRADED.prompt}”
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className={compact ? "leading-relaxed" : "text-lg leading-relaxed"}>
          {GRADED.summary}
        </p>
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
  )
}

export function ReviewList({
  items = REVIEWS,
}: {
  items?: readonly { question: string; reason: string }[]
}) {
  return (
    <ItemGroup className="gap-2">
      {items.map((r) => (
        <Item key={r.question} variant="muted">
          <ItemContent>
            <ItemTitle className="text-base">{r.question}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {r.reason}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button variant="outline" size="sm">
              <RotateCcwIcon data-icon="inline-start" /> Answer
            </Button>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  )
}

export function ContinueLine() {
  return (
    <Alert>
      <ArrowRightIcon />
      <AlertTitle>
        Then: {CONTINUE.lesson}, lesson {CONTINUE.position} of {CONTINUE.of} in{" "}
        {CONTINUE.course}
      </AlertTitle>
      <AlertDescription>Next question: {CONTINUE.question}</AlertDescription>
    </Alert>
  )
}

// ---- The timeline ---------------------------------------------------------------------------

export type Mark =
  | { kind: "today" }
  | { kind: "studied"; lane: string; day: number }
  | { kind: "returns"; lane: string; day: number; items: number }

export const markKey = (m: Mark) =>
  m.kind === "today" ? "today" : `${m.kind}:${m.lane}:${m.day}`

export const day = (n: number) => d3.timeDay.offset(RHYTHM.today, n)
export const fmtDay = d3.timeFormat("%A %-d %B")

// Every mark in time order, today included, for h/l stepping.
export const MARKS: Mark[] = [
  ...RHYTHM.lanes.flatMap((l) => [
    ...l.studied
      .filter((d) => d !== 0)
      .map((d): Mark => ({ kind: "studied", lane: l.title, day: d })),
    ...l.returns.map((r): Mark => ({ kind: "returns", lane: l.title, ...r })),
  ]),
  { kind: "today" } as Mark,
].sort(
  (a, b) =>
    (a.kind === "today" ? 0 : a.day) - (b.kind === "today" ? 0 : b.day) ||
    (a.kind === "today" ? -1 : 1)
)

const W = 720
const LANE = 56
const PAD = { top: 28, left: 8, right: 8, bottom: 8 }
const H = PAD.top + LANE * RHYTHM.lanes.length + PAD.bottom
const x = d3
  .scaleTime()
  .domain([day(-14), day(14)])
  .range([PAD.left, W - PAD.right])
const weeks = d3.timeMonday.range(day(-14), day(15))

export function RhythmLegend() {
  return (
    <span className="flex flex-wrap items-center gap-3">
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
        questions come back
      </span>
    </span>
  )
}

export function Rhythm({
  selected,
  onSelect,
}: {
  selected?: string
  onSelect?: (m: Mark) => void
}) {
  const pick = (m: Mark) => ({
    role: onSelect ? "button" : undefined,
    tabIndex: onSelect ? 0 : undefined,
    onClick: onSelect && (() => onSelect(m)),
    onKeyDown:
      onSelect &&
      ((e: React.KeyboardEvent) => e.key === "Enter" && onSelect(m)),
    className: onSelect ? "cursor-pointer outline-none" : undefined,
  })
  const ring = (key: string, cx: number, cy: number, r: number) =>
    selected === key && (
      <circle
        cx={cx}
        cy={cy}
        r={r + 5}
        className="fill-none stroke-ring"
        strokeWidth={2}
      />
    )
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full overflow-visible"
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
      <g {...pick({ kind: "today" })} aria-label="Today">
        <rect
          x={x(day(0)) - 10}
          y={PAD.top - 26}
          width={50}
          height={H - PAD.top + 26}
          className="fill-transparent"
        />
        {selected === "today" && (
          <rect
            x={x(day(0)) - 8}
            y={PAD.top - 26}
            width={16}
            height={H - PAD.top + 26}
            rx={8}
            className="fill-none stroke-ring"
            strokeWidth={2}
          />
        )}
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
      </g>
      {RHYTHM.lanes.map((lane, i) => {
        const y = PAD.top + LANE * i + LANE / 2 + 4
        return (
          <g key={lane.title}>
            <text
              x={PAD.left}
              y={y - 18}
              className="fill-muted-foreground text-[12px]"
            >
              {lane.title}
            </text>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeDasharray="2 4"
            />
            {lane.studied.map((d) => {
              const m: Mark = { kind: "studied", lane: lane.title, day: d }
              return (
                <g
                  key={d}
                  {...(d === 0 ? {} : pick(m))}
                  aria-label={`Studied ${lane.title}, ${fmtDay(day(d))}`}
                >
                  {d !== 0 && ring(markKey(m), x(day(d)), y, 6)}
                  <circle
                    cx={x(day(d))}
                    cy={y}
                    r={6}
                    className="fill-primary"
                  />
                </g>
              )
            })}
            {lane.returns.map((r) => {
              const m: Mark = { kind: "returns", lane: lane.title, ...r }
              const rad = 5 + r.items * 2
              return (
                <g
                  key={r.day}
                  {...pick(m)}
                  aria-label={`${r.items} questions come back, ${fmtDay(day(r.day))}`}
                >
                  {ring(markKey(m), x(day(r.day)), y, rad)}
                  <circle
                    cx={x(day(r.day))}
                    cy={y}
                    r={rad}
                    className="fill-background stroke-chart-2"
                    strokeWidth={2}
                  />
                </g>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}
