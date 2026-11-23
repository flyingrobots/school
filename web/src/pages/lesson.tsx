// The lesson page (flyingrobots/school#42): plays a lesson's blocks and records every answer and
// explanation through the API. It composes registry blocks only: @flyingrobots/lesson for the
// frame and the reading blocks, quiz, explain and nest for the rest. On load it shows what the
// encounter already holds; every verdict and grading on screen is the server's.
import * as React from "react"
import { Link, useParams } from "react-router"

import { Explain } from "@/components/explain"
import {
  Lesson,
  LessonAside,
  LessonBlock,
  LessonCard,
  LessonLoading,
  LessonProse,
  LessonQuote,
  LessonSection,
  LessonUnavailable,
  type LessonCrumb,
  type LessonLinkProps,
} from "@/components/lesson"
import { Nest } from "@/components/nest"
import { Quiz, type QuizVerdict } from "@/components/quiz"
import { Button } from "@/components/ui/button"
import * as api from "@/lib/school-api"

const renderLink = ({ href, ...props }: LessonLinkProps) => <Link to={href} {...props} />

type Load =
  | { status: "loading" }
  | { status: "ready"; lesson: api.LessonReply }
  | { status: "missing" | "failed"; message: string }

function useLesson(course: string, lesson: string) {
  const [load, setLoad] = React.useState<Load>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const abort = new AbortController()
    api.openLesson(course, lesson, abort.signal).then(
      (reply) => setLoad({ status: "ready", lesson: reply }),
      (e) => {
        if (abort.signal.aborted) return
        setLoad(e instanceof api.LessonUnavailable ? { status: e.reason, message: e.message } : { status: "failed", message: String(e) })
      }
    )
    return () => abort.abort()
  }, [course, lesson, attempt])
  // The route is keyed by course and lesson, so only a retry needs to go back to loading.
  const retry = () => {
    setLoad({ status: "loading" })
    setAttempt((n) => n + 1)
  }
  return { load, retry }
}

/** What the encounter holds, by block: each quiz's latest answer and each explain block's latest explanation. */
function held(lesson: api.LessonReply) {
  const answers = new Map<string, QuizVerdict>()
  for (const a of lesson.answers) answers.set(a.blockId, { choiceId: a.choiceId, correct: a.correct })
  return { answers, explanations: new Map(lesson.explanations.map((x) => [x.blockId, x])) }
}

type Play = {
  encounterId: string
  /** When the lesson was shown, for each submission's `ms`. */
  shown: number
  answers: Map<string, QuizVerdict>
  explanations: Map<string, api.Explanation>
}

const sinceShown = (play: Play) => Math.max(0, Math.round(Date.now() - play.shown))

function Blocks({ blocks, play, depth }: { blocks: api.Block[]; play: Play; depth: number }) {
  return blocks.map((b, i) => <BlockView key={`${b.id}-${i}`} block={b} play={play} depth={depth} />)
}

function BlockView({ block: b, play, depth }: { block: api.Block; play: Play; depth: number }) {
  switch (b.type) {
    case "page":
      return <Blocks blocks={b.children} play={play} depth={depth} />
    case "section":
      return (
        <LessonSection id={b.id} title={b.title} level={Math.min(depth + 2, 6) as 2 | 3 | 4 | 5 | 6}>
          <Blocks blocks={b.children} play={play} depth={depth + 1} />
        </LessonSection>
      )
    case "prose":
      return <LessonProse id={b.id} html={b.html} />
    case "card":
      return <LessonCard id={b.id} html={b.html} />
    case "quote":
      return <LessonQuote id={b.id} html={b.html} />
    case "aside":
      return <LessonAside id={b.id} html={b.html} />
    case "quiz":
      return (
        <LessonBlock kind="quiz" id={b.id}>
          <Quiz
            id={b.id}
            q={b.q}
            choices={b.choices}
            why={b.why}
            recorded={play.answers.get(b.id) ?? null}
            onAnswer={(choiceId) => api.answer({ encounterId: play.encounterId, blockId: b.id, choiceId, ms: sinceShown(play) })}
          />
        </LessonBlock>
      )
    case "explain":
      return (
        <LessonBlock kind="explain" id={b.id}>
          <Explain
            id={b.id}
            prompt={b.prompt}
            model={b.model}
            sources={b.sources}
            saved={play.explanations.get(b.id) ?? null}
            onSave={(text) => api.saveExplanation({ encounterId: play.encounterId, blockId: b.id, text, ms: sinceShown(play) })}
            onGrade={(submissionId) => api.grade(submissionId)}
          />
        </LessonBlock>
      )
    case "nest":
      return (
        <LessonBlock kind="nest" id={b.id}>
          <Nest id={b.id} root={b.root} />
        </LessonBlock>
      )
  }
}

function Played({ course, lesson }: { course: string; lesson: api.LessonReply }) {
  const page = lesson.lesson
  const [shown] = React.useState(() => Date.now())
  const play = React.useMemo<Play>(() => ({ encounterId: lesson.encounterId, shown, ...held(lesson) }), [lesson, shown])
  const crumbs: LessonCrumb[] = [
    { label: "Home", href: "/" },
    { label: course, href: `/courses/${course}` },
  ]
  const href = (id: string) => `/courses/${course}/lessons/${id}`
  if (page.type !== "page") return null
  const outline = page.children.flatMap((c) => (c.type === "section" ? [{ id: c.id, title: c.title }] : []))
  return (
    <Lesson
      title={page.title}
      subtitle={page.subtitle || undefined}
      crumbs={crumbs}
      outline={outline}
      prev={lesson.prev && { href: href(lesson.prev.id), title: lesson.prev.title }}
      next={lesson.next && { href: href(lesson.next.id), title: lesson.next.title }}
      renderLink={renderLink}
    >
      <Blocks blocks={page.children} play={play} depth={0} />
    </Lesson>
  )
}

function LessonRoute({ course, lesson }: { course: string; lesson: string }) {
  const { load, retry } = useLesson(course, lesson)
  const crumbs: LessonCrumb[] = [
    { label: "Home", href: "/" },
    { label: course, href: `/courses/${course}` },
  ]
  switch (load.status) {
    case "loading":
      return <LessonLoading crumbs={crumbs} renderLink={renderLink} />
    case "missing":
      return (
        <LessonUnavailable
          reason="missing"
          description={load.message}
          crumbs={crumbs}
          renderLink={renderLink}
          action={
            <Button asChild size="lg">
              <Link to={`/courses/${course}`} data-nav="">
                Back to {course}
              </Link>
            </Button>
          }
        />
      )
    case "failed":
      return (
        <LessonUnavailable
          reason="failed"
          description={`${load.message} Nothing was recorded. Check that School is running, then try again.`}
          crumbs={crumbs}
          renderLink={renderLink}
          action={
            <Button size="lg" data-nav="" onClick={retry}>
              Try again
            </Button>
          }
        />
      )
    case "ready":
      return <Played course={course} lesson={load.lesson} />
  }
}

export function LessonPage() {
  const { course, lesson } = useParams()
  // A new lesson is a new page: no block keeps the state of the one before.
  return <LessonRoute key={`${course}/${lesson}`} course={course!} lesson={lesson!} />
}
