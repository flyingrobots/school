// The home page (flyingrobots/school#39). It answers "what do I study now?" first: the lesson to
// continue, with its next question written out, from GET /api/resume. Then every course with its
// progress in words, from GET /api/courses (web/src/lib/courses.ts, shared with the sidebar).
// Progress is never a percentage, a letter or a score (RFC 2 §4.3). Composed only of stock shadcn
// components; the layout is Tailwind token classes.
import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  FlagIcon,
  LibraryBigIcon,
  MessageCircleQuestionIcon,
  PlayIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Link } from "react-router"
import { z } from "zod"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useDocumentTitle } from "@/lib/document-title"
import { useCourses, useCourseTitle, type CoursesLoad } from "@/lib/courses"
import type { CourseSummary } from "@/lib/school-api"

gsap.registerPlugin(useGSAP)

type Course = CourseSummary

// GET /api/resume (server/core/school.ts, Resume).
const ResumeLesson = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  position: z.number().int().positive(),
  of: z.number().int().positive(),
  quizzes: z.number().int().nonnegative(),
  answeredCorrectly: z.number().int().nonnegative(),
})
const ResumeJson = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["continue", "next", "start"]),
    course: z.string(),
    lesson: ResumeLesson,
    question: z.string().nullable(),
    lastStudied: z.string().nullable(),
  }),
  z.object({ kind: z.literal("finished"), course: z.string(), lastStudied: z.string() }),
  z.object({ kind: z.literal("nothing") }),
])
type Resume = z.infer<typeof ResumeJson>
type Step = Extract<Resume, { lesson: unknown }>

type Load<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  // No usable answer: unreachable, or the wrong shape. `reason` is the server's, when it gave one.
  | { kind: "failed"; reason: string | null }

function useJson<T>(url: string, schema: z.ZodType<T>): [Load<T>, () => void] {
  const [attempt, setAttempt] = React.useState(0)
  const [answer, setAnswer] = React.useState<{ attempt: number; load: Load<T> } | null>(null)

  React.useEffect(() => {
    const abort = new AbortController()
    const settle = (load: Load<T>) => abort.signal.aborted || setAnswer({ attempt, load })
    ;(async (): Promise<Load<T>> => {
      const res = await fetch(url, { signal: abort.signal })
      const body: unknown = await res.json()
      if (!res.ok) {
        const reason = z.object({ error: z.string() }).safeParse(body)
        return { kind: "failed", reason: reason.success ? reason.data.error : null }
      }
      const parsed = schema.safeParse(body)
      return parsed.success ? { kind: "ready", data: parsed.data } : { kind: "failed", reason: null }
    })().then(settle, () => settle({ kind: "failed", reason: null }))
    return () => abort.abort()
  }, [url, schema, attempt])

  return [answer?.attempt === attempt ? answer.load : { kind: "loading" }, () => setAttempt((n) => n + 1)]
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Correct answers in words: "2 of 5 quizzes answered correctly". */
function answeredWords(quizzes: number, answeredCorrectly: number): string {
  if (quizzes === 0) return "No quizzes"
  return `${answeredCorrectly} of ${quizzes} ${quizzes === 1 ? "quiz" : "quizzes"} answered correctly`
}

/** "5 minutes ago", "yesterday": when the learner last studied, in words. */
function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]]
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  return "just now"
}

const heading = "font-heading font-semibold tracking-tight"

export function HomePage() {
  useDocumentTitle()
  // Shared with the sidebar, and asked again on each visit here so the progress is current.
  const [courses, retryCourses] = useCourses({ fresh: true })
  const [resume, retryResume] = useJson("/api/resume", ResumeJson)
  const scope = React.useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      // Opacity only, never visibility: the Continue button takes focus while it comes in.
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        const tl = gsap.timeline({ defaults: { ease: "power3.out" } })
        tl.from("[data-animate=heading]", { y: 20, opacity: 0, duration: 0.45 })
          .from("[data-animate=resume]", { y: 28, opacity: 0, duration: 0.55 }, "-=0.25")
          .from("[data-animate=resume-part]", { y: 12, opacity: 0, duration: 0.35, stagger: 0.06 }, "-=0.35")
          .from("[data-animate=course]", { x: 16, opacity: 0, duration: 0.35, stagger: 0.05 }, "<")
      })
    },
    { scope, dependencies: [courses.kind, resume.kind], revertOnUpdate: true }
  )

  const noCourses = courses.kind === "ready" && courses.data.length === 0

  return (
    <div ref={scope} className="flex w-full flex-col gap-8 2xl:gap-12">
      <div data-animate="heading" className="flex flex-col gap-2">
        <h1 className={`${heading} text-4xl sm:text-5xl 2xl:text-6xl`}>Home</h1>
        <Since resume={resume} />
      </div>
      {noCourses ? (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LibraryBigIcon />
            </EmptyMedia>
            <EmptyTitle className="text-2xl">No courses yet</EmptyTitle>
            <EmptyDescription className="text-lg">
              Courses show up here once School's server is started with them (SCHOOL_COURSES).
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12 2xl:gap-12">
          <section aria-label="What to study now" className="lg:col-span-7">
            <ResumeArea resume={resume} retry={retryResume} />
          </section>
          <section aria-labelledby="home-courses" className="flex flex-col gap-4 lg:col-span-5">
            <h2 id="home-courses" className={`${heading} text-2xl 2xl:text-3xl`}>
              Your courses
            </h2>
            <CourseList courses={courses} retry={retryCourses} />
          </section>
        </div>
      )}
    </div>
  )
}

