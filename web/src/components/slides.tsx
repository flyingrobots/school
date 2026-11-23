import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { Button as ButtonBehavior } from "@ui-sdk/react/button"
import { useShortcut } from "@ui-sdk/react/shortcuts"
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Progress } from "@/components/ui/progress"

// A presentation: one slide at a time, full width, with the caller's content in each. It moves
// with the keys (←, h, ↑, k or PageUp back; →, l, ↓, j or PageDown on; Home and End to the ends),
// with Previous and Next, and says where it is in words ("Slide 3 of 12") and with a Progress bar.
// Esc leaves through `exit`, when there is one. Every key has its Kbd hint on screen.
//
// Only the current slide is in the document. A GSAP timeline brings each slide in from the side it
// came from, then the elements marked `data-animate` inside it, in order; with reduced motion
// nothing moves. It fades opacity, never visibility, so the slide can take focus while it comes in.
//
// The keys act while focus is in the slides, or on nothing at all (the page itself), so a sidebar
// or menu beside them keeps its own keys. Behaviour (buttons, shortcuts) is ui-sdk's; the look is
// stock shadcn parts.

gsap.registerPlugin(useGSAP)

export type Slide = {
  id: string
  /** What the slide is, for screen readers: "Slide 2 of 5: {label}". */
  label: string
  content: React.ReactNode
}

/** Whether focus is inside `root`, or on nothing at all (the page itself). */
function focusIn(root: HTMLElement | null) {
  const active = document.activeElement
  return active === null || active === document.body || (root?.contains(active) ?? false)
}

/** Where a slides view stands: "Slide 3 of 12". */
export const slidePosition = (index: number, total: number) => `Slide ${index + 1} of ${total}`

