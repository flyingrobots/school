// The home page (flyingrobots/school#166). It leads with something to look forward to: a
// question a course is about to answer, then the questions still ahead in the learner's unfinished
// courses, each with the lesson's own picture. Below, what happened since the learner was last here:
// the newest feedback and the questions ready for another look, beside a timeline of the days they
// studied and the days questions come back. Each part loads, fails and retries on its own.
// Results are words, never scores (RFC 2 §4.3), in School's voice (docs/topics/voice/README.md).
import { tzParam } from "@/lib/zone"
import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { useShortcut } from "@ui-sdk/react/shortcuts"
import {
  ArrowRightIcon,
  BookOpenIcon,
  CalendarClockIcon,
  PartyPopperIcon,
  PlayIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Link } from "react-router"
import type { z } from "zod"

import { FeedbackCard, ReviewList } from "@/components/home-letter"
import {
  Timeline,
  TimelineLegend,
  dayWords,
  markKey,
  marksOf,
  type Mark,
} from "@/components/home-timeline"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { HookFigure } from "@/components/hook-figure"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useDocumentTitle } from "@/lib/document-title"
import {
  ActivityJson,
  FeedbackJson,
  ResumeJson,
  ReviewJson,
  ShowcaseJson,
  lessonHref,
  type Ahead,
  type Resume,
  type ReviewItem,
} from "@/lib/home-api"
import { useJson, type Load } from "@/lib/use-json"

gsap.registerPlugin(useGSAP)

const heading = "font-heading font-semibold tracking-tight"

/** What the hero shows: a course not started yet, or else the lesson to study now. */
type Hero = {
  item: Ahead
  label: string
  go: string
  icon: React.ReactNode
}

function heroOf(ahead: Ahead[], resume: Resume | null): Hero | null {
  // Studied before at all: a finished course is no longer ahead, so ask where the learner left off.
  const studied =
    ahead.some((a) => a.started) ||
    (resume !== null &&
      resume.kind !== "nothing" &&
      resume.lastStudied !== null)
  const fresh = ahead.find((a) => !a.started)
  if (fresh)
    return {
      item: fresh,
      label: studied ? "New for you" : "Start here",
      go: `Start lesson ${fresh.lesson.position}`,
      icon: <SparklesIcon />,
    }
  if (resume && resume.kind !== "finished" && resume.kind !== "nothing") {
    const item = ahead.find(
      (a) => a.course === resume.course && a.lesson.id === resume.lesson.id
    )
    if (item)
      return resume.kind === "continue"
        ? {
            item,
            label: "Pick up where you left off",
            go: "Continue",
            icon: <PlayIcon />,
          }
        : { item, label: "Up next", go: "Start", icon: <ArrowRightIcon /> }
  }
  const next = ahead[0]
  return next
    ? { item: next, label: "Up next", go: "Start", icon: <ArrowRightIcon /> }
    : null
}

function Failed({
  title,
  reason,
  retry,
}: {
  title: string
  reason: string | null
  retry: () => void
}) {
  return (
    <Alert variant="destructive" className="text-base">
      <TriangleAlertIcon />
      <AlertTitle className="text-lg">{title}</AlertTitle>
      <AlertDescription className="text-base">
        {reason ??
          "School's server did not answer as expected. Check that it is running, then try again."}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={retry} data-nav>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  )
}

function HeroCard({ hero }: { hero: Hero }) {
  const { item } = hero
  const go = React.useRef<HTMLAnchorElement>(null)
  const href = lessonHref(item.course, item.lesson.id)
  // One key from opening School to studying: focus starts on the button, unless it is already elsewhere.
  React.useEffect(() => {
    if (
      document.activeElement === document.body ||
      document.activeElement === null
    )
      go.current?.focus({ preventScroll: true })
  }, [href])
  return (
    <Card
      data-hero={item.started ? "started" : "new"}
      className="overflow-hidden py-0"
    >
      <div className="grid items-stretch md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <CardHeader className="gap-4 py-8">
          <CardDescription className="flex flex-wrap items-center gap-2 text-base">
            <Badge variant="secondary">
              {hero.icon} {hero.label}
            </Badge>
            {item.courseTitle} · Lesson {item.lesson.position} of{" "}
            {item.lesson.of}: {item.lesson.title}
          </CardDescription>
          <CardTitle>
            <h1
              className={`${heading} text-4xl leading-tight text-balance md:text-5xl 2xl:text-6xl`}
            >
              {item.question}
            </h1>
          </CardTitle>
          <p className="text-lg text-balance text-muted-foreground 2xl:text-xl">
            {item.teaser}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button asChild size="lg" data-nav>
              <Link ref={go} to={href}>
                {hero.go}
                <Kbd data-key-hint>↵</Kbd>
              </Link>
            </Button>
            <Button asChild size="lg" variant="ghost" data-nav>
              <Link to={`/courses/${item.course}`}>
                See all {item.lesson.of} lessons
              </Link>
            </Button>
          </div>
        </CardHeader>
        {item.figure && (
          <HookFigure
            svg={item.figure}
            className="h-72 border-t bg-background px-6 py-6 md:h-[26rem] md:border-t-0 md:border-l"
          />
        )}
      </div>
    </Card>
  )
}

