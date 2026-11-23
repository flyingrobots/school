import * as React from "react"
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@ui-sdk/react/accordion"
import { Button as ButtonBehavior } from "@ui-sdk/react/button"
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible"
import {
  Field as FieldBehavior,
  FieldDescription as FieldDescriptionBehavior,
  FieldLabel as FieldLabelBehavior,
} from "@ui-sdk/react/field"
import { useShortcut, useShortcutHint } from "@ui-sdk/react/shortcuts"
import { Textarea as TextareaBehavior } from "@ui-sdk/react/textarea"
import { BotIcon, ChevronDownIcon, PencilIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

// An explain block: the learner writes an explanation, saves it through a callback, and asks for
// a grading through another. It shows the grading it is given and never grades anything itself.
// The model answer stays out of the DOM until the explanation is saved. Every string from a model
// (notes, summary, quotes, errors) is rendered as text, never as HTML.
// Behaviour (field and label, textarea and its submit keys, buttons, disclosures, shortcuts) is
// ui-sdk's; the look is stock shadcn parts passed as `render`, or shadcn's own classes.
// A saved explanation can be revised: the learner writes again, starting from the saved text, and
// saves a new explanation. `onModelShown` and `onSourceOpened` say when the model answer is shown
// and when a source is opened, once per showing, so a page can record the help it gave.
// An explanation the page keeps to send later (an outbox) is `queued`: it shows as not sent yet,
// with a spinner, and the model answer stays hidden until the server has stored it.
// ExplainReadOnly shows only the prompt, as a slides view does: nothing to write or save, and
// neither the model answer nor the sources, so it shows no help to record.

/** Material an explanation is graded against. `id` is what a contradiction's quote cites. */
export type ExplainSource = { id: string; title: string; text: string }

export type ExplainVerdict = "meets" | "partly" | "misses"
export type ExplainCriterion = { verdict: ExplainVerdict; note: string }
export type ExplainContradiction = {
  source_id: string
  quote: string
  note: string
  /** Whether the quote was found, word for word, in the source it cites. */
  quote_verified: boolean
}

/** What a grader found, as the server checked it. */
export type ExplainFindings = {
  /** Too short, off-topic or empty to judge: the verdicts are then ignored. */
  insufficient_evidence: boolean
  fidelity: ExplainCriterion
  completeness: ExplainCriterion
  accessibility: ExplainCriterion
  contradictions: ExplainContradiction[]
  summary: string
}

/** One grading attempt. A failure is never a verdict on the explanation. */
export type ExplainGrading = {
  id: number
  model: string | null
  supersedes: number | null
  at: string
} & (
  | { status: "succeeded"; findings: ExplainFindings }
  | { status: "failed"; error: string }
)

/** A saved explanation and its latest grading, if any. */
export type ExplainExplanation = {
  submissionId: string
  blockId: string
  text: string
  at: string
  grading: ExplainGrading | null
}

/**
 * Where an explain block stands.
 * - `empty`: nothing saved yet; the learner is writing.
 * - `saving`: the explanation is with the server.
 * - `queued`: the server could not be reached; the explanation is kept and will be sent. Nothing
 *   can be edited, and the model answer stays hidden, until the server stores it.
 * - `saved`: stored, not graded; the model answer is shown.
 * - `grading`: a grading request is with the server.
 * - `graded`: the grader's findings.
 * - `failed`: the grading did not finish; it can be retried.
 */
export type ExplainState =
  | { status: "empty" }
  | { status: "saving" | "queued"; text: string }
  | { status: "saved" | "grading"; explanation: ExplainExplanation }
  | {
      status: "graded"
      explanation: ExplainExplanation
      findings: ExplainFindings
    }
  | { status: "failed"; explanation: ExplainExplanation; error: string }

type ExplainContent = {
  id: string
  prompt: string
  /** The model answer, shown only once the explanation is saved. */
  model: string
  sources: ExplainSource[]
}

const CRITERIA = [
  {
    key: "fidelity",
    title: "Fidelity",
    question: "Does it agree with the sources?",
  },
  {
    key: "completeness",
    title: "Completeness",
    question: "Does it cover what matters?",
  },
  {
    key: "accessibility",
    title: "Accessibility",
    question: "Would a newcomer follow it?",
  },
] as const

const VERDICT: Record<
  ExplainVerdict,
  { label: string; variant: "default" | "secondary" | "destructive" }
> = {
  meets: { label: "Meets", variant: "default" },
  partly: { label: "Partly meets", variant: "secondary" },
  misses: { label: "Misses", variant: "destructive" },
}

const STATUS: Record<
  ExplainState["status"],
  {
    label: string
    variant: "secondary" | "outline" | "default" | "destructive"
  } | null
> = {
  empty: null,
  saving: { label: "Saving", variant: "secondary" },
  queued: { label: "Not sent yet", variant: "secondary" },
  saved: { label: "Saved", variant: "outline" },
  grading: { label: "Grading", variant: "secondary" },
  graded: { label: "Graded", variant: "default" },
  failed: { label: "Not graded", variant: "destructive" },
}

const MAX_LENGTH = 10_000
const SAVE_KEYS = "mod+enter"
const GRADE_KEYS = "g"
const REVISE_KEYS = "r"

/** The state a saved explanation resumes in. */
export function explainStateOf(explanation: ExplainExplanation): ExplainState {
  const g = explanation.grading
  if (g === null) return { status: "saved", explanation }
  if (g.status === "succeeded")
    return { status: "graded", explanation, findings: g.findings }
  return { status: "failed", explanation, error: g.error }
}

const canGrade = (state: ExplainState) =>
  state.status === "saved" || state.status === "failed"
const canRevise = (state: ExplainState) =>
  state.status === "saved" ||
  state.status === "graded" ||
  state.status === "failed"

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

/** The explain block as given: renders any state and offers only the actions that state allows. */
export function ExplainView({
  id,
  prompt,
  model,
  sources,
  state,
  draft,
  error,
  onDraftChange,
  onSave,
  onGrade,
  onRevise,
  onModelShown,
  onSourceOpened,
}: ExplainContent & {
  state: ExplainState
  /** The text being written, while `empty`. */
  draft: string
  /** Shown when the last save did not reach the server. */
  error?: string
  onDraftChange: (text: string) => void
  onSave: () => void
  onGrade: () => void
  /** Starts writing again from the saved explanation. No Revise action is offered without it. */
  onRevise?: () => void
  /** Called once each time the model answer is shown. */
  onModelShown?: () => void
  /** Called once each time a source is opened, with its id. */
  onSourceOpened?: (sourceId: string) => void
}) {
  const sending = state.status === "saving" || state.status === "queued"
  const writing = state.status === "empty" || sending
  const text =
    state.status === "empty"
      ? draft
      : "text" in state
        ? state.text
        : state.explanation.text
  const blank = text.trim() === ""
  const status = STATUS[state.status]

  const root = React.useRef<HTMLDivElement>(null)
  const focusedHere = () =>
    root.current?.contains(document.activeElement) ?? false
  useShortcut(GRADE_KEYS, onGrade, {
    when: () => focusedHere() && canGrade(state),
    description: "Get AI feedback",
  })
  useShortcut(REVISE_KEYS, () => onRevise?.(), {
    when: () => focusedHere() && canRevise(state) && onRevise !== undefined,
    description: "Revise your explanation",
  })
  const saveHint = useShortcutHint(SAVE_KEYS)
  const gradeHint = useShortcutHint(GRADE_KEYS)
  const reviseHint = useShortcutHint(REVISE_KEYS)
  useShowing(!writing, onModelShown)
  const opened = React.useRef<string[]>([])
  const revisable = onRevise !== undefined && !writing

  return (
    <Card
      data-explain="root"
      data-explain-id={id}
      data-state={state.status}
      aria-busy={sending || state.status === "grading"}
      ref={root}
      className="w-full"
    >
      <CardHeader>
        <CardTitle className="text-2xl">{prompt}</CardTitle>
        <CardDescription className="text-base">
          {state.status === "queued"
            ? "Not saved yet. Your explanation is kept and is sent when School can be reached."
            : writing
              ? "Write it in your own words. The model answer appears once you save."
              : "Compare yours with the model answer, then ask for feedback."}
        </CardDescription>
        {status && (
          <CardAction>
            <Badge variant={status.variant} aria-live="polite">
              {status.label}
            </Badge>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="@container flex flex-col gap-6">
        {writing ? (
          <FieldBehavior name={`explain-${id}`} render={<Field />}>
            <FieldLabelBehavior render={<FieldLabel className="text-lg" />}>
              Your explanation
            </FieldLabelBehavior>
            <TextareaBehavior
              data-explain="draft"
              render={<Textarea className="min-h-40 text-lg md:text-lg" />}
              placeholder="In your own words…"
              value={text}
              maxLength={MAX_LENGTH}
              disabled={sending}
              submitShortcut={SAVE_KEYS}
              onValueChange={onDraftChange}
              onSubmit={() => {
                if (state.status === "empty" && !blank) onSave()
              }}
            />
            <FieldDescriptionBehavior
              render={<FieldDescription className="text-base" />}
            >
              Press {saveHint.text} to save. Enter starts a new line.
            </FieldDescriptionBehavior>
          </FieldBehavior>
        ) : (
          <div className="grid gap-4 @2xl:grid-cols-2">
            <Item
              data-explain="explanation"
              variant="outline"
              className="items-start"
            >
              <ItemContent>
                <ItemTitle className="text-base">Your explanation</ItemTitle>
                <p className="text-lg whitespace-pre-wrap">{text}</p>
              </ItemContent>
            </Item>
            <Collapsible defaultOpen>
              <Item
                data-explain="model"
                variant="muted"
                className="items-start"
              >
                <ItemContent>
                  <CollapsibleTrigger
                    render={
                      <Button
                        variant="ghost"
                        className="group/model -ml-2.5 w-fit text-base"
                      />
                    }
                  >
                    Model answer
                    <ChevronDownIcon
                      data-icon="inline-end"
                      className="transition-transform group-aria-expanded/model:rotate-180"
                    />
                  </CollapsibleTrigger>
                  <CollapsiblePanel className="text-lg whitespace-pre-wrap">
                    {model}
                  </CollapsiblePanel>
                </ItemContent>
              </Item>
            </Collapsible>
          </div>
        )}

        {!writing && sources.length > 0 && (
          <Accordion
            data-explain="sources"
            multiple
            className="flex w-full flex-col"
            onValueChange={(open: string[]) => {
              for (const sourceId of open)
                if (!opened.current.includes(sourceId))
                  onSourceOpened?.(sourceId)
              opened.current = open
            }}
          >
            {sources.map((s) => (
              <AccordionItem
                key={s.id}
                value={s.id}
                className="not-last:border-b"
              >
                <AccordionHeader className="flex">
                  <AccordionTrigger className="group/source flex flex-1 items-center justify-between rounded-lg border border-transparent py-2.5 text-left text-base font-medium outline-none hover:underline focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                    {s.title}
                    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/source:rotate-180" />
                  </AccordionTrigger>
                </AccordionHeader>
                <AccordionPanel className="pb-2.5 text-base whitespace-pre-wrap">
                  {s.text}
                </AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>
        )}

        {state.status === "grading" && <FindingsLoading />}
        {state.status === "graded" && (
          <Findings findings={state.findings} sources={sources} />
        )}

        {state.status === "failed" && (
          <Alert data-explain="failed" variant="destructive">
            <AlertTitle className="text-base">
              The feedback did not finish
            </AlertTitle>
            <AlertDescription className="text-base">
              <p>
                This is not a verdict on your explanation. Your explanation is
                saved; try again.
              </p>
              <p>{state.error}</p>
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert data-explain="error" variant="destructive">
            <AlertDescription className="text-base">{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      {(state.status !== "graded" || revisable) && (
        <CardFooter className="flex-wrap justify-end gap-2">
          {revisable && (
            <ButtonBehavior
              data-explain="revise"
              render={<Button size="lg" variant="outline" />}
              disabled={!canRevise(state)}
              aria-keyshortcuts={reviseHint.ariaKeyshortcuts}
              onClick={() => {
                if (canRevise(state)) onRevise?.()
              }}
            >
              <PencilIcon data-icon="inline-start" />
              Revise
              <Kbd data-icon="inline-end">{reviseHint.text}</Kbd>
            </ButtonBehavior>
          )}
          {state.status === "graded" ? null : writing ? (
            <ButtonBehavior
              data-explain="save"
              render={<Button size="lg" />}
              disabled={sending || blank}
              aria-keyshortcuts={saveHint.ariaKeyshortcuts}
              onClick={() => {
                if (state.status === "empty" && !blank) onSave()
              }}
            >
              {sending && <Spinner data-icon="inline-start" />}
              Save
              <Kbd data-icon="inline-end">{saveHint.text}</Kbd>
            </ButtonBehavior>
          ) : (
            <ButtonBehavior
              data-explain="grade"
              render={<Button size="lg" />}
              disabled={!canGrade(state)}
              aria-keyshortcuts={gradeHint.ariaKeyshortcuts}
              onClick={() => {
                if (canGrade(state)) onGrade()
              }}
            >
              {state.status === "grading" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <BotIcon data-icon="inline-start" />
              )}
              {state.status === "failed"
                ? "Retry AI feedback"
                : "Get AI feedback"}
              <Kbd data-icon="inline-end">{gradeHint.text}</Kbd>
            </ButtonBehavior>
          )}
        </CardFooter>
      )}
    </Card>
  )
}

/**
 * The explain block to read only: its prompt and nothing else. No field, no Save, no model answer,
 * no sources and no callback, so nothing it shows can be recorded.
 */
export function ExplainReadOnly({
  id,
  prompt,
}: Pick<ExplainContent, "id" | "prompt">) {
  return (
    <Card
      data-explain="root"
      data-explain-id={id}
      data-state="empty"
      data-read-only
      className="w-full"
    >
      <CardHeader>
        <CardTitle className="text-2xl">{prompt}</CardTitle>
        <CardDescription className="text-base">
          To read only: nothing is written or saved here.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">Read only</Badge>
        </CardAction>
      </CardHeader>
    </Card>
  )
}

function FindingsLoading() {
  return (
    <div data-explain="findings-loading" className="flex flex-col gap-4">
      <div className="grid gap-4 @3xl:grid-cols-3">
        {CRITERIA.map((c) => (
          <Skeleton key={c.key} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-6 w-2/3" />
    </div>
  )
}

function Findings({
  findings,
  sources,
}: {
  findings: ExplainFindings
  sources: ExplainSource[]
}) {
  const titleOf = (sourceId: string) =>
    sources.find((s) => s.id === sourceId)?.title ?? sourceId
  return (
    <div data-explain="findings" className="flex flex-col gap-6">
      <Separator />
      {findings.insufficient_evidence ? (
        <Alert data-explain="insufficient">
          <AlertTitle className="text-base">Not enough to judge</AlertTitle>
          <AlertDescription className="text-base">
            The explanation was too short or off the topic for feedback. Try
            writing more next time.
          </AlertDescription>
        </Alert>
      ) : (
        <ItemGroup className="grid gap-4 @3xl:grid-cols-3">
          {CRITERIA.map((c) => {
            const { verdict, note } = findings[c.key]
            const v = VERDICT[verdict]
            return (
              <Item
                key={c.key}
                data-explain="criterion"
                data-criterion={c.key}
                data-verdict={verdict}
                variant="outline"
                className="items-start"
              >
                <ItemContent>
                  <ItemTitle className="flex-wrap text-lg">
                    {c.title}
                    <Badge variant={v.variant}>{v.label}</Badge>
                  </ItemTitle>
                  <ItemDescription className="text-sm">
                    {c.question}
                  </ItemDescription>
                  <p className="text-base">{note}</p>
                </ItemContent>
              </Item>
            )
          })}
        </ItemGroup>
      )}

      <Alert data-explain="summary">
        <AlertTitle className="text-base">Summary</AlertTitle>
        <AlertDescription className="text-base">
          {findings.summary}
        </AlertDescription>
      </Alert>

      {findings.contradictions.length > 0 && (
        <ItemGroup className="gap-4">
          <ItemTitle className="text-lg">
            Where it disagrees with the sources
          </ItemTitle>
          {findings.contradictions.map((c, i) => (
            <Item
              key={i}
              data-explain="contradiction"
              data-verified={String(c.quote_verified)}
              variant="outline"
            >
              <ItemContent>
                <ItemTitle className="flex-wrap text-base">
                  {titleOf(c.source_id)}
                  {!c.quote_verified && (
                    <Badge variant="outline">
                      Quote not found in the source
                    </Badge>
                  )}
                </ItemTitle>
                <blockquote className="border-l-2 pl-4 text-base text-muted-foreground italic">
                  {c.quote}
                </blockquote>
                <p className="text-base">{c.note}</p>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  )
}

/**
 * A save refused in words the learner should read. When `onSave` (or a pending save) rejects with
 * one, the block shows its message instead of its own "not saved".
 */
export class ExplainSaveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExplainSaveError"
  }
}

const NOT_SAVED = "Your explanation was not saved. Try again."
const saveErrorText = (e: unknown) =>
  e instanceof ExplainSaveError ? e.message : NOT_SAVED

/** An explanation written earlier that the server has not stored yet, and the stored explanation when it is. */
export type ExplainPending = {
  text: string
  saved: Promise<ExplainExplanation>
}

/**
 * The explain block, saving through `onSave` and grading through `onGrade`. One request at a time:
 * while a save or a grading is in flight, or a save is queued, no other can be sent, even from the
 * same tick.
 */
export function Explain({
  onSave,
  onGrade,
  saved,
  pending,
  onModelShown,
  onSourceOpened,
  ...content
}: ExplainContent & {
  /**
   * Stores the explanation; resolves with it as saved, or rejects if it was not stored (with an
   * `ExplainSaveError` to say why in its own words). Calls `queued` if the server could not be
   * reached and the explanation is kept to send later; the promise then settles when it is stored.
   */
  onSave: (
    text: string,
    progress: { queued: () => void }
  ) => Promise<ExplainExplanation>
  /** Asks the server to grade the saved submission; resolves with the explanation and its new grading. */
  onGrade: (submissionId: string) => Promise<ExplainExplanation>
  /** The explanation the record already holds for this block, read when the block first renders. */
  saved?: ExplainExplanation | null
  /** An explanation kept from earlier that the server has not stored yet; it wins over `saved`. Read on first render. */
  pending?: ExplainPending | null
  /** Called once each time the model answer is shown: when an explanation is saved, or first renders saved. */
  onModelShown?: () => void
  /** Called once each time a source is opened, with its id. */
  onSourceOpened?: (sourceId: string) => void
}) {
  const [first] = React.useState(() => ({
    pending,
    before: saved
      ? explainStateOf(saved)
      : ({ status: "empty" } as ExplainState),
  }))
  const [state, setState] = React.useState<ExplainState>(() =>
    pending ? { status: "queued", text: pending.text } : first.before
  )
  // A refused pending explanation goes back to being written, so nothing typed is lost.
  const [draft, setDraft] = React.useState("")
  const [error, setError] = React.useState<string>()
  // The guards read this, not `state`: a second click in the same tick sees the rendered state.
  const current = React.useRef(state)

  const move = (next: ExplainState) => {
    current.current = next
    setState(next)
  }

  React.useEffect(() => {
    const p = first.pending
    if (!p) return
    let live = true
    p.saved.then(
      (explanation) => {
        if (live && current.current.status === "queued")
          move(explainStateOf(explanation))
      },
      (e: unknown) => {
        if (!live || current.current.status !== "queued") return
        setDraft(p.text)
        move({ status: "empty" })
        setError(saveErrorText(e))
      }
    )
    return () => {
      live = false
    }
  }, [first])

  const save = () => {
    const text = draft
    if (current.current.status !== "empty" || text.trim() === "") return
    setError(undefined)
    const sent: ExplainState = { status: "saving", text }
    move(sent)
    const queued = () => {
      if (current.current === sent) move({ status: "queued", text })
    }
    onSave(text, { queued }).then(
      (explanation) => move(explainStateOf(explanation)),
      (e: unknown) => {
        move({ status: "empty" })
        setError(saveErrorText(e))
      }
    )
  }

  const grade = () => {
    const before = current.current
    if (!canGrade(before) || !("explanation" in before)) return
    const { explanation } = before
    move({ status: "grading", explanation })
    onGrade(explanation.submissionId).then(
      (next) =>
        move(
          next.grading === null
            ? {
                status: "failed",
                explanation: next,
                error: "No feedback came back.",
              }
            : explainStateOf(next)
        ),
      () =>
        move({
          status: "failed",
          explanation,
          error: "The request for feedback did not reach the server.",
        })
    )
  }

  /** Writes again from the saved explanation; saving then stores a new one. The old one is kept. */
  const revise = () => {
    const before = current.current
    if (!canRevise(before) || !("explanation" in before)) return
    setDraft(before.explanation.text)
    setError(undefined)
    move({ status: "empty" })
  }

  return (
    <ExplainView
      {...content}
      state={state}
      draft={draft}
      error={error}
      onDraftChange={setDraft}
      onSave={save}
      onGrade={grade}
      onRevise={revise}
      onModelShown={onModelShown}
      onSourceOpened={onSourceOpened}
    />
  )
}
