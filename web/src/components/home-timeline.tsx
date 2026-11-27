// The home page's timeline (flyingrobots/school#166): each course's study days behind today and the
// days questions come back ahead of it, from GET /api/activity. Every mark can be chosen. Each lane
// says in words how its course's quizzes are holding today (RFC 5 §4.8, flyingrobots/school#222).
import * as d3 from "d3"
import * as React from "react"

import { HoldingBadges } from "@/components/holding-badges"
import { daysBetween, type Activity } from "@/lib/home-api"
import { masteryWords } from "@/lib/holding"

type Lane = Activity["courses"][number]

/**
 * How a course's quizzes are holding today, in the words of RFC 5 Table 4.7, one phrase per state
 * that has any. A course with no study day and nothing coming back, and with no quiz answered or no
 * quizzes, is "Not started yet"; one with a study day and no quiz answered shows its counts.
 */
export function holdingWords(c: Lane): string[] {
  const fresh =
    c.studied.length === 0 &&
    c.due.length === 0 &&
    (c.quizzes === 0 || c.mastery.notStarted === c.quizzes)
  return fresh ? ["Not started yet"] : masteryWords(c.quizzes, c.mastery)
}

export type Mark =
  | { kind: "today" }
  | { kind: "studied"; course: string; title: string; day: string }
  | { kind: "due"; course: string; title: string; day: string; items: number }

export const markKey = (m: Mark) =>
  m.kind === "today" ? "today" : `${m.kind}:${m.course}:${m.day}`

/** Every mark, in time order with today among them, for stepping earlier and later. */
export function marksOf(a: Activity): Mark[] {
  const at = (m: Mark) => (m.kind === "today" ? 0 : daysBetween(a.today, m.day))
  return [
    { kind: "today" } as Mark,
    ...a.courses.flatMap((c) => [
      ...c.studied
        .filter((d) => d !== a.today)
        .map((day): Mark => ({
          kind: "studied",
          course: c.course,
          title: c.courseTitle,
          day,
        })),
      ...c.due.map((d): Mark => ({
        kind: "due",
        course: c.course,
        title: c.courseTitle,
        day: d.day,
        items: d.items,
      })),
    ]),
  ].sort(
    (x, y) =>
      at(x) - at(y) || (x.kind === "today" ? -1 : y.kind === "today" ? 1 : 0)
  )
}

// A lane is its heading (the course and its words, which wrap on a narrow screen and are measured),
// then room for the marks above and below its line.
const HEAD = 20
const ABOVE = 14
const BELOW = 24
const PAD = { top: 28, left: 8, right: 8, bottom: 8 }

/** "Tuesday 24 November", from a YYYY-MM-DD day. */
export function dayWords(day: string): string {
  const [y, m, d] = day.split("-").map(Number)
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(Date.UTC(y!, m! - 1, d!))
}