/** The line under the heading: when the learner last studied, or that it is loading. */
function Since({ resume }: { resume: Load<Resume> }) {
  const line = "flex items-center gap-2 text-lg text-muted-foreground 2xl:text-xl"
  if (resume.kind === "loading")
    return (
      <p className={line}>
        <Spinner className="size-5" />
        Finding where you left off
      </p>
    )
  if (resume.kind !== "ready" || resume.data.kind === "nothing") return null
  const last = resume.data.lastStudied
  return <p className={line}>{last === null ? "Welcome. Your first lesson is ready." : `You last studied ${ago(last)}.`}</p>
}

function ResumeArea({ resume, retry }: { resume: Load<Resume>; retry: () => void }) {
  switch (resume.kind) {
    case "loading":
      return <Skeleton className="h-96 w-full rounded-xl 2xl:h-[28rem]" />
    case "failed":
      return (
        <Alert variant="destructive" className="text-base">
          <TriangleAlertIcon />
          <AlertTitle className="text-lg">Where you left off could not be loaded</AlertTitle>
          <AlertDescription className="text-base">
            {resume.reason ?? "School's server did not answer as expected. Check that it is running, then try again."}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={retry} data-nav>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      )
    case "ready": {
      const r = resume.data
      if (r.kind === "nothing")
        return (
          <Empty className="border py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon />
              </EmptyMedia>
              <EmptyTitle className="text-2xl">Nothing to study yet</EmptyTitle>
              <EmptyDescription className="text-lg">Lessons show up once they are added to a course's lessons folder.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      if (r.kind === "finished") return <Finished course={r.course} />
      return <Continue step={r} />
    }
  }
}

const card = "gap-6 [--card-spacing:--spacing(6)] sm:[--card-spacing:--spacing(8)] 2xl:[--card-spacing:--spacing(10)]"
const bigButton = "h-12 gap-2 px-5 text-base 2xl:h-14 2xl:px-6 2xl:text-lg"

const label: Record<Step["kind"], { text: string; icon: React.ReactNode; go: string }> = {
  continue: { text: "Pick up where you left off", icon: <PlayIcon data-icon="inline-start" />, go: "Continue" },
  next: { text: "Up next", icon: <ArrowRightIcon data-icon="inline-start" />, go: "Start" },
  start: { text: "Start here", icon: <SparklesIcon data-icon="inline-start" />, go: "Start" },
}

/** The lesson to study now: the first thing on the page, and the first focus stop. */
function Continue({ step }: { step: Step }) {
  const { kind, course, lesson, question } = step
  const title = useCourseTitle(course)
  const go = React.useRef<HTMLAnchorElement>(null)
  const href = `/courses/${course}/lessons/${lesson.id}`
  const done = lesson.quizzes > 0 && lesson.answeredCorrectly === lesson.quizzes

  // One key from opening School to studying: focus starts on the button, unless it is already elsewhere.
  React.useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) go.current?.focus({ preventScroll: true })
  }, [href])

  return (
    <Card data-animate="resume" data-resume={kind} className={card}>
      <CardHeader className="gap-4">
        <div data-animate="resume-part" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge className="h-auto px-3 py-1 text-sm 2xl:text-base">
            {label[kind].icon}
            {label[kind].text}
          </Badge>
          <span className="text-base text-muted-foreground 2xl:text-lg">
            Lesson {lesson.position} of {lesson.of} in {title}
          </span>
        </div>
        <CardTitle data-animate="resume-part" role="heading" aria-level={2} className={`${heading} text-4xl leading-tight sm:text-5xl 2xl:text-7xl`}>
          {lesson.title}
        </CardTitle>
        {lesson.subtitle && (
          <CardDescription data-animate="resume-part" className="text-xl 2xl:text-2xl">
            {lesson.subtitle}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div data-animate="resume-part">
          <Badge variant={done ? "default" : lesson.quizzes === 0 ? "outline" : "secondary"} className="h-auto px-3 py-1 text-sm 2xl:text-base">
            {done && <CheckIcon data-icon="inline-start" />}
            {answeredWords(lesson.quizzes, lesson.answeredCorrectly)}
          </Badge>
        </div>
        {question !== null && (
          <Item data-animate="resume-part" variant="muted" className="items-start gap-4 p-5 2xl:p-6">
            <ItemMedia variant="icon" className="size-10 2xl:size-12">
              <MessageCircleQuestionIcon className="size-5 2xl:size-6" />
            </ItemMedia>
            <ItemContent className="gap-1.5">
              <ItemDescription className="text-base 2xl:text-lg">Your next question</ItemDescription>
              <ItemTitle className="text-xl leading-snug font-medium sm:text-2xl 2xl:text-3xl">{question}</ItemTitle>
            </ItemContent>
          </Item>
        )}
      </CardContent>
      <CardFooter data-animate="resume-part" className="flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <Button asChild size="lg" className={bigButton}>
          <Link ref={go} to={href} data-nav aria-keyshortcuts="Enter">
            {label[kind].go}
            <span className="sr-only">: {lesson.title}</span>
            <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">↵</Kbd>
          </Link>
        </Button>
        <Button asChild size="lg" variant="ghost" className={bigButton}>
          <Link to={`/courses/${course}`} data-nav>
            All lessons in {title}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}

function Finished({ course }: { course: string }) {
  const title = useCourseTitle(course)
  return (
    <Card data-animate="resume" data-resume="finished" className={card}>
      <CardHeader className="gap-4">
        <div data-animate="resume-part">
          <Badge className="h-auto px-3 py-1 text-sm 2xl:text-base">
            <FlagIcon data-icon="inline-start" />
            Course finished
          </Badge>
        </div>
        <CardTitle data-animate="resume-part" role="heading" aria-level={2} className={`${heading} text-4xl leading-tight sm:text-5xl 2xl:text-6xl`}>
          Every quiz in {title} is answered correctly
        </CardTitle>
        <CardDescription data-animate="resume-part" className="text-xl 2xl:text-2xl">
          Go back over any lesson, or pick another course.
        </CardDescription>
      </CardHeader>
      <CardFooter data-animate="resume-part">
        <Button asChild size="lg" className={bigButton}>
          <Link to={`/courses/${course}`} data-nav>
            Open {title}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}

function CourseList({ courses, retry }: { courses: CoursesLoad; retry: () => void }) {
  switch (courses.kind) {
    case "loading":
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-[2199px]:grid-cols-1">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      )
    case "failed":
      return (
        <Alert variant="destructive" className="text-base">
          <TriangleAlertIcon />
          <AlertTitle className="text-lg">Your courses could not be loaded</AlertTitle>
          <AlertDescription className="text-base">
            {courses.reason ?? "School's server did not answer as expected. Check that it is running, then try again."}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={retry} data-nav>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      )
    case "ready":
      return (
        <>
          {/* Each course is a link, so the group is not announced as a list of non-items. */}
          <ItemGroup role={undefined} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-[2199px]:grid-cols-1">
            {courses.data.map((c) => (
              <CourseItem key={c.name} course={c} />
            ))}
          </ItemGroup>
          <p className="flex flex-wrap items-center gap-2 text-base text-muted-foreground">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            move between courses,
            <Kbd>↵</Kbd>
            opens one
          </p>
        </>
      )
  }
}

function CourseItem({ course: c }: { course: Course }) {
  const reference = c.reference === 0 ? "" : ` and ${c.reference === 1 ? "a reference document" : plural(c.reference, "reference document", "reference documents")}`
  const done = (c.quizzes ?? 0) > 0 && c.answeredCorrectly === c.quizzes
  const [description, badge] =
    c.lessons === null
      ? ["Open it to see what went wrong.", <Badge variant="destructive" className="h-auto text-sm 2xl:text-base">Its lessons could not be read</Badge>]
      : c.lessons === 0
        ? ["Lessons show up once they are added.", <Badge variant="outline" className="h-auto text-sm 2xl:text-base">No lessons yet</Badge>]
        : [
            plural(c.lessons, "lesson", "lessons") + reference,
            <Badge variant={done ? "default" : c.quizzes === 0 ? "outline" : "secondary"} className="h-auto text-sm 2xl:text-base">
              {done && <CheckIcon data-icon="inline-start" />}
              {answeredWords(c.quizzes ?? 0, c.answeredCorrectly ?? 0)}
            </Badge>,
          ]
  return (
    <Item asChild variant="outline" className="items-start gap-4 p-5" data-animate="course">
      <Link to={`/courses/${c.name}`} data-nav data-course={c.name}>
        <ItemMedia variant="icon" className="size-10">
          {c.lessons === null ? <TriangleAlertIcon className="size-5" /> : <BookOpenIcon className="size-5" />}
        </ItemMedia>
        <ItemContent className="gap-1">
          <ItemTitle className="text-xl 2xl:text-2xl">{c.title}</ItemTitle>
          <ItemDescription className="text-base 2xl:text-lg">{description}</ItemDescription>
        </ItemContent>
        <ItemFooter className="pl-14">{badge}</ItemFooter>
      </Link>
    </Item>
  )
}
