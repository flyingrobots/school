import * as React from "react"
import * as d3 from "d3"
import { BotIcon, PenLineIcon } from "lucide-react"

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
import { Kbd } from "@/components/ui/kbd"
import {
  CRITERIA,
  EXPLANATIONS,
  REVIEWS,
  RHYTHM,
  verdictWord,
  type Verdict,
} from "./learner"
import { mount } from "./shell"
import { ContinueLine, FeedbackCard, ReviewList, verdictVariant } from "./parts"

const W = 720
const ROW = 64
const LABEL = 150
const PAD = { top: 24, right: 16, bottom: 8 }
const H = PAD.top + ROW * EXPLANATIONS.length + PAD.bottom
const dayOf = (n: number) => d3.timeDay.offset(RHYTHM.today, n)
const x = d3
  .scaleTime()
  .domain([dayOf(-14), dayOf(1)])
  .range([LABEL + 12, W - PAD.right])
const fmt = d3.timeFormat("%-d %b")
const PIP = 9

// A pip per criterion: filled for meets, half for partly, hollow for not yet.
function Pip({ v, cx, cy }: { v: Verdict; cx: number; cy: number }) {
  return (
    <g>
      <rect
        x={cx - PIP / 2}
        y={cy - PIP / 2}
        width={PIP}
        height={PIP}
        rx={2}
        className={
          v === "meets"
            ? "fill-primary stroke-primary"
            : "fill-background stroke-primary"
        }
        strokeWidth={1.5}
      />
      {v === "partly" && (
        <rect
          x={cx - PIP / 2}
          y={cy}
          width={PIP}
          height={PIP / 2}
          rx={1}
          className="fill-primary"
        />
      )}
    </g>
  )
}