function AheadCarousel({
  items,
  partway,
}: {
  items: Ahead[]
  partway: string | null
}) {
  return (
    <section
      aria-labelledby="home-ahead"
      // The carousel's track holds every card; this keeps it from widening the page.
      className="flex min-w-0 flex-col gap-4 contain-inline-size"
    >
      <div>
        <h2 id="home-ahead" className={`${heading} text-2xl 2xl:text-3xl`}>
          Still ahead in your courses
        </h2>
        <p className="text-muted-foreground">
          Questions your next lessons answer.
        </p>
      </div>
      <Carousel opts={{ align: "start" }} className="md:px-12">
        <CarouselContent>
          {items.map((a) => {
            const here = partway === `${a.course}:${a.lesson.id}`
            return (
              <CarouselItem
                key={`${a.course}:${a.lesson.id}`}
                className="basis-[85%] sm:basis-1/2 lg:basis-1/3"
              >
                <Link
                  to={lessonHref(a.course, a.lesson.id)}
                  data-ahead={`${a.course}:${a.lesson.id}`}
                  data-nav
                  className="block h-full rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Card className="h-full overflow-hidden pt-0 transition-colors hover:bg-muted/40">
                    <div className="flex h-40 items-center justify-center border-b bg-background p-4">
                      {a.figure ? (
                        <HookFigure svg={a.figure} className="h-full" />
                      ) : (
                        <BookOpenIcon
                          className="size-10 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                    </div>
                    <CardHeader>
                      <CardDescription className="flex flex-wrap items-center gap-2">
                        {here && <Badge>You're partway</Badge>}
                        {a.courseTitle}
                      </CardDescription>
                      <CardTitle className="text-lg leading-snug text-balance">
                        {a.question}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 text-sm text-muted-foreground">
                      {a.teaser}
                    </CardContent>
                    <CardFooter className="justify-between text-sm">
                      <span className="text-muted-foreground">
                        Lesson {a.lesson.position} of {a.lesson.of}:{" "}
                        {a.lesson.title}
                      </span>
                      <ArrowRightIcon className="size-4" />
                    </CardFooter>
                  </Card>
                </Link>
              </CarouselItem>
            )
          })}
        </CarouselContent>
        <CarouselPrevious className="left-0 hidden md:inline-flex" />
        <CarouselNext className="right-0 hidden md:inline-flex" />
      </Carousel>
    </section>
  )
}

function Today({
  feedback,
  review,
  retryFeedback,
  retryReview,
  answerAt,
}: {
  feedback: Load<z.infer<typeof FeedbackJson>>
  review: Load<ReviewItem[]>
  retryFeedback: () => void
  retryReview: () => void
  answerAt: ((item: ReviewItem) => string) | null
}) {
  const quiet =
    feedback.kind === "ready" &&
    feedback.data === null &&
    review.kind === "ready" &&
    review.data.length === 0
  if (quiet)
    return (
      <Empty className="border py-12" data-quiet>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PartyPopperIcon />
          </EmptyMedia>
          <EmptyTitle className="text-xl">
            Nothing new since you were last here
          </EmptyTitle>
          <EmptyDescription className="text-base">
            Feedback on your explanations and questions ready for another look
            will show up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <div className="flex flex-col gap-6">
      {feedback.kind === "loading" && (
        <Skeleton className="h-80 w-full rounded-xl" />
      )}
      {feedback.kind === "failed" && (
        <Failed
          title="Your feedback could not be loaded"
          reason={feedback.reason}
          retry={retryFeedback}
        />
      )}
      {feedback.kind === "ready" && feedback.data && (
        <FeedbackCard feedback={feedback.data} />
      )}
      {(review.kind === "loading" ||
        (review.kind === "ready" &&
          review.data.length > 0 &&
          answerAt === null)) && (
        <Skeleton className="h-32 w-full rounded-xl" />
      )}
      {review.kind === "failed" && (
        <Failed
          title="Questions to review could not be loaded"
          reason={review.reason}
          retry={retryReview}
        />
      )}
      {review.kind === "ready" && review.data.length > 0 && answerAt && (
        <div className="flex flex-col gap-3">
          <h3 className={`${heading} text-xl`}>Ready for another look</h3>
          <ReviewList items={review.data} answerAt={answerAt} />
        </div>
      )}
    </div>
  )
}

function Day({ mark }: { mark: Exclude<Mark, { kind: "today" }> }) {
  return (
    <Card data-day={markKey(mark)}>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {mark.kind === "due" ? (
            <CalendarClockIcon className="size-4" />
          ) : (
            <BookOpenIcon className="size-4" />
          )}
          {mark.title}
        </CardDescription>
        <CardTitle className="font-heading text-2xl">
          {mark.kind === "studied"
            ? `You studied on ${dayWords(mark.day)}`
            : `${mark.items} ${mark.items === 1 ? "question comes" : "questions come"} back on ${dayWords(mark.day)}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground">
        {mark.kind === "studied"
          ? `A day of ${mark.title}.`
          : "Questions you've met before that took a second go or a little help come back after a day, so the answer comes from memory."}
      </CardContent>
      <CardFooter>
        <Button asChild variant="outline" data-nav>
          <Link to={`/courses/${mark.course}`}>Open {mark.title}</Link>
        </Button>
      </CardFooter>
    </Card>
  )
}

function SinceLastTime({
  answerAt,
}: {
  answerAt: ((item: ReviewItem) => string) | null
}) {
  const [feedback, retryFeedback] = useJson("/api/feedback", FeedbackJson)
  const [review, retryReview] = useJson(`/api/review?${tzParam()}`, ReviewJson)
  const [activity, retryActivity] = useJson(
    `/api/activity?days=14&${tzParam()}`,
    ActivityJson
  )
  const [sel, setSel] = React.useState<Mark>({ kind: "today" })
  const marks = activity.kind === "ready" ? marksOf(activity.data) : []
  const step = (by: number) => () => {
    const i = marks.findIndex((m) => markKey(m) === markKey(sel))
    const next = marks[i + by]
    if (next) setSel(next)
  }
  useShortcut("[", step(-1), { description: "Timeline: earlier" })
  useShortcut("]", step(1), { description: "Timeline: later" })
  useShortcut("t", () => setSel({ kind: "today" }), {
    description: "Timeline: today",
  })
  const studiedDays =
    activity.kind === "ready"
      ? new Set(activity.data.courses.flatMap((c) => c.studied)).size
      : null
  return (
    <section aria-labelledby="home-since" className="flex flex-col gap-4">
      <h2 id="home-since" className={`${heading} text-2xl 2xl:text-3xl`}>
        Since you were last here
      </h2>
      <div>
        {activity.kind === "loading" && (
          <Skeleton className="h-56 w-full rounded-xl" />
        )}
        {activity.kind === "failed" && (
          <Failed
            title="Your timeline could not be loaded"
            reason={activity.reason}
            retry={retryActivity}
          />
        )}
        {activity.kind === "ready" && (
          <Card data-timeline>
            <CardHeader>
              <CardTitle>
                {studiedDays === 0
                  ? "Your timeline starts with your first lesson"
                  : `You studied on ${studiedDays} of the last ${activity.data.days} days`}
              </CardTitle>
              <CardDescription>
                Every mark opens its day below. Today is open now.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Timeline
                activity={activity.data}
                selected={markKey(sel)}
                onSelect={setSel}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <TimelineLegend />
                <span data-key-hint className="flex items-center gap-1.5">
                  <KbdGroup>
                    <Kbd>[</Kbd>
                    <Kbd>]</Kbd>
                  </KbdGroup>
                  earlier, later
                  <Kbd>t</Kbd> today
                </span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <div data-since>
        {sel.kind === "today" ? (
          <Today
            feedback={feedback}
            review={review}
            retryFeedback={retryFeedback}
            retryReview={retryReview}
            answerAt={answerAt}
          />
        ) : (
          <Day mark={sel} />
        )}
      </div>
    </section>
  )
}

export function HomePage() {
  useDocumentTitle()
  const [showcase, retryShowcase] = useJson("/api/showcase", ShowcaseJson)
  const [resume] = useJson("/api/resume", ResumeJson)
  const scope = React.useRef<HTMLDivElement>(null)

  const ahead = showcase.kind === "ready" ? showcase.data : []
  const hero =
    showcase.kind === "ready" && resume.kind !== "loading"
      ? heroOf(ahead, resume.kind === "ready" ? resume.data : null)
      : null
  const partway =
    resume.kind === "ready" && resume.data.kind === "continue"
      ? `${resume.data.course}:${resume.data.lesson.id}`
      : null
  const rest = ahead
    .filter((a) => a !== hero?.item)
    .sort(
      (x, y) =>
        Number(`${y.course}:${y.lesson.id}` === partway) -
        Number(`${x.course}:${x.lesson.id}` === partway)
    )

  // A question comes back at the top of another lesson in its course: the next one ahead there.
  // Until what's ahead has loaded that lesson is unknown, so there is no link yet
  // (flyingrobots/school#205); if it fails, the course page stands in.
  const answerAt =
    showcase.kind === "loading"
      ? null
      : (r: ReviewItem) => {
          const there = ahead.find(
            (a) => a.course === r.course && a.lesson.id !== r.lesson?.id
          )
          return there
            ? lessonHref(there.course, there.lesson.id)
            : `/courses/${r.course}`
        }

  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        // Opacity and position only, never visibility: the hero's button takes focus while it comes in.
        gsap.from("[data-hero]", {
          y: 24,
          opacity: 0,
          duration: 0.5,
          ease: "power3.out",
        })
        // The hero's figure draws itself, line by line.
        scope.current
          ?.querySelectorAll<SVGGeometryElement>(
            "[data-hero] [data-figure] :is(path, polyline, line)"
          )
          .forEach((el, i) => {
            if (typeof el.getTotalLength !== "function") return
            const len = el.getTotalLength()
            gsap.fromTo(
              el,
              { strokeDasharray: len, strokeDashoffset: len },
              {
                strokeDashoffset: 0,
                duration: 2,
                delay: 0.3 + i * 0.15,
                ease: "power1.inOut",
              }
            )
          })
      })
    },
    {
      scope,
      dependencies: [hero?.item.course, hero?.item.lesson.id],
      revertOnUpdate: true,
    }
  )

  const nothing = showcase.kind === "ready" && ahead.length === 0
  return (
    <div ref={scope} className="flex w-full min-w-0 flex-col gap-10 2xl:gap-14">
      {showcase.kind === "loading" && (
        <>
          <h1 className="sr-only">Home</h1>
          <p className="flex items-center gap-2 text-lg text-muted-foreground">
            <Spinner className="size-5" /> Finding what's next
          </p>
          <Skeleton className="h-80 w-full rounded-xl" />
        </>
      )}
      {showcase.kind === "failed" && (
        <>
          <h1 className={`${heading} text-4xl`}>Home</h1>
          <Failed
            title="What's ahead could not be loaded"
            reason={showcase.reason}
            retry={retryShowcase}
          />
        </>
      )}
      {nothing && (
        <>
          <h1 className="sr-only">Home</h1>
          <Empty className="border py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PartyPopperIcon />
              </EmptyMedia>
              <EmptyTitle className="text-2xl">
                Nothing ahead right now
              </EmptyTitle>
              <EmptyDescription className="text-lg">
                Every lesson with a question is done, or no course has lessons
                yet. New lessons show up here as soon as a course adds them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </>
      )}
      {hero && <HeroCard hero={hero} />}
      {showcase.kind === "ready" && !hero && !nothing && (
        <Skeleton className="h-80 w-full rounded-xl" />
      )}
      {rest.length > 0 && <AheadCarousel items={rest} partway={partway} />}
      <SinceLastTime answerAt={answerAt} />
    </div>
  )
}
