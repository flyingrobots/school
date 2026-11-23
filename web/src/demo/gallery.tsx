// The theme sandbox: one registry example on screen, its variants on up/down, components on left/right.
import * as React from "react"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { useShortcut } from "@ui-sdk/react/shortcuts"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { ModeToggle } from "@/components/mode-toggle"
import { Toaster } from "@/components/ui/sonner"
import { VariantContext } from "./example"

type Module = { default?: React.ComponentType }
const loaders = import.meta.glob<Module>("../components/*-example.tsx")

const components = Object.keys(loaders)
  .filter((path) => !path.endsWith("/component-example.tsx")) // a website landing composite, not one component
  .sort()
  .map((path) => {
    const slug = path.match(/([a-z-]+)-example\.tsx$/)![1]!
    return {
      slug,
      name: slug
        .split("-")
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(" "),
      View: React.lazy(async () => ({
        default: (await loaders[path]!()).default!,
      })),
    }
  })

function fromHash(): { at: number; variant: number } {
  const [slug, variant] = window.location.hash.replace(/^#\/?/, "").split("/")
  const at = components.findIndex((c) => c.slug === slug)
  return { at: Math.max(at, 0), variant: Math.max(Number(variant) || 0, 0) }
}

export function Gallery() {
  const [{ at, variant }, setPosition] = React.useState(fromHash)
  const [count, setCount] = React.useState(1)
  const [title, setTitle] = React.useState<string>()
  const stage = React.useRef<HTMLElement>(null)
  const current = components[at]!
  const wrap = (i: number, n: number) => (i + n) % n

  React.useEffect(() => {
    window.history.replaceState(null, "", `#/${current.slug}/${variant}`)
  }, [current.slug, variant])

  const go = (step: number) => {
    setCount(1)
    setTitle(undefined)
    setPosition({ at: wrap(at + step, components.length), variant: 0 })
  }
  const turn = (step: number) =>
    setPosition({ at, variant: wrap(variant + step, count) })

  // Arrow keys belong to the example while focus is inside it (sliders, tabs, menus use them).
  const outsideStage = () => !stage.current?.contains(document.activeElement)
  useShortcut("arrowleft", () => go(-1), {
    when: outsideStage,
    description: "Previous component",
  })
  useShortcut("arrowright", () => go(1), {
    when: outsideStage,
    description: "Next component",
  })
  useShortcut("arrowup", () => turn(-1), {
    when: outsideStage,
    description: "Previous example",
  })
  useShortcut("arrowdown", () => turn(1), {
    when: outsideStage,
    description: "Next example",
  })

  const variants = React.useMemo(
    () => ({ index: variant, onCount: setCount, onTitle: setTitle }),
    [variant]
  )
  const previous = components[wrap(at - 1, components.length)]!
  const next = components[wrap(at + 1, components.length)]!

  return (
    // shadcn's website provides TooltipProvider in its layout; the registry examples assume it.
    <TooltipProvider>
      <div className="flex min-h-svh flex-col bg-muted dark:bg-background">
        <header className="flex items-center justify-between px-4 py-4 sm:px-6">
          <span className="text-sm font-medium">School UI</span>
          <ModeToggle />
        </header>

        <main
          ref={stage}
          className="flex flex-1 items-center justify-center px-4 py-6 sm:p-6"
        >
          <VariantContext.Provider value={variants}>
            <React.Suspense fallback={<Spinner />}>
              <current.View key={current.slug} />
            </React.Suspense>
          </VariantContext.Provider>
        </main>

        {/* Controls follow the registry's kbd-button and kbd-tooltip patterns (apps/v4/examples/radix).
            On a phone the position sits on its own row above the two buttons, so nothing is wider than the page. */}
        <footer className="grid grid-cols-2 items-center gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[1fr_auto_1fr] sm:px-6">
          <Button
            variant="outline"
            className="max-w-full min-w-0 justify-self-start"
            onClick={() => go(-1)}
            aria-keyshortcuts="ArrowLeft"
          >
            <Kbd data-icon="inline-start" className="-translate-x-0.5">
              ←
            </Kbd>{" "}
            <span className="truncate">{previous.name}</span>
          </Button>
          <div className="order-first col-span-2 flex items-center gap-3 justify-self-center sm:order-none sm:col-span-1">
            <div className="flex flex-col items-end">
              <h1 className="text-sm font-medium">{current.name}</h1>
              <span
                aria-live="polite"
                className="text-xs text-muted-foreground"
              >
                {title ?? "Example"} · {Math.min(variant, count - 1) + 1} of{" "}
                {count}
              </span>
            </div>
            <ButtonGroup orientation="vertical">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    aria-label="Previous example"
                    aria-keyshortcuts="ArrowUp"
                    onClick={() => turn(-1)}
                    disabled={count < 2}
                  >
                    <ChevronUpIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  Previous example <Kbd>↑</Kbd>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    aria-label="Next example"
                    aria-keyshortcuts="ArrowDown"
                    onClick={() => turn(1)}
                    disabled={count < 2}
                  >
                    <ChevronDownIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  Next example <Kbd>↓</Kbd>
                </TooltipContent>
              </Tooltip>
            </ButtonGroup>
          </div>
          <Button
            variant="outline"
            className="max-w-full min-w-0 justify-self-end"
            onClick={() => go(1)}
            aria-keyshortcuts="ArrowRight"
          >
            <span className="truncate">{next.name}</span>{" "}
            <Kbd data-icon="inline-end" className="translate-x-0.5">
              →
            </Kbd>
          </Button>
        </footer>
        <Toaster />
      </div>
    </TooltipProvider>
  )
}