function Journal({
  selected,
  onSelect,
}: {
  selected: string
  onSelect: (k: string) => void
}) {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full overflow-visible"
      aria-label="Every explanation you've written, each attempt with its three judgments"
    >
      {d3.timeMonday.range(dayOf(-14), dayOf(2)).map((w) => (
        <g key={+w}>
          <line
            x1={x(w)}
            x2={x(w)}
            y1={PAD.top - 6}
            y2={H}
            className="stroke-border"
          />
          <text
            x={x(w) + 4}
            y={12}
            className="fill-muted-foreground text-[11px]"
          >
            {fmt(w)}
          </text>
        </g>
      ))}
      {EXPLANATIONS.map((e, i) => {
        const y = PAD.top + ROW * i + 24
        const pts = e.attempts.map((a) => x(dayOf(a.day)))
        return (
          <g key={e.lesson}>
            <text
              x={0}
              y={y - 2}
              className="fill-foreground text-[13px] font-medium"
            >
              {e.lesson}
            </text>
            <text
              x={0}
              y={y + 14}
              className="fill-muted-foreground text-[11px]"
            >
              {e.attempts.length === 0
                ? "not written yet"
                : `${e.attempts.length} attempt${e.attempts.length > 1 ? "s" : ""}`}
            </text>
            {pts.length > 1 && (
              <line
                x1={pts[0]}
                x2={pts[pts.length - 1]}
                y1={y + 6}
                y2={y + 6}
                className="stroke-muted-foreground"
                strokeDasharray="3 3"
              />
            )}
            {e.attempts.map((a, j) => {
              const k = `${e.lesson}:${j}`
              const cx = pts[j]
              return (
                <g
                  key={j}
                  role="button"
                  tabIndex={0}
                  aria-label={`${e.lesson}, attempt ${j + 1}: ${a.verdicts.map((v, n) => `${CRITERIA[n]} ${verdictWord[v]}`).join(", ")}`}
                  onClick={() => onSelect(k)}
                  onKeyDown={(ev) => ev.key === "Enter" && onSelect(k)}
                  className="cursor-pointer outline-none"
                >
                  <rect
                    x={cx - 12}
                    y={y - 14}
                    width={24}
                    height={40}
                    rx={6}
                    className={
                      selected === k
                        ? "fill-background stroke-ring"
                        : "fill-background stroke-border"
                    }
                    strokeWidth={selected === k ? 2 : 1}
                  />
                  {a.verdicts.map((v, n) => (
                    <Pip key={n} v={v} cx={cx} cy={y - 6 + n * 12} />
                  ))}
                </g>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-3">
      {(["meets", "partly", "misses"] as Verdict[]).map((v) => (
        <span key={v} className="flex items-center gap-1.5">
          <svg viewBox="0 0 12 12" className="size-3">
            <Pip v={v} cx={6} cy={6} />
          </svg>
          {verdictWord[v]}
        </span>
      ))}
      <span>· top to bottom: {CRITERIA.join(", ").toLowerCase()}</span>
    </span>
  )
}

function Attempt({ k }: { k: string }) {
  const [lesson, j] = k.split(":")
  const e = EXPLANATIONS.find((e) => e.lesson === lesson)!
  const a = e.attempts[Number(j)]
  if (k === LATEST) return <FeedbackCard />
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <BotIcon /> graded by Claude
          </Badge>
          {e.lesson}, attempt {Number(j) + 1},{" "}
          {d3.timeFormat("%A %-d %B")(dayOf(a.day))}
        </CardDescription>
        <CardTitle className="text-lg leading-snug text-balance">
          “{e.prompt}”
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {a.verdicts.map((v, n) => (
          <Badge key={n} variant={verdictVariant[v]}>
            {CRITERIA[n]}: {verdictWord[v]}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button variant="outline">Read this attempt and its notes</Button>
        {Number(j) === e.attempts.length - 1 && (
          <Button>
            <PenLineIcon data-icon="inline-start" /> Rewrite it
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

const LATEST = `The Inversion:1`

function Page() {
  const [sel, setSel] = React.useState(LATEST)
  const unwritten = EXPLANATIONS.filter((e) => e.attempts.length === 0)
  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Since you were last here, Sunday night
        </p>
        <h1 className="font-heading text-4xl font-semibold text-balance">
          Your explanation of Graphs of Graphs went from two “not yet”s to
          meeting every criterion, in three tries.
        </h1>
        <p className="text-lg text-muted-foreground">
          Today's try at The Inversion was read. {REVIEWS.length} questions came
          back too.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Everything you've explained</CardTitle>
          <CardDescription>
            Each box is one attempt, with Claude's three judgments. Open one to
            read its notes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Journal selected={sel} onSelect={setSel} />
          <div className="text-xs text-muted-foreground">
            <Legend />
          </div>
        </CardContent>
      </Card>
      <Attempt k={sel} />
      {unwritten.length > 0 && (
        <Card className="border-dashed shadow-none">
          <CardHeader>
            <CardDescription>Not written yet</CardDescription>
            <CardTitle className="text-lg leading-snug text-balance">
              {unwritten[0].lesson}: “{unwritten[0].prompt}”
            </CardTitle>
          </CardHeader>
          <CardFooter>
            <Button variant="outline">
              <PenLineIcon data-icon="inline-start" /> Write it
              <Kbd>w</Kbd>
            </Button>
          </CardFooter>
        </Card>
      )}
      <h2 className="font-heading text-xl font-medium">Came back for review</h2>
      <ReviewList />
      <ContinueLine />
    </>
  )
}

mount(
  {
    title: "I · Getting clearer",
    summary:
      "F, followed over time: every explanation you've written, and how each one improved with every rewrite. E's timeline, applied to your own thinking.",
    points: [
      "The single most motivating thing a learner can see is evidence they're improving. In School that evidence is the explanations: the grader's judgments on each criterion, attempt after attempt.",
      "Each attempt is one box with three pips (fidelity, completeness, accessibility): filled for Meets, half for Partly, hollow for Not yet. Read left to right, a row filling in is progress you can see, made only of words, never a score.",
      "The headline names the best story in the record in plain words: 'went from two not-yets to meeting every criterion, in three tries.'",
      "Click any box to read that attempt's notes. The newest is open on arrival, so F's 'read your feedback' still comes first.",
      "Explanations not written yet sit underneath as the next thing to do: writing is the strongest kind of practice, and this page makes it the habit.",
      "Needs: gradings joined to their submissions and lessons, all already in the record.",
      "Trade-off: it only shows explanations. Quizzes and reading are left to the timeline (H) or the course pages.",
    ],
    components:
      "Card, Badge, Button, Kbd, Item, Alert, mode toggle, and a d3 time scale for the attempts.",
  },
  <Page />
)
