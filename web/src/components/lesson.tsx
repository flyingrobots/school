import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { ArrowLeftIcon, ArrowRightIcon, FileQuestionIcon, InfoIcon, QuoteIcon, TriangleAlertIcon } from "lucide-react"

import { Markdown } from "@/components/markdown"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

// A lesson's frame and its reading blocks: where it is, its title, its sections, its prose, cards,
// quotes and asides (lesson HTML rendered through the markdown item, which sanitises it), an
// outline beside it on wide screens, and links to the lessons before and after. Interactive
// blocks (quiz, explain, nest) are the caller's, each wrapped in a LessonBlock.
//
// Every block and section heading is a focus stop for the app shell's key layer (`data-nav`,
// focusable but outside the Tab order), so `j`/`k` and the arrows step through the lesson in
// reading order, and the browser scrolls each stop into view. Router-agnostic: links go through
// `renderLink`, a plain anchor by default.

gsap.registerPlugin(useGSAP)

export type LessonLinkProps = React.ComponentProps<"a"> & { href: string }
export type LessonCrumb = { label: string; href: string }
/** A neighbouring lesson, for the previous and next links. */
export type LessonNeighbour = { href: string; title: string }
/** A section, for the outline. `id` is its anchor. */
export type LessonOutlineEntry = { id: string; title: string }
export type LessonBlockKind = "prose" | "card" | "quote" | "aside" | "quiz" | "explain" | "nest"

type RenderLink = (props: LessonLinkProps) => React.ReactElement
const anchor: RenderLink = (props) => <a {...props} />

const STOP = "rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
const PROSE = "text-lg 2xl:text-xl"

function Crumbs({ crumbs, current, renderLink }: { crumbs: LessonCrumb[]; current: string; renderLink: RenderLink }) {
  return (
    <Breadcrumb>
      <BreadcrumbList className="text-base">
        {crumbs.map((c) => (
          <React.Fragment key={c.href}>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>{renderLink({ href: c.href, children: c.label, "data-nav": "" } as LessonLinkProps)}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </React.Fragment>
        ))}
        <BreadcrumbItem>
          <BreadcrumbPage>{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl 2xl:text-6xl">{children}</h1>
}

/**
 * A GSAP timeline that brings the heading and then the blocks in, unless motion is reduced. It
 * fades opacity, never visibility, so every focus stop can take focus while it comes in.
 */
function useEntrance(scope: React.RefObject<HTMLDivElement | null>, key: string) {
  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power2.out" } })
          .from("[data-animate=heading]", { y: 24, opacity: 0, duration: 0.4 })
          .from("[data-animate=block]", { y: 16, opacity: 0, duration: 0.3, stagger: 0.05 }, "-=0.2")
      })
    },
    { scope, dependencies: [key], revertOnUpdate: true }
  )
}

/** The previous and next lessons, as large buttons. Either may be absent. */
export function LessonPager({
  prev,
  next,
  renderLink = anchor,
  className,
}: {
  prev?: LessonNeighbour | null
  next?: LessonNeighbour | null
  renderLink?: RenderLink
  className?: string
}) {
  if (!prev && !next) return null
  const link = (n: LessonNeighbour, rel: "prev" | "next") => (
    <Button asChild variant="outline" size="lg" className={cn("h-auto justify-start py-3 text-left whitespace-normal", rel === "next" && "sm:col-start-2 sm:justify-end sm:text-right")}>
      {renderLink({
        href: n.href,
        rel,
        "data-nav": "",
        children: (
          <>
            {rel === "prev" && <ArrowLeftIcon data-icon="inline-start" />}
            <span className="flex flex-col">
              <span className="text-sm text-muted-foreground">{rel === "prev" ? "Previous" : "Next"}</span>
              <span className="text-lg">{n.title}</span>
            </span>
            {rel === "next" && <ArrowRightIcon data-icon="inline-end" />}
          </>
        ),
      } as LessonLinkProps)}
    </Button>
  )
  return (
    <nav aria-label="Lessons" data-lesson="pager" className={cn("grid gap-4 sm:grid-cols-2", className)}>
      {prev && link(prev, "prev")}
      {next && link(next, "next")}
    </nav>
  )
}

/**
 * A lesson: its place, title and subtitle, then its blocks. Below `xl` the blocks take the full
 * width; from `xl` an outline of the sections sits beside them, and the pager closes the lesson.
 */
export function Lesson({
  title,
  subtitle,
  crumbs = [],
  outline = [],
  prev,
  next,
  renderLink = anchor,
  children,
}: {
  title: string
  subtitle?: string
  crumbs?: LessonCrumb[]
  outline?: LessonOutlineEntry[]
  prev?: LessonNeighbour | null
  next?: LessonNeighbour | null
  renderLink?: RenderLink
  children: React.ReactNode
}) {
  const scope = React.useRef<HTMLDivElement>(null)
  useEntrance(scope, title)
  return (
    <div ref={scope} data-lesson="root" className="flex w-full flex-col gap-8">
      <div data-animate="heading" className="flex flex-col gap-3">
        <Crumbs crumbs={crumbs} current={title} renderLink={renderLink} />
        <Heading>{title}</Heading>
        {subtitle && <p className="text-xl text-muted-foreground 2xl:text-2xl">{subtitle}</p>}
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div data-lesson="body" className="flex min-w-0 flex-col gap-8">
          {children}
          <LessonPager prev={prev} next={next} renderLink={renderLink} className="mt-4" />
        </div>
        {outline.length > 0 && (
          <nav aria-label="In this lesson" data-lesson="outline" className="hidden xl:block">
            <ItemGroup className="sticky top-8 gap-1">
              <ItemTitle className="px-3 pb-2 text-base text-muted-foreground">In this lesson</ItemTitle>
              {outline.map((s) => (
                <Item key={s.id} asChild size="sm">
                  <a href={`#${s.id}`} data-nav="">
                    <ItemContent>
                      <ItemTitle className="text-base">{s.title}</ItemTitle>
                    </ItemContent>
                  </a>
                </Item>
              ))}
            </ItemGroup>
          </nav>
        )}
      </div>
    </div>
  )
}

