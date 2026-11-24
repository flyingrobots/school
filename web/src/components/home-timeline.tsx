// The home page's timeline (flyingrobots/school#166): each course's study days behind today and the
// days questions come back ahead of it, from GET /api/activity. Every mark can be chosen.
import * as d3 from "d3"

import { daysBetween, type Activity } from "@/lib/home-api"

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

const W = 720
const LANE = 56
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
  const H = PAD.top + LANE * a.courses.length + PAD.bottom
  const x = d3
    .scaleLinear()
    .domain([-a.days, a.days])
    .range([PAD.left, W - PAD.right])
  const offset = (day: string) => daysBetween(a.today, day)
  const ticks = d3
    .range(-a.days, a.days + 1)
    .filter((k) => k !== 0 && k % 7 === 0)
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
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full overflow-visible"
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
          <text
            x={x(k) + 4}
            y={12}
            className="fill-muted-foreground text-[11px]"
          >
            {k < 0 ? `${-k / 7} wk ago` : `in ${k / 7} wk`}
          </text>
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
          x={x(0) + 4}
          y={PAD.top - 14}
          className="fill-foreground text-[11px] font-semibold"
        >
          today
        </text>
      </g>
      {a.courses.map((c, i) => {
        const y = PAD.top + LANE * i + LANE / 2 + 4
        const fresh = c.studied.length === 0 && c.due.length === 0
        return (
          <g key={c.course} data-lane={c.course}>
            <text
              x={PAD.left}
              y={y - 18}
              className="fill-muted-foreground text-[12px]"
            >
              {c.courseTitle}
              {fresh && <tspan className="italic"> · not started yet</tspan>}
            </text>
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