export function Timeline({
  activity: a,
  selected,
  onSelect,
}: {
  activity: Activity
  selected: string
  onSelect: (m: Mark) => void
}) {
  const box = React.useRef<HTMLDivElement>(null)
  const [W, setW] = React.useState(720)
  React.useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setW(Math.max(320, Math.round(el.clientWidth)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Each lane's heading is HTML (the registry's Badge, through HoldingBadges) in a foreignObject, measured as it wraps.
  const heads = React.useRef(new Map<string, HTMLDivElement>())
  const [headH, setHeadH] = React.useState<Record<string, number>>({})
  React.useLayoutEffect(() => {
    const measure = () =>
      setHeadH((was) => {
        const now: Record<string, number> = {}
        heads.current.forEach((el, course) => {
          now[course] = Math.max(HEAD, Math.ceil(el.scrollHeight))
        })
        const same =
          Object.keys(now).length === Object.keys(was).length &&
          Object.entries(now).every(([k, v]) => was[k] === v)
        return same ? was : now
      })
    measure()
    const ro = new ResizeObserver(measure)
    heads.current.forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [a, W])
  const tops: number[] = []
  let bottom = PAD.top
  for (const c of a.courses) {
    tops.push(bottom)
    bottom += (headH[c.course] ?? HEAD) + ABOVE + BELOW
  }
  const H = bottom + PAD.bottom
  const x = d3
    .scaleLinear()
    .domain([-a.days, a.days])
    .range([PAD.left, W - PAD.right])
  const offset = (day: string) => daysBetween(a.today, day)
  const ticks = d3
    .range(-a.days, a.days + 1)
    .filter((k) => k !== 0 && k % 7 === 0)
  const labelled = (k: number) => k !== a.days || W >= 560
  const pick = (m: Mark, label: string) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    "aria-pressed": selected === markKey(m),
    "data-mark": markKey(m),
    onClick: () => onSelect(m),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        onSelect(m)
      }
    },
    className:
      "cursor-pointer outline-none [&:focus-visible>.ring]:stroke-ring",
  })
  const ring = (key: string, cx: number, cy: number, r: number) => (
    <circle
      cx={cx}
      cy={cy}
      r={r + 5}
      className={
        selected === key
          ? "fill-none stroke-ring ring"
          : "fill-none stroke-transparent ring"
      }
      strokeWidth={2}
    />
  )
  return (
    <div ref={box} className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block max-w-full overflow-visible"
        aria-label={`Days you studied in the last ${a.days} days, and when questions come back in the next ${a.days}`}
      >
        <rect
          x={x(0)}
          y={PAD.top - 8}
          width={x(a.days) - x(0)}
          height={H - PAD.top}
          className="fill-muted"
          rx={6}
        />
        {ticks.map((k) => (
          <g key={k}>
            <line
              x1={x(k)}
              x2={x(k)}
              y1={PAD.top - 8}
              y2={H}
              className="stroke-border"
            />
            {labelled(k) && (
              <text
                x={k === a.days ? x(k) - 4 : x(k) + 4}
                y={14}
                textAnchor={k === a.days ? "end" : "start"}
                className="fill-muted-foreground text-xs"
              >
                {k < 0 ? `${-k / 7} wk ago` : `in ${k / 7} wk`}
              </text>
            )}
          </g>
        ))}
        <g {...pick({ kind: "today" }, "Today")}>
          <rect
            x={x(0) - 10}
            y={PAD.top - 26}
            width={40}
            height={H - PAD.top + 26}
            className="fill-transparent"
          />
          <rect
            x={x(0) - 8}
            y={PAD.top - 26}
            width={16}
            height={H - PAD.top + 26}
            rx={8}
            className={
              selected === "today"
                ? "fill-none stroke-ring ring"
                : "fill-none stroke-transparent ring"
            }
            strokeWidth={2}
          />
          <line
            x1={x(0)}
            x2={x(0)}
            y1={PAD.top - 12}
            y2={H}
            className="stroke-foreground"
            strokeWidth={2}
          />
          <text
            x={x(0) + 12}
            y={PAD.top - 14}
            className="fill-foreground text-xs font-semibold"
          >
            today
          </text>
        </g>
        {a.courses.map((c, i) => {
          const head = headH[c.course] ?? HEAD
          const y = tops[i]! + head + ABOVE
          return (
            <g key={c.course} data-lane={c.course}>
              <foreignObject
                x={PAD.left}
                y={tops[i]!}
                width={Math.max(0, W - PAD.left - PAD.right)}
                height={head}
              >
                <div
                  ref={(el) => {
                    if (el) heads.current.set(c.course, el)
                    else heads.current.delete(c.course)
                  }}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
                >
                  <span>{c.courseTitle}</span>
                  <HoldingBadges words={holdingWords(c)} />
                </div>
              </foreignObject>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeDasharray="2 4"
              />
              {c.studied.map((day) => {
                const m: Mark = {
                  kind: "studied",
                  course: c.course,
                  title: c.courseTitle,
                  day,
                }
                const cx = x(offset(day))
                const dot = (
                  <circle cx={cx} cy={y} r={6} className="fill-primary" />
                )
                return day === a.today ? (
                  <g key={day}>{dot}</g>
                ) : (
                  <g
                    key={day}
                    {...pick(m, `Studied ${c.courseTitle}, ${dayWords(day)}`)}
                  >
                    {ring(markKey(m), cx, y, 6)}
                    {dot}
                  </g>
                )
              })}
              {c.due.map((d) => {
                const m: Mark = {
                  kind: "due",
                  course: c.course,
                  title: c.courseTitle,
                  day: d.day,
                  items: d.items,
                }
                const cx = x(offset(d.day))
                const r = 5 + Math.min(d.items, 5) * 2
                return (
                  <g
                    key={d.day}
                    {...pick(
                      m,
                      `${d.items} ${d.items === 1 ? "question comes" : "questions come"} back in ${c.courseTitle}, ${dayWords(d.day)}`
                    )}
                  >
                    {ring(markKey(m), cx, y, r)}
                    <circle
                      cx={cx}
                      cy={y}
                      r={r}
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
    </div>
  )
}

export function TimelineLegend() {
  return (
    <span className="flex flex-wrap items-center gap-3">
      <span className="flex items-center gap-1.5">
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
          <circle cx={6} cy={6} r={5} className="fill-primary" />
        </svg>
        studied
      </span>
      <span className="flex items-center gap-1.5">
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
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
