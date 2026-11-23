import * as React from "react"

import { Radio, RadioGroup } from "@ui-sdk/react/radio"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"

// A multiple-choice quiz that answers through a callback and shows the verdict it is given.
// It never decides correctness: the verdict comes from `onAnswer` (the server) or `recorded`.
// The choices are ui-sdk's radio group (roles, name, roving focus) rendered as shadcn buttons.
// `onWhyShown` says when the explanation is shown, once per showing, so a page can record the
// help it gave. An answer the page keeps to send later (an outbox) is `queued`: it shows as not
// sent yet, with a spinner, until the server's verdict comes back or the server refuses it.

export type QuizChoice = { id: string; text: string }

/** What the server said about one answer. */
export type QuizVerdict = { choiceId: string; correct: boolean }

/**
 * Where a quiz stands.
 * - `unanswered`: nothing sent yet; every choice can be chosen.
 * - `in-flight`: one answer is with the server; nothing can be chosen.
 * - `queued`: the server could not be reached; the answer is kept and will be sent, and nothing
 *   can be chosen until the server answers it.
 * - `wrong`: the server said no; the other choices can be tried.
 * - `right`: the server said yes just now; nothing more can be chosen.
 * - `settled`: the record already held a right answer; nothing can be chosen.
 */
export type QuizState =
  | { status: "unanswered" }
  | { status: "in-flight" | "queued" | "wrong" | "right" | "settled"; choiceId: string }

