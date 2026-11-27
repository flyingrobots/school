// The course page (flyingrobots/school#40): the course's lessons, each with how many of its quizzes
// the learner has answered correctly and how they are holding now (flyingrobots/school#221), from
// GET /api/courses/:course. Progress is told in words, never as a percentage or a score. Composed
// only of stock shadcn components.
import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  BookOpenIcon,
  CheckIcon,
  FileQuestionIcon,
  LibraryIcon,
  ScaleIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react"
import { Link, useParams } from "react-router"

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { HoldingBadges } from "@/components/holding-badges"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useDocumentTitle } from "@/lib/document-title"
import { titleOf, useCourse } from "@/lib/course"
import { useCourseTitle } from "@/lib/courses"
import { lessonHoldingWords } from "@/lib/holding"
import type { Course, CourseLoad, Declaration } from "@/lib/school-api"

gsap.registerPlugin(useGSAP)

type Lesson = Course["lessons"][number]
type State = CourseLoad

/** A lesson's progress in words: "2 of 3 quizzes answered correctly". */
export function progressWords({
  quizzes,
  answeredCorrectly,
}: Pick<Lesson, "quizzes" | "answeredCorrectly">): string {
  if (quizzes === 0) return "No quizzes"
  return `${answeredCorrectly} of ${quizzes} ${quizzes === 1 ? "quiz" : "quizzes"} answered correctly`
}

/** The course's reference documents, which are listed even when its lessons cannot be read. */
const referenceOf = (state: State): string[] =>
  state.kind === "ready"
    ? state.course.reference
    : state.kind === "unreadable"
      ? state.reference
      : []

/** What the course declares about itself, which is shown even when its lessons cannot be read. */
const declarationOf = (state: State): Declaration | null =>
  state.kind === "ready"
    ? state.course.declaration
    : state.kind === "unreadable"
      ? state.declaration
      : null

/** Whether School serves the course sandboxed; false until it answers. */
const untrusted = (state: State): boolean =>
  state.kind === "ready"
    ? !state.course.trusted
    : state.kind === "unreadable" && !state.trusted

const grid =
  "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"

export function CoursePage() {
  const { course: name } = useParams()
  const [state, retry] = useCourse(name!)
  const title = titleOf(state, useCourseTitle(name!))
  useDocumentTitle(title)
  const scope = React.useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      // Opacity, not autoAlpha: autoAlpha sets visibility: hidden, and a hidden element cannot take
      // focus, so j pressed while a lesson is still fading in would skip it (flyingrobots/school#114).
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power2.out" } })
          .from("[data-animate=heading]", { y: 24, opacity: 0, duration: 0.4 })
          .from(
            "[data-animate=body] > *",
            { y: 16, opacity: 0, duration: 0.3, stagger: 0.04 },
            "-=0.2"
          )
      })
    },
    { scope, dependencies: [name, state.kind], revertOnUpdate: true }
  )

  return (
    <div ref={scope} className="flex w-full flex-col gap-8">
      <div data-animate="heading" className="flex flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList className="text-base">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/" data-nav>
                  Home
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl 2xl:text-6xl">
          {title}
        </h1>
        <AboutCourse declaration={declarationOf(state)} />
        {referenceOf(state).length > 0 && (
          <Button asChild size="lg" variant="outline" className="self-start">
            <Link to={`/courses/${name}/reference`} data-nav>
              <LibraryIcon data-icon="inline-start" />
              Reference
            </Link>
          </Button>
        )}
        {untrusted(state) && <SafeMode />}
      </div>
      <Body state={state} name={name!} retry={retry} />
    </div>
  )
}

/**
 * What the course's course.json says about it (flyingrobots/school#277): its summary, and its author
 * and license as Badges. Only what it declares is shown; a course that declares none shows nothing.
 */
function AboutCourse({ declaration }: { declaration: Declaration | null }) {
  if (declaration === null) return null
  const { summary, author, license } = declaration
  return (
    <>
      {summary !== null && (
        <p data-manifest="summary" className="text-xl text-muted-foreground">
          {summary}
        </p>
      )}
      {(author !== null || license !== null) && (
        <div className="flex min-w-0 flex-wrap gap-2">
          {author !== null && (
            <Badge
              data-manifest="author"
              variant="outline"
              className="h-auto max-w-full text-sm break-words whitespace-normal"
            >
              <UserIcon data-icon="inline-start" />
              <span className="min-w-0">By {author}</span>
            </Badge>
          )}
          {license !== null && (
            <Badge
              data-manifest="license"
              variant="outline"
              className="h-auto max-w-full text-sm break-words whitespace-normal"
            >
              <ScaleIcon data-icon="inline-start" />
              <span className="min-w-0">License: {license}</span>
            </Badge>
          )}
        </div>
      )}
    </>
  )
}

