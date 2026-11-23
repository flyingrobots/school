// The lesson page (flyingrobots/school#42): plays a lesson's blocks and records every answer and
// explanation through the API. It composes registry blocks only: @flyingrobots/lesson for the
// frame and the reading blocks, quiz, explain and nest for the rest. On load it shows what the
// encounter already holds; every verdict and grading on screen is the server's.
// It records every exposure it shows (flyingrobots/school#51): the blocks say when they show help,
// and each showing is sent once, under its own id, before the block's next submission.
// Every submission and exposure goes through the outbox (flyingrobots/school#28), in the order it
// was made: while School cannot be reached, a block shows its submission as not sent yet, and it
// is sent when School is back, even from a later tab. The outbox is never read as progress.
import * as React from "react"
import { Link, useParams } from "react-router"

import { Explain, ExplainSaveError, type ExplainPending } from "@/components/explain"
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
import { Quiz, QuizAnswerError, type QuizPending, type QuizVerdict } from "@/components/quiz"
import { Button } from "@/components/ui/button"
import { NotKept, outbox, Refused, type Waiting } from "@/lib/outbox"
import * as api from "@/lib/school-api"

const renderLink = ({ href, ...props }: LessonLinkProps) => <Link to={href} {...props} />

type Load =
  | { status: "loading" }
  | { status: "ready"; lesson: api.LessonReply; waiting: Waiting[] }
  | { status: "missing" | "failed"; message: string }

function useLesson(course: string, lesson: string) {
  const [load, setLoad] = React.useState<Load>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const abort = new AbortController()
    // What waits in the outbox is read before the record, so a submission delivered in between is
    // still shown (pending, then settled at once) rather than in neither.
    const opened = async () => {
      const waiting = await outbox().waiting()
      const reply = await api.openLesson(course, lesson, abort.signal)
      return { reply, waiting: waiting.filter((w) => w.body.encounterId === reply.encounterId) }
    }
    opened().then(
      ({ reply, waiting }) => setLoad({ status: "ready", lesson: reply, waiting }),
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

/**
 * What the outbox still holds for this encounter, by block: the latest waiting answer and
 * explanation, shown as not sent yet until School answers them. Never a verdict of its own.
 */
function waitingByBlock(waiting: Waiting[]) {
  const answers = new Map<string, QuizPending>()
  const explanations = new Map<string, ExplainPending>()
  for (const w of waiting) {
    if (w.kind === "answer") answers.set(w.body.blockId, { choiceId: w.body.choiceId, verdict: w.settled.catch((e: unknown) => Promise.reject(answerError(e))) })
    else explanations.set(w.body.blockId, { text: w.body.text, saved: w.settled.catch((e: unknown) => Promise.reject(explanationError(e))) })
  }
  return { answers, explanations }
}

/** Why a submission was not recorded, in the learner's words. */
function refusal(what: "answer" | "explanation", e: unknown) {
  if (e instanceof Refused)
    return `School refused this ${what} (${e.reason}), so it was not recorded and will not be sent again. ${what === "answer" ? "Choose again" : "Save it again"} to send a new one.`
  if (e instanceof NotKept)
    return `School could not be reached, and this browser cannot keep your ${what} to send later (private browsing can prevent it). It was not recorded. Try again when School is back.`
  return null
}
const answerError = (e: unknown) => {
  const m = refusal("answer", e)
  return m === null ? e : new QuizAnswerError(m)
}
const explanationError = (e: unknown) => {
  const m = refusal("explanation", e)
  return m === null ? e : new ExplainSaveError(m)
}

/** Records one showing of help, through the outbox, ahead of the block's next submission. */
const show = (encounterId: string, blockId: string, kind: api.ExposureKind) =>
  outbox().record({ exposureId: api.uuid(), encounterId, blockId, kind })

type Play = {
  encounterId: string
  /** When the lesson was shown, for each submission's `ms`. */
  shown: number
  answers: Map<string, QuizVerdict>
  explanations: Map<string, api.Explanation>
  pending: ReturnType<typeof waitingByBlock>
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
            pending={play.pending.answers.get(b.id) ?? null}
            onWhyShown={() => show(play.encounterId, b.id, "feedback")}
            onAnswer={(choiceId, progress) => {
              const body = { submissionId: api.uuid(), encounterId: play.encounterId, blockId: b.id, choiceId, ms: sinceShown(play) }
              return outbox()
                .submit({ kind: "answer", id: body.submissionId, body }, progress)
                .catch((e: unknown) => Promise.reject(answerError(e)))
            }}
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
            pending={play.pending.explanations.get(b.id) ?? null}
            onModelShown={() => show(play.encounterId, b.id, "model-answer")}
            onSourceOpened={() => show(play.encounterId, b.id, "reference")}
            onSave={(text, progress) => {
              const body = { submissionId: api.uuid(), encounterId: play.encounterId, blockId: b.id, text, ms: sinceShown(play) }
              return outbox()
                .submit({ kind: "explanation", id: body.submissionId, body }, progress)
                .catch((e: unknown) => Promise.reject(explanationError(e)))
            }}
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

function Played({ course, lesson, waiting }: { course: string; lesson: api.LessonReply; waiting: Waiting[] }) {
  const page = lesson.lesson
  const [shown] = React.useState(() => Date.now())
  const play = React.useMemo<Play>(
    () => ({ encounterId: lesson.encounterId, shown, ...held(lesson), pending: waitingByBlock(waiting) }),
    [lesson, waiting, shown]
  )
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
      return <Played course={course} lesson={load.lesson} waiting={load.waiting} />
  }
}

export function LessonPage() {
  const { course, lesson } = useParams()
  // A new lesson is a new page: no block keeps the state of the one before.
  return <LessonRoute key={`${course}/${lesson}`} course={course!} lesson={lesson!} />
}
