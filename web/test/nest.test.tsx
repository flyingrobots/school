// The registry nest block (@flyingrobots/nest, flyingrobots/school#38): a lesson's nest tree drawn
// with d3, explored by keyboard through ui-sdk's tree.
// Oracles: the nest block's data (`server/core/model.ts` NestNode) is what must appear, every label
// and every atom; the WAI-ARIA tree view pattern (treeitem, aria-level, aria-expanded, one tab stop)
// is what the keyboard must reach; stock shadcn's token names (test/fixtures/stock-index.css) are
// the only colours allowed.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { Nest } = await import("@/components/nest")
type NestNode = import("@/components/nest").NestNode

// Paper I's worked example, as the WARP lesson drew it, with f's syntax tree one level deeper.
const root: NestNode = {
  label: "skeleton: call graph",
  atoms: [],
  children: [
    {
      label: "dot f → syntax tree",
      atoms: ['"return"'],
      edge: "call",
      children: [{ label: "return value", atoms: ["x"], children: [] }],
    },
    { label: "dot g → syntax tree", atoms: ['"+"', "1"], children: [] },
    { label: "arrow f→g → provenance graph", atoms: ['"inlined"', "pass 3"], children: [] },
  ],
}
const labels = ["skeleton: call graph", "dot f → syntax tree", "return value", "dot g → syntax tree", "arrow f→g → provenance graph"]
const atoms = ['"return"', "x", '"+"', "1", '"inlined"', "pass 3"]

// A ResizeObserver the test drives, so the block sees the container width a phone or a wide screen gives it.
type Observed = { callback: ResizeObserverCallback; targets: Element[] }
let observers: Observed[] = []
class FakeResizeObserver {
  private o: Observed
  constructor(callback: ResizeObserverCallback) {
    this.o = { callback, targets: [] }
    observers.push(this.o)
  }
  observe(target: Element) {
    this.o.targets.push(target)
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((o) => o !== this.o)
  }
}
const realResizeObserver = globalThis.ResizeObserver
beforeEach(() => {
  observers = []
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
})

let unmount: (() => void) | undefined
afterEach(() => {
  act(() => unmount?.())
  unmount = undefined
  document.body.innerHTML = ""
  globalThis.ResizeObserver = realResizeObserver
})

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const r = createRoot(host)
  act(() => r.render(node))
  unmount = () => r.unmount()
  return host
}

function resize(width: number) {
  act(() => {
    for (const o of [...observers])
      o.callback(o.targets.map((target) => ({ target, contentRect: { width, height: 600 } }) as unknown as ResizeObserverEntry), {} as ResizeObserver)
  })
}

const tree = (host: HTMLElement) => host.querySelector<HTMLElement>("[role=tree]")!
const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[role=treeitem]")]
const nameOf = (item: HTMLElement) => item.querySelector("[data-nest=label]")?.textContent
const atomsOf = (item: HTMLElement) => [...item.querySelectorAll("[data-nest=atom]")].map((a) => a.textContent)
const focused = () => nameOf(document.activeElement as HTMLElement)
const press = async (key: string) => {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
}

test("a three-level nest renders every label and every atom, each atom inside its own node", () => {
  const host = render(<Nest id="warp" root={root} />)
  expect(items(host).map(nameOf)).toEqual(labels)
  expect(items(host).map(atomsOf)).toEqual([[], ['"return"'], ["x"], ['"+"', "1"], ['"inlined"', "pass 3"]])
  expect(items(host).flatMap(atomsOf)).toEqual(atoms)
  expect(host.querySelector("[data-nest=root]")?.getAttribute("data-nest-id")).toBe("warp")
})

test("an edge names its relation and the sibling it leads to", () => {
  const host = render(<Nest id="warp" root={root} />)
  const f = items(host)[1]!
  const edge = f.querySelector("[data-nest=edge]")!
  expect(edge.textContent).toContain("call")
  expect(edge.textContent).toContain("dot g → syntax tree")
  expect(items(host).filter((i) => i.querySelector("[data-nest=edge]"))).toHaveLength(1)
})

test("the tree is ui-sdk's: named, every node a treeitem with its level, branches expanded, one tab stop", () => {
  const host = render(<Nest id="warp" root={root} />)
  expect(tree(host).dataset.slot).toBe("tree")
  expect(tree(host).getAttribute("aria-label")).toBe("Nest diagram: skeleton: call graph")
  expect(items(host).map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "3", "2", "2"])
  expect(items(host).map((i) => i.getAttribute("aria-expanded"))).toEqual(["true", "true", null, null, null])
  expect(items(host).filter((i) => i.tabIndex === 0)).toHaveLength(1)
})

test("Down and Up, and j and k, reach every node in reading order", async () => {
  const host = render(<Nest id="warp" root={root} />)
  act(() => items(host)[0]!.focus())
  const seen = [focused()]
  for (let i = 1; i < labels.length; i++) {
    await press(i % 2 ? "ArrowDown" : "j")
    seen.push(focused())
  }
  expect(seen).toEqual(labels)
  await press("k")
  expect(focused()).toBe(labels[3])
  await press("ArrowUp")
  expect(focused()).toBe(labels[2])
})

test("Left and h close a branch or go to its parent; Right and l open it or enter it", async () => {
  const host = render(<Nest id="warp" root={root} />)
  act(() => items(host)[2]!.focus())
  await press("h")
  expect(focused()).toBe("dot f → syntax tree")
  await press("ArrowLeft")
  expect(items(host).map(nameOf)).toEqual(labels.filter((l) => l !== "return value"))
  expect(items(host)[1]!.getAttribute("aria-expanded")).toBe("false")
  await press("l")
  expect(items(host).map(nameOf)).toEqual(labels)
  await press("ArrowRight")
  expect(focused()).toBe("return value")
})