/**
 * The note on an untrusted course (flyingrobots/school#210): School serves its files sandboxed, so
 * they can't run scripts. Neutral, not a warning: a note, not an alert, in the card's colours.
 */
function SafeMode() {
  return (
    <Alert role="note" data-trust="untrusted" className="text-base">
      <ShieldCheckIcon />
      <AlertTitle className="text-lg">Shown in safe mode</AlertTitle>
      <AlertDescription className="text-base">
        This course is shown in safe mode: its pages can’t run scripts. Its
        lessons and quizzes work as usual.
      </AlertDescription>
    </Alert>
  )
}

function Body({
  state,
  name,
  retry,
}: {
  state: State
  name: string
  retry: () => void
}) {
  switch (state.kind) {
    case "loading":
      return (
        <div data-animate="body" className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-lg text-muted-foreground">
            <Spinner className="size-5" />
            Loading the lessons
          </div>
          <div className={grid}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-36 w-full" />
            ))}
          </div>
        </div>
      )
    case "missing":
      return (
        <Empty data-animate="body" className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileQuestionIcon />
            </EmptyMedia>
            <EmptyTitle className="text-2xl">
              There is no course called {name}
            </EmptyTitle>
            <EmptyDescription className="text-lg">
              Check the address, or pick a course from the sidebar.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild size="lg">
              <Link to="/" data-nav>
                Go home
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      )
    case "unreadable":
      return (
        <div data-animate="body">
          <Alert variant="destructive" className="text-base">
            <TriangleAlertIcon />
            <AlertTitle className="text-lg">
              This course could not be read
            </AlertTitle>
            <AlertDescription className="text-base">
              {state.reason}
            </AlertDescription>
          </Alert>
        </div>
      )
    case "unloaded":
      return (
        <div data-animate="body">
          <Alert variant="destructive" className="text-base">
            <TriangleAlertIcon />
            <AlertTitle className="text-lg">
              This course could not be loaded
            </AlertTitle>
            <AlertDescription className="text-base">
              School's server did not answer as expected. Check that it is
              running, then try again.
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={retry} data-nav>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )
    case "ready":
      if (state.course.lessons.length === 0)
        return (
          <Empty data-animate="body" className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon />
              </EmptyMedia>
              <EmptyTitle className="text-2xl">No lessons yet</EmptyTitle>
              <EmptyDescription className="text-lg">
                Lessons show up here once they are added to the course's lessons
                folder.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      return (
        <div className="flex flex-col gap-4">
          {/* Each lesson is a link, so the group is not announced as a list of non-items. */}
          <ItemGroup data-animate="body" role={undefined} className={grid}>
            {state.course.lessons.map((l) => (
              <LessonItem key={l.id} course={name} lesson={l} />
            ))}
          </ItemGroup>
          <p
            data-key-hint
            className="flex items-center gap-2 text-base text-muted-foreground"
          >
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            move between lessons,
            <Kbd>↵</Kbd>
            opens one
          </p>
        </div>
      )
  }
}

function LessonItem({ course, lesson }: { course: string; lesson: Lesson }) {
  const done = lesson.quizzes > 0 && lesson.answeredCorrectly === lesson.quizzes
  return (
    <Item asChild variant="outline" className="items-start p-5">
      <Link
        to={`/courses/${course}/lessons/${lesson.id}`}
        data-nav
        data-lesson={lesson.id}
      >
        <ItemContent className="gap-2">
          <ItemTitle className="text-xl">{lesson.title}</ItemTitle>
          {lesson.subtitle ? (
            <ItemDescription className="text-base">
              {lesson.subtitle}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemFooter className="flex-col items-start gap-2">
          <Badge
            variant={
              done ? "default" : lesson.quizzes === 0 ? "outline" : "secondary"
            }
            className="h-auto text-sm"
          >
            {done && <CheckIcon data-icon="inline-start" />}
            {progressWords(lesson)}
          </Badge>
          <HoldingBadges words={lessonHoldingWords(lesson)} />
        </ItemFooter>
      </Link>
    </Item>
  )
}
