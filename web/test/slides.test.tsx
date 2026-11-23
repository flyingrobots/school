// The registry slides block (@flyingrobots/slides, flyingrobots/school#43): one slide at a time,
// moved by the keys and by Previous and Next, its position in words, and Esc to leave.
// Oracle: the issue's acceptance (arrows and hjkl move between slides) and WEB_STYLE's keys: every
// key has its Kbd hint, and the slides' keys never act while focus is elsewhere on the page.
import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

// happy-dom stands in for the browser for this file only, then gives the globals back.
GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { Slides, slidePosition } = await import("@/components/slides")

const deck = ["one", "two", "three", "four"].map((id) => ({ id, label: `Slide ${id}`, content: <p data-animate="">{`Content ${id}`}</p> }))

let unmount: (() => void) | undefined
afterEach(() => {
  act(() => unmount?.())
  unmount = undefined
  document.body.innerHTML = ""
})

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(node))
  unmount = () => root.unmount()
  return host
}

const part = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`[data-slides="${name}"]`)
const shown = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-slides=slide]")].map((s) => s.dataset.slideId)
const position = (host: HTMLElement) => part(host, "position")!.textContent
const press = (key: string) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })))
const click = (el: HTMLElement) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })))

test("one slide at a time: only the current slide is in the document, with its position in words", () => {
  const host = render(<Slides title="Orbits" slides={deck} />)
  expect(host.querySelector("h1")!.textContent).toBe("Orbits")
  expect(shown(host)).toEqual(["one"])
  expect(position(host)).toBe("Slide 1 of 4")
  expect(part(host, "slide")!.getAttribute("aria-roledescription")).toBe("slide")
  expect(part(host, "slide")!.getAttribute("aria-label")).toBe("Slide 1 of 4: Slide one")
  expect(slidePosition(2, 12)).toBe("Slide 3 of 12")
})

test("the slides take focus when they open, so their keys work at once", () => {
  const host = render(<Slides title="Orbits" slides={deck} />)
  expect(document.activeElement).toBe(part(host, "root"))
})

test.each([
  ["→", "ArrowRight", "ArrowLeft"],
  ["l and h", "l", "h"],
  ["↓ and ↑", "ArrowDown", "ArrowUp"],
  ["j and k", "j", "k"],
  ["PageDown and PageUp", "PageDown", "PageUp"],
])("%s move on and back one slide, and stop at the ends", (_, on, back) => {
  const host = render(<Slides title="Orbits" slides={deck} />)
  press(back)
  expect(shown(host)).toEqual(["one"]) // nothing before the first
  press(on)
  expect(shown(host)).toEqual(["two"])
  expect(position(host)).toBe("Slide 2 of 4")
  press(on)
  press(on)
  press(on) // nothing after the last
  expect(shown(host)).toEqual(["four"])
  expect(position(host)).toBe("Slide 4 of 4")
  press(back)
  expect(shown(host)).toEqual(["three"])
})

test("Home and End go to the first and last slides", () => {
  const host = render(<Slides title="Orbits" slides={deck} />)
  press("End")
  expect(shown(host)).toEqual(["four"])
  press("Home")
  expect(shown(host)).toEqual(["one"])
})

test("Previous and Next move too, and each is disabled, still focusable, at its end", () => {
  const changes: number[] = []
  const host = render(<Slides title="Orbits" slides={deck} onIndexChange={(i) => changes.push(i)} />)
  const prev = part(host, "previous")!
  const next = part(host, "next")!
  expect(prev.getAttribute("aria-disabled")).toBe("true")
  click(next)
  expect(shown(host)).toEqual(["two"])
  click(prev)
  expect(shown(host)).toEqual(["one"])
  press("End")
  expect(next.getAttribute("aria-disabled")).toBe("true")
  click(next)
  expect(shown(host)).toEqual(["four"])
  expect(changes).toEqual([1, 0, 3])
})

test("Esc leaves through exit, and the way out is on screen with its key", () => {
  let left = 0
  const host = render(<Slides title="Orbits" slides={deck} exit={{ label: "Web view", onExit: () => left++ }} />)
  press("Escape")
  expect(left).toBe(1)
  const exit = part(host, "exit")!
  expect(exit.textContent).toBe("Web viewEsc")
  expect(exit.getAttribute("aria-keyshortcuts")).toBe("Escape")
  click(exit)
  expect(left).toBe(2)
})

test("without exit there is no way out on screen and Esc does nothing", () => {
  const host = render(<Slides title="Orbits" slides={deck} />)
  press("Escape")
  expect(part(host, "exit")).toBeNull()
  expect(shown(host)).toEqual(["one"])
})

test("every key has its Kbd hint on screen", () => {
  const host = render(<Slides title="Orbits" slides={deck} exit={{ label: "Web view", onExit: () => {} }} />)
  const hints = [...part(host, "keys")!.querySelectorAll("[data-slot=kbd]")].map((k) => k.textContent)
  expect(hints).toEqual(["←", "↑", "h", "k", "PgUp", "→", "↓", "l", "j", "PgDn", "Home", "End", "Esc"])
  expect(part(host, "previous")!.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft h ArrowUp k PageUp")
  expect(part(host, "next")!.getAttribute("aria-keyshortcuts")).toBe("ArrowRight l ArrowDown j PageDown")
})

test("the progress bar names the position in words", () => {
  const host = render(<Slides title="Orbits" slides={deck} />)
  press("l")
  const bar = host.querySelector("[data-slot=progress]")!
  expect(bar.getAttribute("aria-valuetext")).toBe("Slide 2 of 4")
  expect(bar.getAttribute("aria-valuenow")).toBe("50")
})

test("the keys do nothing while focus is elsewhere on the page, such as a sidebar beside the slides", () => {
  const host = render(
    <>
      <button type="button" data-testid="beside">
        Beside
      </button>
      <Slides title="Orbits" slides={deck} exit={{ label: "Web view", onExit: () => { throw new Error("left") } }} />
    </>
  )
  act(() => host.querySelector<HTMLButtonElement>("[data-testid=beside]")!.focus())
  for (const key of ["ArrowRight", "l", "j", "PageDown", "End", "Escape"]) press(key)
  expect(shown(host)).toEqual(["one"])
})

test("the block imports only React, GSAP, ui-sdk entries, lucide icons and stock shadcn components", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const components = join(import.meta.dir, "..", "src", "components")
  const stock = new Set(readdirSync(join(components, "ui")).map((f) => f.replace(/\.tsx$/, "")))
  const imports = [...readFileSync(join(components, "slides.tsx"), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]!)
  expect(imports.length).toBeGreaterThan(1) // zero witnesses would mean the harvest read nothing
  const allowed = ["react", "gsap", "@gsap/react", "@ui-sdk/react/button", "@ui-sdk/react/shortcuts", "lucide-react"]
  expect(imports.filter((spec) => !allowed.includes(spec) && !(spec.startsWith("@/components/ui/") && stock.has(spec.slice(16))))).toEqual([])
})
