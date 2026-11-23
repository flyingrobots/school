import * as React from "react"

import { hierarchy, linkHorizontal, path, select, type HierarchyNode } from "d3"
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react"
import {
  Tree,
  TreeItem,
  TreeItemIndicator,
  TreeItemLabel,
  type TreeItemData,
} from "@ui-sdk/react/tree"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

// A lesson's nest: boxes inside boxes, each with a label, its atoms, and optionally an edge, the
// relation that leads from it to its next sibling. ui-sdk's tree gives it roles, levels, focus and
// the keyboard; d3 lays it out and draws the links. On a narrow screen it is an indented list; once
// every level has room for a column it is a tree across the page.

export type NestNode = {
  label: string
  atoms: string[]
  edge?: string
  children: NestNode[]
}

type Node = {
  value: string
  node: NestNode
  next?: { value: string; label: string }
  children: Node[]
}

type Orientation = "vertical" | "horizontal"

// The width one level needs, in px, before the nest is drawn as a tree with a column per level.
const COLUMN = 224

const VIM: Record<string, string> = {
  h: "ArrowLeft",
  j: "ArrowDown",
  k: "ArrowUp",
  l: "ArrowRight",
}

function index(node: NestNode, value: string, next?: Node["next"]): Node {
  return {
    value,
    node,
    next,
    children: node.children.map((child, i) => {
      const after = node.children[i + 1]
      return index(
        child,
        `${value}.${i}`,
        after && { value: `${value}.${i + 1}`, label: after.label }
      )
    }),
  }
}

function asItem(n: Node): TreeItemData {
  return n.children.length
    ? { value: n.value, label: n.node.label, children: n.children.map(asItem) }
    : { value: n.value, label: n.node.label }
}

const branches = (n: Node): string[] =>
  n.children.length ? [n.value, ...n.children.flatMap(branches)] : []
const count = (n: Node): number =>
  n.children.reduce((sum, c) => sum + 1 + count(c), 0)

type Place = { gridColumn: string; gridRow: string; marginInlineStart?: string }

function place(
  visible: HierarchyNode<Node>,
  orientation: Orientation
): Map<string, Place> {
  const places = new Map<string, Place>()
  if (orientation === "vertical") {
    let row = 0
    visible.eachBefore((d) => {
      row += 1
      places.set(d.data.value, {
        gridColumn: "1",
        gridRow: String(row),
        marginInlineStart: d.depth ? `${d.depth * 1.5}rem` : undefined,
      })
    })
    return places
  }
  const leaves = visible.leaves()
  const at = new Map(leaves.map((leaf, i) => [leaf, i]))
  visible.eachBefore((d) => {
    const under = d.leaves()
    places.set(d.data.value, {
      gridColumn: String(d.depth + 1),
      gridRow: `${at.get(under[0]!)! + 1} / span ${under.length}`,
    })
  })
  return places
}

type Box = { x: number; y: number; w: number; h: number }

