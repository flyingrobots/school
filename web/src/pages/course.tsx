// The course page (flyingrobots/school#40): the course's lessons, each with how many of its quizzes
// the learner has answered correctly, from GET /api/courses/:course. Progress is told in words,
// never as a percentage or a score. Composed only of stock shadcn components.
import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  BookOpenIcon,
  CheckIcon,
  FileQuestionIcon,
  LibraryIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Link, useParams } from "react-router"

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
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
import type { Course, CourseLoad } from "@/lib/school-api"

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
        {referenceOf(state).length > 0 && (
          <Button asChild size="lg" variant="outline" className="self-start">
            <Link to={`/courses/${name}/reference`} data-nav>
              <LibraryIcon data-icon="inline-start" />
              Reference
            </Link>
          </Button>
        )}
      </div>
      <Body state={state} name={name!} retry={retry} />
    </div>
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
          <p className="flex items-center gap-2 text-base text-muted-foreground">
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
        <ItemFooter>
          <Badge
            variant={
              done ? "default" : lesson.quizzes === 0 ? "outline" : "secondary"
            }
            className="h-auto text-sm"
          >
            {done && <CheckIcon data-icon="inline-start" />}
            {progressWords(lesson)}
          </Badge>
        </ItemFooter>
      </Link>
    </Item>
  )
}