type QuizContent = {
  id: string
  q: string
  choices: QuizChoice[]
  why: string
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

const STATUS: Record<QuizState["status"], { label: string; variant: "secondary" | "destructive" | "default" | "outline" } | null> = {
  unanswered: null,
  "in-flight": { label: "Checking", variant: "secondary" },
  queued: { label: "Not sent yet", variant: "secondary" },
  wrong: { label: "Not quite", variant: "destructive" },
  right: { label: "Correct", variant: "default" },
  settled: { label: "Answered", variant: "outline" },
}

/** Whether `choiceId` can be chosen in `state`. */
function canChoose(state: QuizState, choiceId: string): boolean {
  if (state.status === "unanswered") return true
  return state.status === "wrong" && state.choiceId !== choiceId
}

/**
 * Calls `onShown` once each time `shown` turns true, including on the first render. A ref, not
 * state, guards it, so strict mode's second run of the effect calls nothing.
 */
function useShowing(shown: boolean, onShown: (() => void) | undefined) {
  const fired = React.useRef(false)
  const latest = React.useRef(onShown)
  React.useEffect(() => {
    latest.current = onShown
  })
  React.useEffect(() => {
    if (!shown) {
      fired.current = false
      return
    }
    if (fired.current) return
    fired.current = true
    latest.current?.()
  }, [shown])
}

/** The quiz as given: renders any state and offers only the choices that state allows. */
export function QuizView({
  id,
  q,
  choices,
  why,
  state,
  error,
  onChoose,
  onWhyShown,
}: QuizContent & {
  state: QuizState
  /** Shown when the last answer did not reach the server. */
  error?: string
  onChoose: (choiceId: string) => void
  /** Called once each time the explanation (`why`) is shown. */
  onWhyShown?: () => void
}) {
  const choose = (choiceId: string) => {
    if (canChoose(state, choiceId)) onChoose(choiceId)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const at = KEYS.indexOf(event.key)
    const target = choices[at]
    if (at === -1 || target === undefined) return
    event.preventDefault()
    choose(target.id)
  }
  const chosen = state.status === "unanswered" ? undefined : state.choiceId
  const status = STATUS[state.status]
  const done = state.status === "right" || state.status === "settled"
  const title = React.useId()
  useShowing(done, onWhyShown)

  return (
    <Card
      data-quiz="root"
      data-quiz-id={id}
      data-state={state.status}
      aria-busy={state.status === "in-flight" || state.status === "queued"}
      onKeyDown={onKeyDown}
      className="w-full"
    >
      <CardHeader>
        <CardTitle id={title} className="text-2xl">
          {q}
        </CardTitle>
        <CardDescription className="text-base">
          {state.status === "wrong"
            ? "Not quite. Try another answer."
            : state.status === "queued"
              ? "Not saved yet. Your answer is kept and is sent when School can be reached."
              : done
                ? null
                : "Choose an answer, or press its number."}
        </CardDescription>
        {status && (
          <CardAction>
            <Badge variant={status.variant} aria-live="polite">
              {status.label}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <RadioGroup
          aria-labelledby={title}
          value={chosen ?? null}
          onValueChange={(next, details) => {
            // Checking a radio sends the answer, so arrow keys move focus without checking.
            details.cancel()
            if (next !== null && details.reason !== "list-navigation") choose(next)
          }}
          className="flex flex-col gap-2"
        >
        {choices.map((c, i) => {
          const mine = c.id === chosen
          const verdict = !mine ? undefined : state.status === "wrong" ? "wrong" : done ? "right" : undefined
          const key = KEYS[i]
          return (
            <Radio
              key={c.id}
              value={c.id}
              data-quiz="choice"
              data-choice={c.id}
              data-verdict={verdict}
              aria-keyshortcuts={key}
              disabled={!canChoose(state, c.id)}
              render={(props) => (
                <Button
                  {...props}
                  variant={verdict === "right" ? "default" : verdict === "wrong" ? "destructive" : mine ? "secondary" : "outline"}
                  size="lg"
                  // The chosen answer stays at full strength while the others are disabled around it.
                  className={`h-auto justify-start py-3 text-left text-lg whitespace-normal${mine ? " disabled:opacity-100" : ""}`}
                >
                  {mine && (state.status === "in-flight" || state.status === "queued") ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    key && <Kbd data-icon="inline-start">{key}</Kbd>
                  )}
                  {c.text}
                </Button>
              )}
            />
          )
        })}
        </RadioGroup>
        {done && (
          <Alert data-quiz="why" role="status" className="mt-2">
            <AlertTitle className="text-base">Why</AlertTitle>
            <AlertDescription className="text-base">{why}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert data-quiz="error" variant="destructive" className="mt-2">
            <AlertDescription className="text-base">{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * An answer refused in words the learner should read. When `onAnswer` (or a pending verdict)
 * rejects with one, the quiz shows its message instead of its own "not recorded".
 */
export class QuizAnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QuizAnswerError"
  }
}

const NOT_RECORDED = "That answer was not recorded. Try again."
const errorText = (e: unknown) => (e instanceof QuizAnswerError ? e.message : NOT_RECORDED)

/** An answer given earlier that the server has not answered yet, and its verdict when it does. */
export type QuizPending = { choiceId: string; verdict: Promise<{ correct: boolean }> }

function initial(recorded: QuizVerdict | null | undefined, pending: QuizPending | null | undefined): QuizState {
  if (pending) return { status: "queued", choiceId: pending.choiceId }
  if (!recorded) return { status: "unanswered" }
  return { status: recorded.correct ? "settled" : "wrong", choiceId: recorded.choiceId }
}

/**
 * The quiz, answering through `onAnswer`. One answer at a time: while one is in flight or queued,
 * no other can be sent, even from the same tick. A right answer, given now or already `recorded`,
 * is final.
 */
export function Quiz({
  onAnswer,
  recorded,
  pending,
  ...content
}: QuizContent & {
  /**
   * Sends one answer; resolves with the server's verdict, or rejects if it was not recorded (with a
   * `QuizAnswerError` to say why in its own words). Calls `queued` if the server could not be
   * reached and the answer is kept to send later; the promise then settles when it is answered.
   */
  onAnswer: (choiceId: string, progress: { queued: () => void }) => Promise<{ correct: boolean }>
  /** The latest answer the record holds for this quiz, read when the quiz first renders. */
  recorded?: QuizVerdict | null
  /** An answer kept from earlier that the server has not answered yet; it wins over `recorded`. Read on first render. */
  pending?: QuizPending | null
  /** Called once each time the explanation (`why`) is shown. */
  onWhyShown?: () => void
}) {
  const [state, setState] = React.useState<QuizState>(() => initial(recorded, pending))
  const [error, setError] = React.useState<string>()
  // The guard reads this, not `state`: a second click in the same tick sees the rendered state.
  const current = React.useRef(state)
  // Where a refused pending answer returns to: the record as it was before it.
  const [first] = React.useState(() => ({ pending, before: initial(recorded, null) }))

  const move = (next: QuizState) => {
    current.current = next
    setState(next)
  }

  React.useEffect(() => {
    const p = first.pending
    if (!p) return
    let live = true
    p.verdict.then(
      ({ correct }) => {
        if (live && current.current.status === "queued") move({ status: correct ? "right" : "wrong", choiceId: p.choiceId })
      },
      (e: unknown) => {
        if (!live || current.current.status !== "queued") return
        move(first.before)
        setError(errorText(e))
      }
    )
    return () => {
      live = false
    }
  }, [first])

  const answer = (choiceId: string) => {
    const before = current.current
    if (!canChoose(before, choiceId)) return
    setError(undefined)
    const sent: QuizState = { status: "in-flight", choiceId }
    move(sent)
    const queued = () => {
      if (current.current === sent) move({ status: "queued", choiceId })
    }
    onAnswer(choiceId, { queued }).then(
      ({ correct }) => move({ status: correct ? "right" : "wrong", choiceId }),
      (e: unknown) => {
        move(before)
        setError(errorText(e))
      }
    )
  }

  return <QuizView {...content} state={state} error={error} onChoose={answer} />
}