function draw(
  svg: SVGSVGElement,
  frame: HTMLElement,
  visible: HierarchyNode<Node>,
  orientation: Orientation
) {
  const origin = frame.getBoundingClientRect()
  const box = (value: string): Box | undefined => {
    const el = frame.querySelector(`[data-nest-value="${value}"]`)
    if (!el) return undefined
    const r = el.getBoundingClientRect()
    return {
      x: r.left - origin.left,
      y: r.top - origin.top,
      w: r.width,
      h: r.height,
    }
  }
  const horizontal = linkHorizontal<
    { source: [number, number]; target: [number, number] },
    [number, number]
  >()

  const links = visible.links().flatMap(({ source, target }) => {
    const s = box(source.data.value)
    const t = box(target.data.value)
    if (!s || !t) return []
    if (orientation === "horizontal")
      return [
        {
          key: target.data.value,
          d:
            horizontal({
              source: [s.x + s.w, s.y + s.h / 2],
              target: [t.x, t.y + t.h / 2],
            }) ?? "",
        },
      ]
    const x = s.x + 12
    const y = t.y + t.h / 2
    const p = path()
    p.moveTo(x, s.y + s.h)
    p.lineTo(x, Math.max(s.y + s.h, y - 8))
    p.quadraticCurveTo(x, y, x + 8, y)
    p.lineTo(t.x, y)
    return [{ key: target.data.value, d: p.toString() }]
  })

  const edges: { key: string; d: string }[] = []
  visible.each((d) => {
    const next = d.data.next
    if (d.data.node.edge === undefined || !next) return
    const s = box(d.data.value)
    const t = box(next.value)
    if (!s || !t) return
    const p = path()
    if (orientation === "horizontal") {
      const x = s.x + s.w / 2
      const y = t.y - 4
      p.moveTo(x, s.y + s.h + 4)
      p.lineTo(x, y)
      p.moveTo(x - 6, y - 6)
      p.lineTo(x, y)
      p.lineTo(x + 6, y - 6)
    } else {
      const sy = s.y + s.h / 2
      const ty = t.y + t.h / 2
      const out = Math.max(s.x + s.w, t.x + t.w) + 16
      p.moveTo(s.x + s.w + 4, sy)
      p.lineTo(out, sy)
      p.lineTo(out, ty)
      p.lineTo(t.x + t.w + 4, ty)
      p.moveTo(t.x + t.w + 10, ty - 6)
      p.lineTo(t.x + t.w + 4, ty)
      p.lineTo(t.x + t.w + 10, ty + 6)
    }
    edges.push({ key: d.data.value, d: p.toString() })
  })

  const layer = select(svg)
  layer
    .selectAll<SVGPathElement, { key: string; d: string }>(
      "path[data-nest=link]"
    )
    .data(links, (l) => l.key)
    .join("path")
    .attr("data-nest", "link")
    .attr("class", "fill-none stroke-muted-foreground stroke-2")
    .attr("d", (l) => l.d)
  layer
    .selectAll<SVGPathElement, { key: string; d: string }>(
      "path[data-nest=edge-arrow]"
    )
    .data(edges, (e) => e.key)
    .join("path")
    .attr("data-nest", "edge-arrow")
    .attr("class", "fill-none stroke-primary stroke-2")
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round")
    .attr("d", (e) => e.d)
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last)
        setSize({
          width: last.contentRect.width,
          height: last.contentRect.height,
        })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** A nest block's tree, drawn with d3 and explored with the keyboard. */
