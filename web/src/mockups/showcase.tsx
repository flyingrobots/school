// Small pictures computed from each lesson's own content, for the course showcase in mockup J.
// Rows come from place notation, so every picture is the real method, not an illustration of one.
import * as React from "react"
import * as d3 from "d3"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"

gsap.registerPlugin(useGSAP)

type Row = number[]

// "x" swaps every pair; a notation like "14" keeps those places and swaps the rest in pairs.
export function apply(row: Row, pn: string): Row {
  const stay = pn === "x" ? new Set<number>() : new Set([...pn].map(Number))
  const out = [...row]
  for (let p = 1; p < row.length; p++) {
    if (stay.has(p) || stay.has(p + 1)) continue
    ;[out[p - 1], out[p]] = [out[p], out[p - 1]]
    p++
  }
  return out
}

export function ring(start: Row, notation: string[]): Row[] {
  const rows = [start]
  for (const pn of notation) rows.push(apply(rows[rows.length - 1], pn))
  return rows
}

const ROUNDS = [1, 2, 3, 4]
export const PLAIN_HUNT = ring(ROUNDS, [
  "x",
  "14",
  "x",
  "14",
  "x",
  "14",
  "x",
  "14",
])
const LEAD = ["x", "14", "x", "14", "x", "14", "x"]
export const PLAIN_BOB = ring(ROUNDS, [
  ...[...LEAD, "12"],
  ...[...LEAD, "12"],
  ...[...LEAD, "12"],
])
const BOBBED = ring(ROUNDS, [...LEAD, "14"])

// The course's claims, checked when the page loads.
console.assert(PLAIN_HUNT.at(-1)!.join("") === "1234", "plain hunt returns")
console.assert(
  new Set(PLAIN_BOB.slice(0, 24).map((r) => r.join(""))).size === 24 &&
    PLAIN_BOB[24].join("") === "1234",
  "Plain Bob Minimus rings 24 rows once"
)
console.assert(PLAIN_BOB[8].join("") === "1342", "plain lead end")
console.assert(BOBBED[8].join("") === "1234", "a bobbed lead comes round")

const reduced = () =>
  typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches

/** One bell's path through the rows, drawn as ringers draw it: a line through its places. */
export function BlueLine({
  rows = PLAIN_HUNT,
  bells = [1, 2],
  big = false,
}: {
  rows?: Row[]
  bells?: number[]
  big?: boolean
}) {
  const ref = React.useRef<SVGSVGElement>(null)
  const cell = big ? 34 : 18
  const n = rows[0].length
  const W = cell * n
  const H = cell * rows.length
  const x = (place: number) => place * cell + cell / 2
  const y = (i: number) => i * cell + cell / 2
  const line = d3
    .line<[number, number]>()
    .x((d) => d[0])
    .y((d) => d[1])
  useGSAP(
    () => {
      if (!big || reduced()) return
      ref.current
        ?.querySelectorAll<SVGPathElement>("[data-path]")
        .forEach((p, i) => {
          const len = p.getTotalLength()
          gsap.fromTo(
            p,
            { strokeDasharray: len, strokeDashoffset: len },
            {
              strokeDashoffset: 0,
              duration: 2.4,
              delay: 0.3 + i * 0.5,
              ease: "power1.inOut",
            }
          )
        })
    },
    { scope: ref }
  )
  return (
    <svg
      ref={ref}
      viewBox={`-4 -4 ${W + 8} ${H + 8}`}
      className="h-full w-auto"
      role="img"
      aria-label={`The ${rows.length - 1} changes of the method, with the paths of bells ${bells.join(" and ")}`}
    >
      {bells.map((bell, k) => (
        <path
          key={bell}
          data-path
          d={line(rows.map((r, i) => [x(r.indexOf(bell)), y(i)]))!}
          className={
            k === 0 ? "fill-none stroke-chart-2" : "fill-none stroke-chart-1"
          }
          strokeWidth={big ? 4 : 2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.85}
        />
      ))}
      {rows.map((r, i) =>
        r.map((b, p) => (
          <text
            key={`${i}-${p}`}
            x={x(p)}
            y={y(i)}
            dy="0.35em"
            textAnchor="middle"
            className={
              bells.includes(b)
                ? "fill-foreground font-semibold"
                : "fill-muted-foreground"
            }
            style={{ fontSize: cell * 0.5, paintOrder: "stroke" }}
            stroke="var(--background)"
            strokeWidth={big ? 6 : 4}
          >
            {b}
          </text>
        ))
      )}
    </svg>
  )
}