test("the keys are hinted with Kbd", () => {
  const host = render(<Nest id="warp" root={root} />)
  const hints = [...host.querySelectorAll("[data-nest=keys] [data-slot=kbd]")].map((k) => k.textContent)
  for (const key of ["j", "k", "h", "l"]) expect(hints).toContain(key)
})

test("at 360 px the nest is an indented list; at 1920 px it is a tree that spreads across the width", () => {
  const host = render(<Nest id="warp" root={root} />)
  const nest = () => host.querySelector<HTMLElement>("[data-nest=root]")!
  const place = () => items(host).map((i) => [i.style.gridColumn, i.style.gridRow])

  resize(360)
  expect(nest().dataset.orientation).toBe("vertical")
  expect(place()).toEqual([["1", "1"], ["1", "2"], ["1", "3"], ["1", "4"], ["1", "5"]])
  const indents = items(host).map((i) => parseFloat(i.style.marginInlineStart || "0"))
  expect(indents[0]).toBe(0)
  expect(indents[1]).toBeGreaterThan(indents[0]!)
  expect(indents[2]).toBeGreaterThan(indents[1]!)
  expect(indents[3]).toBe(indents[1]!)

  resize(1920)
  expect(nest().dataset.orientation).toBe("horizontal")
  // A column per level; each node spans the rows of the leaves under it.
  expect(place()).toEqual([["1", "1 / span 3"], ["2", "1 / span 1"], ["3", "1 / span 1"], ["2", "2 / span 1"], ["2", "3 / span 1"]])
  expect(items(host).every((i) => !i.style.marginInlineStart)).toBe(true)

  resize(360)
  expect(nest().dataset.orientation).toBe("vertical")
})

test("d3 draws a link from every parent to each child, and the edge's arrow, in token colours", () => {
  const host = render(<Nest id="warp" root={root} />)
  for (const width of [360, 1920]) {
    resize(width)
    const svg = host.querySelector<SVGSVGElement>("[data-nest=links]")!
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    expect(svg.querySelectorAll("[data-nest=link]")).toHaveLength(4)
    expect(svg.querySelectorAll("[data-nest=edge-arrow]")).toHaveLength(1)
    for (const mark of svg.querySelectorAll("path")) {
      expect(mark.getAttribute("d")).toBeTruthy()
      expect(mark.getAttribute("class")).toMatch(/\bstroke-(muted-foreground|primary)\b/)
      for (const attr of ["stroke", "fill", "color", "style"]) expect([null, "none"]).toContain(mark.getAttribute(attr))
    }
  }
})

test("a collapsed branch drops its children's links", async () => {
  const host = render(<Nest id="warp" root={root} />)
  resize(1920)
  act(() => items(host)[1]!.focus())
  await press("ArrowLeft")
  expect(host.querySelectorAll("[data-nest=link]")).toHaveLength(3)
})

// Colours: the component may name only stock shadcn tokens, through Tailwind utilities.
const source = readFileSync(join(import.meta.dir, "..", "src", "components", "nest.tsx"), "utf8")
const stock = readFileSync(join(import.meta.dir, "fixtures", "stock-index.css"), "utf8")
const tokens = new Set([...stock.matchAll(/--color-([\w-]+)\s*:/g)].map((m) => m[1]!))

test("the component's source holds no literal colour", () => {
  expect(tokens.has("primary") && tokens.has("muted-foreground")).toBe(true)
  const literals = source.match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(|\b(white|black|red|blue|green|gray|grey)\b(?!-)/gi) ?? []
  expect(literals).toEqual([])
  // d3 never sets a colour attribute or style; classes carry them.
  expect(source.match(/\.(attr|style)\(\s*["'](fill|stroke|color|background|stop-color)["']\s*,\s*["'](?!none)/g) ?? []).toEqual([])
})

test("every colour utility the component uses names a stock shadcn token", () => {
  // SVG attribute names such as stroke-linecap are not utilities.
  const classes = source.replace(/\.attr\(\s*"[^"]+"/g, "")
  const utilities = [...classes.matchAll(/(?<![\w-])(?:[\w-]+:)*(bg|text|border|stroke|fill|ring|outline|decoration|divide|from|to|via|shadow|accent|caret)-([a-z][\w-]*)(?:\/\d+)?(?![\w-])/g)]
  const nonColour = /^(xs|sm|base|lg|xl|\dxl|left|right|center|start|end|none|dashed|solid|dotted|\d+|x|y|t|b|l|r|s|e|wrap|nowrap|balance|pretty|ellipsis|clip|inherit|current|transparent|offset-\d+|inset)$/
  const colours = utilities.map((m) => m[2]!).filter((v) => !nonColour.test(v))
  expect(colours.length).toBeGreaterThan(0) // zero witnesses would mean the harvest read nothing
  expect(colours.filter((v) => !tokens.has(v))).toEqual([])
})

test("legible type: labels, atoms and edges are at least base size", () => {
  expect(source).not.toMatch(/\btext-(xs|sm)\b/)
  const host = render(<Nest id="warp" root={root} />)
  for (const el of host.querySelectorAll("[data-nest=label], [data-nest=atom], [data-nest=edge]"))
    expect(el.className).toMatch(/\btext-(base|lg|xl|2xl)\b/)
})