export function Slides({
  title,
  slides,
  defaultIndex = 0,
  onIndexChange,
  exit,
  header,
}: {
  /** The presentation's name; its heading, and the region's name. */
  title: string
  slides: Slide[]
  defaultIndex?: number
  onIndexChange?: (index: number) => void
  /** The way out, on screen and on Esc: a button labelled `label` that calls `onExit`. */
  exit?: { label: string; onExit: () => void }
  /** Shown above the title, such as a breadcrumb. */
  header?: React.ReactNode
}) {
  const total = slides.length
  const last = Math.max(total - 1, 0)
  const [at, setAt] = React.useState(() => Math.min(Math.max(defaultIndex, 0), last))
  const from = React.useRef(0)
  const root = React.useRef<HTMLDivElement>(null)
  const index = Math.min(at, last)
  const slide = slides[index]

  const go = (to: number) => {
    const next = Math.min(Math.max(to, 0), last)
    if (next === index) return
    from.current = Math.sign(next - index)
    setAt(next)
    onIndexChange?.(next)
  }

  // The keys are the slides' while focus is in them or on nothing, never while it is elsewhere.
  const here = () => focusIn(root.current)
  const nav = { when: here, repeat: true }
  const back = () => go(index - 1)
  const on = () => go(index + 1)
  useShortcut("arrowleft", back, { ...nav, description: "Previous slide" })
  useShortcut("h", back, { ...nav, description: "Previous slide" })
  useShortcut("arrowup", back, { ...nav, description: "Previous slide" })
  useShortcut("k", back, { ...nav, description: "Previous slide" })
  useShortcut("pageup", back, { ...nav, description: "Previous slide" })
  useShortcut("arrowright", on, { ...nav, description: "Next slide" })
  useShortcut("l", on, { ...nav, description: "Next slide" })
  useShortcut("arrowdown", on, { ...nav, description: "Next slide" })
  useShortcut("j", on, { ...nav, description: "Next slide" })
  useShortcut("pagedown", on, { ...nav, description: "Next slide" })
  useShortcut("home", () => go(0), { when: here, description: "First slide" })
  useShortcut("end", () => go(last), { when: here, description: "Last slide" })
  useShortcut(exit ? "escape" : null, () => exit?.onExit(), { when: here, description: exit?.label })

  // The slides take focus when they open, so their keys work at once.
  React.useEffect(() => {
    if (focusIn(root.current)) root.current?.focus({ preventScroll: true })
  }, [])

  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power2.out" } })
          .from("[data-slides=slide]", { x: 48 * from.current, opacity: 0, duration: 0.35 })
          .from("[data-slides=slide] [data-animate]", { y: 16, opacity: 0, duration: 0.3, stagger: 0.05 }, "-=0.2")
      })
    },
    { scope: root, dependencies: [index], revertOnUpdate: true }
  )

  const position = total === 0 ? "No slides" : slidePosition(index, total)
  return (
    <div
      ref={root}
      tabIndex={-1}
      role="region"
      aria-roledescription="slides"
      aria-label={title}
      data-slides="root"
      data-index={index}
      className="flex min-h-[calc(100svh-8rem)] w-full flex-col gap-8 outline-none"
    >
      <div data-slides="bar" className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-3">
          {header}
          <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl 2xl:text-6xl">{title}</h1>
        </div>
        {exit && (
          <ButtonBehavior data-slides="exit" render={<Button variant="outline" size="lg" />} aria-keyshortcuts="Escape" onClick={exit.onExit}>
            {exit.label}
            <Kbd data-icon="inline-end">Esc</Kbd>
          </ButtonBehavior>
        )}
      </div>

      {slide && (
        <section
          key={slide.id}
          data-slides="slide"
          data-slide-id={slide.id}
          aria-roledescription="slide"
          aria-label={`${position}: ${slide.label}`}
          className="flex min-w-0 flex-1 flex-col gap-8 text-xl 2xl:text-2xl"
        >
          {slide.content}
        </section>
      )}

      <div data-slides="controls" className="flex flex-col gap-4">
        {/* Stock Progress passes no value to its root, so the bar is for the eye; the words say it. */}
        <Progress value={total === 0 ? 0 : ((index + 1) / total) * 100} aria-hidden className="h-2" />
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
          <ButtonBehavior
            data-slides="previous"
            render={<Button variant="outline" size="lg" className="justify-self-start" />}
            disabled={index === 0}
            focusableWhenDisabled
            aria-keyshortcuts="ArrowLeft h ArrowUp k PageUp"
            onClick={() => go(index - 1)}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Previous
            <KbdGroup data-icon="inline-end" className="hidden sm:inline-flex">
              <Kbd>←</Kbd>
              <Kbd>h</Kbd>
            </KbdGroup>
          </ButtonBehavior>
          <p data-slides="position" aria-live="polite" className="text-center text-xl font-medium 2xl:text-2xl">
            {position}
          </p>
          <ButtonBehavior
            data-slides="next"
            render={<Button size="lg" className="justify-self-end" />}
            disabled={index >= last}
            focusableWhenDisabled
            aria-keyshortcuts="ArrowRight l ArrowDown j PageDown"
            onClick={() => go(index + 1)}
          >
            Next
            <KbdGroup data-icon="inline-end" className="hidden sm:inline-flex">
              <Kbd>→</Kbd>
              <Kbd>l</Kbd>
            </KbdGroup>
            <ArrowRightIcon data-icon="inline-end" />
          </ButtonBehavior>
        </div>
        <p data-slides="keys" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-base text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <KbdGroup>
              <Kbd>←</Kbd>
              <Kbd>↑</Kbd>
              <Kbd>h</Kbd>
              <Kbd>k</Kbd>
              <Kbd>PgUp</Kbd>
            </KbdGroup>
            Previous
          </span>
          <span className="inline-flex items-center gap-2">
            <KbdGroup>
              <Kbd>→</Kbd>
              <Kbd>↓</Kbd>
              <Kbd>l</Kbd>
              <Kbd>j</Kbd>
              <Kbd>PgDn</Kbd>
            </KbdGroup>
            Next
          </span>
          <span className="inline-flex items-center gap-2">
            <KbdGroup>
              <Kbd>Home</Kbd>
              <Kbd>End</Kbd>
            </KbdGroup>
            First, last
          </span>
          {exit && (
            <span className="inline-flex items-center gap-2">
              <Kbd>Esc</Kbd>
              {exit.label}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