/** A section: its heading, a focus stop, and its blocks. `level` is the heading's (2 for a top-level section). */
export function LessonSection({ id, title, level = 2, children }: { id: string; title: string; level?: 2 | 3 | 4 | 5 | 6; children: React.ReactNode }) {
  const H = `h${level}` as "h2"
  const size = level === 2 ? "text-3xl 2xl:text-4xl" : "text-2xl 2xl:text-3xl"
  return (
    <section id={id} aria-labelledby={`${id}-title`} data-lesson="section" className="flex scroll-mt-8 flex-col gap-6">
      <H id={`${id}-title`} data-nav="" tabIndex={-1} data-animate="block" className={cn("font-heading font-semibold tracking-tight", size, STOP)}>
        {title}
      </H>
      {children}
    </section>
  )
}

/** One block of a lesson, as a focus stop. Wrap the interactive blocks (quiz, explain, nest) in it. */
export function LessonBlock({ kind, id, children }: { kind: LessonBlockKind; id?: string; children: React.ReactNode }) {
  return (
    <div data-lesson-block={kind} data-block-id={id} data-nav="" tabIndex={-1} data-animate="block" className={cn("min-w-0", STOP)}>
      {children}
    </div>
  )
}

/** Lesson HTML, sanitised and rendered through the markdown item. */
function Html({ html, className }: { html: string; className?: string }) {
  return <Markdown className={cn(PROSE, className)}>{html}</Markdown>
}

export function LessonProse({ id, html }: { id?: string; html: string }) {
  return (
    <LessonBlock kind="prose" id={id}>
      <Html html={html} />
    </LessonBlock>
  )
}

export function LessonCard({ id, html }: { id?: string; html: string }) {
  return (
    <LessonBlock kind="card" id={id}>
      <Card>
        <CardContent>
          <Html html={html} />
        </CardContent>
      </Card>
    </LessonBlock>
  )
}

export function LessonQuote({ id, html }: { id?: string; html: string }) {
  return (
    <LessonBlock kind="quote" id={id}>
      <Item variant="muted" className="items-start">
        <ItemMedia variant="icon">
          <QuoteIcon />
        </ItemMedia>
        <ItemContent>
          <Html html={html} className="italic" />
        </ItemContent>
      </Item>
    </LessonBlock>
  )
}

export function LessonAside({ id, html }: { id?: string; html: string }) {
  return (
    <LessonBlock kind="aside" id={id}>
      <Alert>
        <InfoIcon />
        <AlertDescription>
          <Html html={html} />
        </AlertDescription>
      </Alert>
    </LessonBlock>
  )
}

/** While the lesson is on its way: Skeletons in its shape, and a Spinner that says so. */
export function LessonLoading({ crumbs = [], renderLink = anchor }: { crumbs?: LessonCrumb[]; renderLink?: RenderLink }) {
  return (
    <div data-lesson="loading" aria-busy="true" className="flex w-full flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Crumbs crumbs={crumbs} current="Loading" renderLink={renderLink} />
        <h1 className="sr-only">Loading the lesson</h1>
        <Skeleton className="h-12 w-2/3 sm:h-14 2xl:h-16" />
        <Skeleton className="h-7 w-1/2" />
      </div>
      <div role="status" className="flex items-center gap-3 text-lg text-muted-foreground">
        <Spinner />
        Loading the lesson
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-9 w-1/3" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="hidden flex-col gap-3 xl:flex">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      </div>
    </div>
  )
}

/**
 * The lesson is not there to show: `missing` when the server says there is no such lesson,
 * `failed` when it could not be loaded. `action` is the way on (a link back, a retry).
 */
export function LessonUnavailable({
  reason,
  description,
  crumbs = [],
  renderLink = anchor,
  action,
}: {
  reason: "missing" | "failed"
  description: string
  crumbs?: LessonCrumb[]
  renderLink?: RenderLink
  action?: React.ReactNode
}) {
  const title = reason === "missing" ? "Lesson not found" : "The lesson did not load"
  return (
    <div data-lesson={reason} className="flex w-full flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Crumbs crumbs={crumbs} current={title} renderLink={renderLink} />
        <Heading>{title}</Heading>
      </div>
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">{reason === "missing" ? <FileQuestionIcon /> : <TriangleAlertIcon />}</EmptyMedia>
          <EmptyTitle className="text-xl">{reason === "missing" ? "There is no lesson at this address" : "School did not answer"}</EmptyTitle>
          <EmptyDescription className="text-lg">{description}</EmptyDescription>
        </EmptyHeader>
        {action && <EmptyContent>{action}</EmptyContent>}
      </Empty>
    </div>
  )
}