export function Nest({
  id,
  root,
  className,
}: {
  id: string
  root: NestNode
  className?: string
}) {
  const indexed = React.useMemo(() => index(root, "0"), [root])
  const items = React.useMemo(() => [asItem(indexed)], [indexed])
  const [expanded, setExpanded] = React.useState(() => branches(indexed))
  const frame = React.useRef<HTMLDivElement>(null)
  const svg = React.useRef<SVGSVGElement>(null)
  const keys = React.useRef<HTMLDivElement>(null)
  const size = useSize(frame)

  const open = React.useMemo(() => new Set(expanded), [expanded])
  const visible = React.useMemo(
    () =>
      hierarchy(indexed, (d) => (open.has(d.value) ? d.children : undefined)),
    [indexed, open]
  )
  const levels = visible.height + 1
  const orientation: Orientation =
    size.width >= levels * COLUMN ? "horizontal" : "vertical"
  const places = React.useMemo(
    () => place(visible, orientation),
    [visible, orientation]
  )
  const rows = React.useMemo(() => {
    const all: HierarchyNode<Node>[] = []
    visible.eachBefore((d) => all.push(d))
    return all
  }, [visible])

  React.useLayoutEffect(() => {
    if (svg.current && frame.current)
      draw(svg.current, frame.current, visible, orientation)
  }, [visible, orientation, size])

  // h j k l are the arrow keys. Caught before the tree sees them, or its typeahead would take them.
  React.useEffect(() => {
    const el = keys.current
    if (!el) return
    const onKeyDown = (event: KeyboardEvent) => {
      const arrow = VIM[event.key]
      if (
        !arrow ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !(event.target instanceof HTMLElement)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      event.target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: arrow,
          bubbles: true,
          cancelable: true,
        })
      )
    }
    el.addEventListener("keydown", onKeyDown, true)
    return () => el.removeEventListener("keydown", onKeyDown, true)
  }, [])

  return (
    <div
      data-nest="root"
      data-nest-id={id}
      data-orientation={orientation}
      className={cn("flex w-full min-w-0 flex-col gap-4", className)}
    >
      <div ref={keys} className="w-full min-w-0">
        <div ref={frame} className="relative w-full min-w-0">
          <svg
            ref={svg}
            data-nest="links"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 size-full overflow-visible"
          />
          <Tree
            aria-label={`Nest diagram: ${root.label}`}
            items={items}
            expanded={expanded}
            onExpandedChange={(next) => setExpanded(next)}
            className={cn(
              "relative grid w-full",
              orientation === "horizontal"
                ? "items-center gap-x-12 gap-y-8"
                : "grid-cols-1 gap-3 pe-8"
            )}
            style={
              orientation === "horizontal"
                ? { gridTemplateColumns: `repeat(${levels}, minmax(0, 1fr))` }
                : undefined
            }
          >
            {rows.map((d) => {
              const { node, next, value } = d.data
              const hidden =
                d.data.children.length && !open.has(value) ? count(d.data) : 0
              return (
                <TreeItem
                  key={value}
                  value={value}
                  style={places.get(value)}
                  className={cn(
                    "group/item min-w-0 rounded-xl outline-none",
                    orientation === "horizontal" ? "self-center" : "self-start"
                  )}
                >
                  <TreeItemLabel
                    render={(props) => (
                      <Card
                        {...props}
                        size="sm"
                        data-nest-value={value}
                        className={cn(
                          props.className,
                          "gap-2 border-2 border-primary px-3 ring-0 group-focus-visible/item:ring-3 group-focus-visible/item:ring-ring/50 data-selected:bg-accent data-selected:text-accent-foreground",
                          d.depth > 0 && "border-dashed"
                        )}
                      >
                        <div className="flex items-start gap-2">
                          {d.data.children.length > 0 && (
                            <TreeItemIndicator className="mt-1 shrink-0 text-muted-foreground transition-transform data-expanded:rotate-90">
                              <ChevronRightIcon
                                aria-hidden="true"
                                className="size-5"
                              />
                            </TreeItemIndicator>
                          )}
                          <span
                            data-nest="label"
                            className="min-w-0 text-lg leading-snug font-medium break-words"
                          >
                            {node.label}
                          </span>
                        </div>
                        {node.atoms.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {atomKeys(node.atoms).map(([key, atom]) => (
                              <Badge
                                key={key}
                                data-nest="atom"
                                variant="outline"
                                className="h-auto px-2.5 py-0.5 font-mono text-base whitespace-normal"
                              >
                                {atom}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {node.edge !== undefined && (
                          <p
                            data-nest="edge"
                            className="flex flex-wrap items-center gap-x-2 text-base text-muted-foreground"
                          >
                            <ArrowRightIcon
                              aria-hidden="true"
                              className="size-4 shrink-0 text-primary"
                            />
                            <span className="font-mono text-foreground">
                              {node.edge}
                            </span>
                            {next && <span>to {next.label}</span>}
                          </p>
                        )}
                        {hidden > 0 && (
                          <p className="text-base text-muted-foreground">
                            {hidden} inside
                          </p>
                        )}
                      </Card>
                    )}
                  />
                </TreeItem>
              )
            })}
          </Tree>
        </div>
      </div>
      <div
        data-nest="keys"
        className="flex flex-wrap items-center gap-x-6 gap-y-2 text-base text-muted-foreground"
      >
        <span className="flex items-center gap-2">
          <KbdGroup>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </KbdGroup>
          or
          <KbdGroup>
            <Kbd>k</Kbd>
            <Kbd>j</Kbd>
          </KbdGroup>
          move
        </span>
        <span className="flex items-center gap-2">
          <KbdGroup>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
          </KbdGroup>
          or
          <KbdGroup>
            <Kbd>h</Kbd>
            <Kbd>l</Kbd>
          </KbdGroup>
          close and open
        </span>
      </div>
    </div>
  )
}

function atomKeys(atoms: string[]): [string, string][] {
  const seen = new Map<string, number>()
  return atoms.map((atom) => {
    const n = (seen.get(atom) ?? 0) + 1
    seen.set(atom, n)
    return [`${atom}#${n}`, atom]
  })
}
