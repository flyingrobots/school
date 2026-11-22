import * as React from "react"

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

export type QuizChoice = { id: string; text: string }

/** What the server said about one answer. */
export type QuizVerdict = { choiceId: string; correct: boolean }

/**
 * Where a quiz stands.
 * - `unanswered`: nothing sent yet; every choice can be chosen.
 * - `in-flight`: one answer is with the server; nothing can be chosen.
 * - `wrong`: the server said no; the other choices can be tried.
 * - `right`: the server said yes just now; nothing more can be chosen.
 * - `settled`: the record already held a right answer; nothing can be chosen.
 */
export type QuizState =
  | { status: "unanswered" }
  | { status: "in-flight" | "wrong" | "right" | "settled"; choiceId: string }

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
  wrong: { label: "Not quite", variant: "destructive" },
  right: { label: "Correct", variant: "default" },
  settled: { label: "Answered", variant: "outline" },
}

/** Whether `choiceId` can be chosen in `state`. */
function canChoose(state: QuizState, choiceId: string): boolean {
  if (state.status === "unanswered") return true
  return state.status === "wrong" && state.choiceId !== choiceId
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
}: QuizContent & {
  state: QuizState
  /** Shown when the last answer did not reach the server. */
  error?: string
  onChoose: (choiceId: string) => void
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

  return (
    <Card data-quiz="root" data-quiz-id={id} data-state={state.status} aria-busy={state.status === "in-flight"} onKeyDown={onKeyDown} className="w-full">
      <CardHeader>
        <CardTitle className="text-2xl">{q}</CardTitle>
        <CardDescription className="text-base">
          {state.status === "wrong" ? "Not quite. Try another answer." : done ? null : "Choose an answer, or press its number."}
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
        {choices.map((c, i) => {
          const mine = c.id === chosen
          const verdict = !mine ? undefined : state.status === "wrong" ? "wrong" : done ? "right" : undefined
          const key = KEYS[i]
          return (
            <Button
              key={c.id}
              data-quiz="choice"
              data-choice={c.id}
              data-verdict={verdict}
              variant={verdict === "right" ? "default" : verdict === "wrong" ? "destructive" : mine ? "secondary" : "outline"}
              size="lg"
              aria-pressed={mine}
              aria-keyshortcuts={key}
              disabled={!canChoose(state, c.id)}
              onClick={() => choose(c.id)}
              // The chosen answer stays at full strength while the others are disabled around it.
              className={`h-auto justify-start py-3 text-left text-lg whitespace-normal${mine ? " disabled:opacity-100" : ""}`}
            >
              {mine && state.status === "in-flight" ? <Spinner data-icon="inline-start" /> : key && <Kbd data-icon="inline-start">{key}</Kbd>}
              {c.text}
            </Button>
          )
        })}
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

function initial(recorded: QuizVerdict | null | undefined): QuizState {
  if (!recorded) return { status: "unanswered" }
  return { status: recorded.correct ? "settled" : "wrong", choiceId: recorded.choiceId }
}

/**
 * The quiz, answering through `onAnswer`. One answer at a time: while one is in flight, no other
 * can be sent, even from the same tick. A right answer, given now or already `recorded`, is final.
 */
export function Quiz({
  onAnswer,
  recorded,
  ...content
}: QuizContent & {
  /** Sends one answer; resolves with the server's verdict, or rejects if it was not recorded. */
  onAnswer: (choiceId: string) => Promise<{ correct: boolean }>
  /** The latest answer the record holds for this quiz, read when the quiz first renders. */
  recorded?: QuizVerdict | null
}) {
  const [state, setState] = React.useState<QuizState>(() => initial(recorded))
  const [error, setError] = React.useState<string>()
  // The guard reads this, not `state`: a second click in the same tick sees the rendered state.
  const current = React.useRef(state)

  const move = (next: QuizState) => {
    current.current = next
    setState(next)
  }

  const answer = (choiceId: string) => {
    const before = current.current
    if (!canChoose(before, choiceId)) return
    setError(undefined)
    move({ status: "in-flight", choiceId })
    onAnswer(choiceId).then(
      ({ correct }) => move({ status: correct ? "right" : "wrong", choiceId }),
      () => {
        move(before)
        setError("That answer was not recorded. Try again.")
      }
    )
  }

  return <QuizView {...content} state={state} error={error} onChoose={answer} />
}