/** Lesson 1: between rows a bell moves at most one place, so only neighbours swap. */
export function NeighboursSwap() {
  const a = [1, 2, 3, 4]
  const b = apply(a, "x")
  const cell = 40
  return (
    <svg
      viewBox="0 0 170 120"
      className="h-full w-auto"
      role="img"
      aria-label="1234 becomes 2143: each bell moves one place"
    >
      {a.map((bell, p) => {
        const q = b.indexOf(bell)
        return (
          <g key={bell}>
            <line
              x1={p * cell + 25}
              y1={30}
              x2={q * cell + 25}
              y2={92}
              className="stroke-chart-2"
              strokeWidth={2.5}
            />
            <circle
              cx={p * cell + 25}
              cy={22}
              r={13}
              className="fill-primary"
            />
            <text
              x={p * cell + 25}
              y={22}
              dy="0.35em"
              textAnchor="middle"
              className="fill-primary-foreground text-[13px] font-semibold"
            >
              {bell}
            </text>
            <circle
              cx={q * cell + 25}
              cy={100}
              r={13}
              className="fill-background stroke-primary"
              strokeWidth={2}
            />
            <text
              x={q * cell + 25}
              y={100}
              dy="0.35em"
              textAnchor="middle"
              className="fill-foreground text-[13px] font-semibold"
            >
              {bell}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** Lesson 2: a short line of notation rebuilds every row. */
export function Notation() {
  const pns = ["x", "14", "x", "14"]
  const rows = ring(ROUNDS, pns)
  return (
    <svg
      viewBox="0 0 170 130"
      className="h-full w-auto"
      role="img"
      aria-label="Place notation x 14 x 14 applied to rounds"
    >
      {rows.map((r, i) => (
        <g key={i}>
          <text
            x={70}
            y={14 + i * 25}
            className="fill-foreground font-mono text-[15px] tracking-[0.3em]"
          >
            {r.join("")}
          </text>
          {i < pns.length && (
            <text
              x={10}
              y={27 + i * 25}
              className="fill-chart-2 font-mono text-[13px] font-semibold"
            >
              {pns[i]}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

/** Lesson 4: n! rows, from the lesson's own numbers. */
export function Extents() {
  const data = [4, 5, 6, 7, 8].map((n) => ({
    n,
    rows: d3.range(1, n + 1).reduce((a, b) => a * b, 1),
  }))
  const x = d3.scaleLog().domain([10, 50000]).range([0, 105])
  const note: Record<number, string> = { 7: "a peal, ~3 h", 8: "~18 hours" }
  return (
    <svg
      viewBox="0 0 300 130"
      className="h-full w-auto"
      role="img"
      aria-label="Rows in the extent on 4 to 8 bells"
    >
      {data.map((d, i) => (
        <g key={d.n} transform={`translate(0 ${8 + i * 24})`}>
          <text x={0} y={11} className="fill-muted-foreground text-[11px]">
            {d.n} bells
          </text>
          <rect
            x={46}
            y={0}
            width={x(d.rows)}
            height={15}
            rx={3}
            className={d.n === 7 ? "fill-chart-2" : "fill-primary"}
          />
          <text
            x={52 + x(d.rows)}
            y={11}
            className="fill-foreground text-[11px] font-medium"
          >
            {d3.format(",")(d.rows)}
            {note[d.n] && (
              <tspan className="fill-muted-foreground font-normal">
                {" "}
                · {note[d.n]}
              </tspan>
            )}
          </text>
        </g>
      ))}
    </svg>
  )
}

/** Lesson 5: Plain Bob Minimus, all 24 rows, in three leads. */
export function BobGrid() {
  const leads = [0, 1, 2].map((l) => PLAIN_BOB.slice(l * 8, l * 8 + 9))
  return (
    <div className="flex h-full items-stretch gap-2">
      {leads.map((rows, l) => (
        <BlueLine key={l} rows={rows} bells={[1]} />
      ))}
    </div>
  )
}

/** Lesson 6: at the lead end, a call sends the band down a different path: here, straight back to rounds. */
export function Call() {
  return (
    <svg
      viewBox="0 0 220 120"
      className="h-full w-auto"
      role="img"
      aria-label="A plain lead ends 1342; a bob brings the bells back to rounds, 1234"
    >
      <text
        x={10}
        y={64}
        className="fill-foreground font-mono text-[15px] tracking-[0.2em]"
      >
        {PLAIN_BOB[7].join("")}
      </text>
      <path
        d="M 72 59 C 110 59, 110 26, 140 26"
        className="fill-none stroke-muted-foreground"
        strokeWidth={2}
      />
      <path
        d="M 72 59 C 110 59, 110 94, 140 94"
        className="fill-none stroke-chart-2"
        strokeWidth={2.5}
      />
      <text
        x={146}
        y={31}
        className="fill-muted-foreground font-mono text-[15px] tracking-[0.2em]"
      >
        {PLAIN_BOB[8].join("")}
      </text>
      <text
        x={146}
        y={99}
        className="fill-chart-2 font-mono text-[15px] font-semibold tracking-[0.2em]"
      >
        {BOBBED[8].join("")}
      </text>
      <text x={96} y={20} className="fill-muted-foreground text-[11px]">
        plain
      </text>
      <text x={80} y={116} className="fill-chart-2 text-[11px] font-semibold">
        “Bob!” rounds
      </text>
    </svg>
  )
}

/** Lesson 7: the ringers' books, and the mathematics that named what they did. */
export function Centuries() {
  const x = d3.scaleLinear().domain([1650, 1870]).range([10, 210])
  const marks = [
    { year: 1668, label: "Tintinnalogia", ringers: true },
    { year: 1677, label: "Campanalogia", ringers: true },
    { year: 1832, label: "Galois", ringers: false },
    { year: 1854, label: "Cayley", ringers: false },
  ]
  return (
    <svg
      viewBox="0 0 220 110"
      className="h-full w-auto"
      role="img"
      aria-label="Stedman's books in 1668 and 1677; group theory named in the 1800s"
    >
      <line
        x1={10}
        x2={210}
        y1={60}
        y2={60}
        className="stroke-border"
        strokeWidth={2}
      />
      <rect
        x={x(1677)}
        y={56}
        width={x(1832) - x(1677)}
        height={8}
        rx={4}
        className="fill-muted"
      />
      <text
        x={(x(1677) + x(1832)) / 2}
        y={80}
        textAnchor="middle"
        className="fill-muted-foreground text-[11px]"
      >
        two centuries
      </text>
      {marks.map((m, i) => (
        <g key={m.label}>
          <circle
            cx={x(m.year)}
            cy={60}
            r={5}
            className={m.ringers ? "fill-chart-2" : "fill-primary"}
          />
          <text
            x={x(m.year)}
            y={i % 2 ? 100 : 40}
            textAnchor="middle"
            className="fill-foreground text-[10px]"
          >
            {m.label}
          </text>
          <text
            x={x(m.year)}
            y={i % 2 ? 88 : 28}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            {m.year}
          </text>
        </g>
      ))}
    </svg>
  )
}

/** AIΩN lesson 2: a graph whose nodes can carry graphs. */
export function NestedGraph() {
  const outer = [
    { x: 40, y: 40 },
    { x: 110, y: 25 },
    { x: 165, y: 75 },
    { x: 60, y: 100 },
  ]
  const inner = [
    { x: -14, y: -8 },
    { x: 12, y: -12 },
    { x: 4, y: 12 },
  ]
  const big = outer[2]
  return (
    <svg
      viewBox="0 0 220 130"
      className="h-full w-auto"
      role="img"
      aria-label="A graph in which one node holds a smaller graph"
    >
      {[
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [0, 2],
      ].map(([a, b]) => (
        <line
          key={`${a}${b}`}
          x1={outer[a].x}
          y1={outer[a].y}
          x2={outer[b].x}
          y2={outer[b].y}
          className="stroke-muted-foreground"
          strokeWidth={1.5}
        />
      ))}
      {outer.map((p, i) =>
        i === 2 ? null : (
          <circle key={i} cx={p.x} cy={p.y} r={8} className="fill-primary" />
        )
      )}
      <circle
        cx={big.x}
        cy={big.y}
        r={30}
        className="fill-background stroke-chart-2"
        strokeWidth={2}
      />
      {[
        [0, 1],
        [1, 2],
        [2, 0],
      ].map(([a, b]) => (
        <line
          key={`i${a}${b}`}
          x1={big.x + inner[a].x}
          y1={big.y + inner[a].y}
          x2={big.x + inner[b].x}
          y2={big.y + inner[b].y}
          className="stroke-chart-2"
          strokeWidth={1.5}
        />
      ))}
      {inner.map((p, i) => (
        <circle
          key={i}
          cx={big.x + p.x}
          cy={big.y + p.y}
          r={5}
          className="fill-chart-2"
        />
      ))}
    </svg>
  )
}
