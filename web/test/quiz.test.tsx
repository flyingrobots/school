// The registry quiz block (@flyingrobots/quiz, flyingrobots/school#36): it answers through a
// callback and shows the server's verdict. It never decides correctness itself.
// Oracle: the states are the issue's (unanswered, in flight, wrong, right, settled); every verdict
// on screen comes from `onAnswer` or `recorded`, never from the block.
import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

// happy-dom stands in for the browser for this file only, then gives the globals back.
GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { Quiz, QuizView, QuizAnswerError, QuizReadOnly } =
  await import("@/components/quiz")
type QuizState = import("@/components/quiz").QuizState

const quiz = {
  id: "q1",
  q: "Which planet is closest to the sun?",
  choices: [
    { id: "venus", text: "Venus" },
    { id: "mercury", text: "Mercury" },
    { id: "mars", text: "Mars" },
  ],
  why: "Mercury orbits at about 0.39 AU, closer than any other planet.",
}

let unmount: (() => void) | undefined
afterEach(() => {
  act(() => unmount?.())
  unmount = undefined
  document.body.innerHTML = ""
})

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(node))
  unmount = () => root.unmount()
  return host
}

/** A server stand-in: each answer waits until the test settles it, or says it was queued. */
function server() {
  const calls: {
    choiceId: string
    resolve: (v: { correct: boolean }) => void
    reject: (e: unknown) => void
    queued: () => void
  }[] = []
  const onAnswer = (choiceId: string, progress: { queued: () => void }) =>
    new Promise<{ correct: boolean }>((resolve, reject) =>
      calls.push({ choiceId, resolve, reject, queued: progress.queued })
    )
  return { calls, onAnswer }
}

const root = (host: HTMLElement) =>
  host.querySelector<HTMLElement>("[data-quiz=root]")!
const stateOf = (host: HTMLElement) => root(host).dataset.state
const choice = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLButtonElement>(`[data-choice="${id}"]`)!
const choices = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>("[data-quiz=choice]"),
]
const enabled = (host: HTMLElement) =>
  choices(host)
    .filter((b) => !b.disabled)
    .map((b) => b.dataset.choice)
const why = (host: HTMLElement) =>
  host.querySelector("[data-quiz=why] [data-slot=alert-description]")
    ?.textContent ?? null
const click = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
const press = (el: HTMLElement, key: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
const resolve = async (
  call: { resolve: (v: { correct: boolean }) => void },
  correct: boolean
) => {
  await act(async () => call.resolve({ correct }))
}

test("unanswered: the question and every choice, each with its key hint, and no explanation yet", () => {
  const host = render(<Quiz {...quiz} onAnswer={server().onAnswer} />)
  expect(stateOf(host)).toBe("unanswered")
  expect(root(host).textContent).toContain(quiz.q)
  expect(choices(host).map((b) => b.textContent)).toEqual([
    "1Venus",
    "2Mercury",
    "3Mars",
  ])
  expect(
    choices(host).map((b) => b.querySelector("[data-slot=kbd]")?.textContent)
  ).toEqual(["1", "2", "3"])
  expect(choices(host).map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(
    ["1", "2", "3"]
  )
  expect(enabled(host)).toEqual(["venus", "mercury", "mars"])
  expect(why(host)).toBeNull()
})

test("in flight: the chosen answer is sent, shows a spinner, and every choice is disabled", () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "mercury")))
  expect(s.calls.map((c) => c.choiceId)).toEqual(["mercury"])
  expect(stateOf(host)).toBe("in-flight")
  expect(enabled(host)).toEqual([])
  expect(
    choice(host, "mercury").querySelector("[data-slot=spinner]")
  ).not.toBeNull()
  expect(why(host)).toBeNull()
})

test("a second answer while one is in flight is impossible, by click or by key, even in the same tick", () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => {
    click(choice(host, "venus"))
    click(choice(host, "mars")) // before React re-renders, so `disabled` cannot be what stops it
    press(choice(host, "venus"), "2")
  })
  act(() => {
    click(choice(host, "mars"))
    press(choice(host, "venus"), "3")
  })
  expect(s.calls.map((c) => c.choiceId)).toEqual(["venus"])
})

test("wrong: the server's verdict marks the choice, the explanation stays hidden, and another try is allowed", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "venus")))
  await resolve(s.calls[0]!, false)
  expect(stateOf(host)).toBe("wrong")
  expect(choice(host, "venus").dataset.verdict).toBe("wrong")
  expect(why(host)).toBeNull()
  expect(enabled(host)).toEqual(["mercury", "mars"])
  act(() => click(choice(host, "mars")))
  expect(s.calls.map((c) => c.choiceId)).toEqual(["venus", "mars"])
  expect(stateOf(host)).toBe("in-flight")
})

test("right: the server's verdict marks the choice, the explanation appears, and the quiz takes no more answers", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "mercury")))
  await resolve(s.calls[0]!, true)
  expect(stateOf(host)).toBe("right")
  expect(choice(host, "mercury").dataset.verdict).toBe("right")
  expect(why(host)).toBe(quiz.why)
  expect(enabled(host)).toEqual([])
  act(() => {
    click(choice(host, "venus"))
    press(root(host), "1")
  })
  expect(s.calls).toHaveLength(1)
})

test("the verdict is the server's, not the block's: a 'right' for any choice is shown as right", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "mars")))
  await resolve(s.calls[0]!, true)
  expect(stateOf(host)).toBe("right")
  expect(choice(host, "mars").dataset.verdict).toBe("right")
})

test("settled: a quiz the record already holds as right shows that answer and cannot be answered again", () => {
  const s = server()
  const host = render(
    <Quiz
      {...quiz}
      onAnswer={s.onAnswer}
      recorded={{ choiceId: "mercury", correct: true }}
    />
  )
  expect(stateOf(host)).toBe("settled")
  expect(choice(host, "mercury").dataset.verdict).toBe("right")
  expect(why(host)).toBe(quiz.why)
  expect(enabled(host)).toEqual([])
  act(() => {
    for (const b of choices(host)) click(b)
    for (const key of ["1", "2", "3"]) press(root(host), key)
  })
  expect(s.calls).toEqual([])
})

test("a recorded wrong answer resumes as wrong, and can be tried again", () => {
  const s = server()
  const host = render(
    <Quiz
      {...quiz}
      onAnswer={s.onAnswer}
      recorded={{ choiceId: "mars", correct: false }}
    />
  )
  expect(stateOf(host)).toBe("wrong")
  expect(choice(host, "mars").dataset.verdict).toBe("wrong")
  act(() => press(root(host), "2"))
  expect(s.calls.map((c) => c.choiceId)).toEqual(["mercury"])
})

test("the number keys answer while focus is in the quiz; other keys and modified keys do nothing", () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => {
    press(root(host), "4") // no fourth choice
    press(root(host), "a")
    root(host).dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true })
    )
  })
  expect(s.calls).toEqual([])
  act(() => press(choice(host, "venus"), "3"))
  expect(s.calls.map((c) => c.choiceId)).toEqual(["mars"])
})

test("an answer the server did not take returns the quiz to where it was, says so, and allows another try", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "venus")))
  await act(async () => s.calls[0]!.reject(new Error("offline")))
  expect(stateOf(host)).toBe("unanswered")
  expect(host.querySelector("[data-quiz=error]")?.getAttribute("role")).toBe(
    "alert"
  )
  expect(enabled(host)).toEqual(["venus", "mercury", "mars"])
  act(() => click(choice(host, "mercury")))
  expect(s.calls.map((c) => c.choiceId)).toEqual(["venus", "mercury"])
  expect(host.querySelector("[data-quiz=error]")).toBeNull()
})

// The presentational view renders any state as given, which is what /demo shows.
test.each<[string, QuizState, string[]]>([
  ["unanswered", { status: "unanswered" }, ["venus", "mercury", "mars"]],
  ["in-flight", { status: "in-flight", choiceId: "venus" }, []],
  ["queued", { status: "queued", choiceId: "venus" }, []],
  ["wrong", { status: "wrong", choiceId: "venus" }, ["mercury", "mars"]],
  ["right", { status: "right", choiceId: "mercury" }, []],
  ["settled", { status: "settled", choiceId: "mercury" }, []],
])(
  "QuizView renders %s as given, and offers only the choices that state allows",
  (name, state, offered) => {
    const chosen: string[] = []
    const host = render(
      <QuizView {...quiz} state={state} onChoose={(id) => chosen.push(id)} />
    )
    expect(stateOf(host)).toBe(name)
    expect(enabled(host)).toEqual(offered)
    act(() => {
      for (const b of choices(host)) click(b)
      for (const key of ["1", "2", "3"]) press(root(host), key)
    })
    expect(chosen.sort()).toEqual([...offered, ...offered].sort())
    expect(why(host)).toBe(
      name === "right" || name === "settled" ? quiz.why : null
    )
  }
)

// The choice group's behaviour is ui-sdk's radio group (flyingrobots/school#62): its roles, its
// name, and its roving focus. Arrow keys only move focus here; an answer is a click, Space or a
// number key, because checking a radio sends it to the server.
const group = (host: HTMLElement) =>
  host.querySelector<HTMLElement>("[role=radiogroup]")!
const focused = () =>
  (document.activeElement as HTMLElement | null)?.dataset.choice
const arrow = async (key: string) => {
  await act(async () => press(document.activeElement as HTMLElement, key))
}

test("the choices are ui-sdk's radio group, named by the question, each a radio checked by the state", () => {
  const host = render(
    <QuizView
      {...quiz}
      state={{ status: "wrong", choiceId: "venus" }}
      onChoose={() => {}}
    />
  )
  expect(group(host).dataset.slot).toBe("radio-group")
  const names = (group(host).getAttribute("aria-labelledby") ?? "")
    .split(" ")
    .filter(Boolean)
  expect(names.map((id) => document.getElementById(id)?.textContent)).toEqual([
    quiz.q,
  ])
  expect(
    choices(host).map((b) => [
      b.getAttribute("role"),
      b.dataset.slot,
      b.getAttribute("aria-checked"),
    ])
  ).toEqual([
    ["radio", "radio", "true"],
    ["radio", "radio", "false"],
    ["radio", "radio", "false"],
  ])
  expect(choices(host).every((b) => !b.hasAttribute("aria-pressed"))).toBe(true)
})

test("arrow keys move focus between the choices, wrapping at both ends, and answer nothing", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  expect(choices(host).map((b) => b.tabIndex)).toEqual([0, -1, -1])
  choice(host, "venus").focus()
  await arrow("ArrowDown")
  expect(focused()).toBe("mercury")
  await arrow("ArrowRight")
  expect(focused()).toBe("mars")
  await arrow("ArrowDown")
  expect(focused()).toBe("venus")
  await arrow("ArrowUp")
  expect(focused()).toBe("mars")
  await arrow("ArrowLeft")
  expect(focused()).toBe("mercury")
  expect(s.calls).toEqual([])
  expect(stateOf(host)).toBe("unanswered")
  expect(choices(host).map((b) => b.getAttribute("aria-checked"))).toEqual([
    "false",
    "false",
    "false",
  ])
})

test("after a wrong answer, arrow keys skip the choice the server turned down", async () => {
  const host = render(
    <Quiz
      {...quiz}
      onAnswer={server().onAnswer}
      recorded={{ choiceId: "mercury", correct: false }}
    />
  )
  choice(host, "venus").focus()
  await arrow("ArrowDown")
  expect(focused()).toBe("mars")
  await arrow("ArrowUp")
  expect(focused()).toBe("venus")
})

test("an agent finds the quiz by its question and answers it through the same callback", async () => {
  const { createAgent } = await import("@ui-sdk/react/agent")
  const agent = createAgent()
  const s = server()
  render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  const components = agent
    .snapshot()
    .filter((entry) => !entry.offPage && entry.component !== "more")
  for (const entry of components)
    expect(
      entry.label,
      `${entry.component} ${entry.ref} has no name`
    ).toBeTruthy()
  const entry = components.find((e) => e.label === quiz.q)
  expect(entry?.component).toBe("radio")
  const items =
    (entry as { items?: { value: string; label: string }[] }).items ?? []
  expect(items.map((i) => i.value)).toEqual(["venus", "mercury", "mars"])
  const mercury = items.find((i) => i.label.includes("Mercury"))!
  const result = await act(async () =>
    agent.act({
      steps: [{ ref: quiz.q, action: "setValue", args: [mercury.label] }],
    })
  )
  expect(result.ok, result.error?.message).toBe(true)
  expect(s.calls.map((c) => c.choiceId)).toEqual(["mercury"])
})

// The block is composition only: React, ui-sdk behaviours and stock shadcn components (WEB_STYLE.md).
test("the block and its example import only React, ui-sdk entries, stock shadcn components and each other", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const components = join(import.meta.dir, "..", "src", "components")
  const stock = new Set(
    readdirSync(join(components, "ui")).map((f) => f.replace(/\.tsx$/, ""))
  )
  const imports = (file: string) =>
    [
      ...readFileSync(join(components, file), "utf8").matchAll(
        /from "([^"]+)"/g
      ),
    ].map((m) => m[1]!)
  const foreign = (file: string, allowed: string[]) =>
    imports(file).filter(
      (spec) =>
        !allowed.includes(spec) &&
        !(spec.startsWith("@/components/ui/") && stock.has(spec.slice(16)))
    )
  expect(imports("quiz.tsx").length).toBeGreaterThan(1) // zero witnesses would mean the harvest read nothing
  expect(imports("quiz.tsx")).toContain("@ui-sdk/react/radio")
  expect(foreign("quiz.tsx", ["react", "@ui-sdk/react/radio"])).toEqual([])
  expect(
    foreign("quiz-example.tsx", ["@/components/example", "@/components/quiz"])
  ).toEqual([])
})

// Showing the explanation is help the record must see (RFC 2 §3, flyingrobots/school#51): the block
// says when it shows it, once per showing, and the page records it. Strict mode runs every effect
// twice in development, so the count is checked there too.
test("onWhyShown: once when a right answer brings up the explanation, never for a wrong one", async () => {
  const s = server()
  const shown: number[] = []
  const host = render(
    <React.StrictMode>
      <Quiz {...quiz} onAnswer={s.onAnswer} onWhyShown={() => shown.push(1)} />
    </React.StrictMode>
  )
  expect(shown).toEqual([])
  act(() => click(choice(host, "venus")))
  await resolve(s.calls[0]!, false)
  expect(why(host)).toBeNull()
  expect(shown).toEqual([])
  act(() => click(choice(host, "mercury")))
  await resolve(s.calls[1]!, true)
  expect(why(host)).toBe(quiz.why)
  expect(shown).toEqual([1])
})

test("onWhyShown: once when a settled quiz first renders with its explanation", () => {
  const shown: number[] = []
  render(
    <React.StrictMode>
      <Quiz
        {...quiz}
        onAnswer={server().onAnswer}
        recorded={{ choiceId: "mercury", correct: true }}
        onWhyShown={() => shown.push(1)}
      />
    </React.StrictMode>
  )
  expect(shown).toEqual([1])
})

test.each<[string, QuizState, number]>([
  ["unanswered", { status: "unanswered" }, 0],
  ["in-flight", { status: "in-flight", choiceId: "venus" }, 0],
  ["queued", { status: "queued", choiceId: "venus" }, 0],
  ["wrong", { status: "wrong", choiceId: "venus" }, 0],
  ["right", { status: "right", choiceId: "mercury" }, 1],
  ["settled", { status: "settled", choiceId: "mercury" }, 1],
])(
  "QuizView in %s calls onWhyShown exactly when it shows the explanation",
  (_, state, times) => {
    const shown: number[] = []
    const host = render(
      <QuizView
        {...quiz}
        state={state}
        onChoose={() => {}}
        onWhyShown={() => shown.push(1)}
      />
    )
    expect(shown.length).toBe(times)
    expect(why(host) !== null).toBe(times === 1)
  }
)

// An answer the page keeps to send later (flyingrobots/school#28): queued, shown as not sent yet,
// until the server answers it. It is never shown as a verdict before then.
const badge = (host: HTMLElement) =>
  root(host).querySelector("[data-slot=badge]")?.textContent ?? null
const errorOf = (host: HTMLElement) =>
  host.querySelector("[data-quiz=error]")?.textContent ?? null

test("queued: an answer kept to send later says it is not sent yet, keeps its spinner, offers nothing, and shows no verdict", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "venus")))
  act(() => s.calls[0]!.queued())
  expect(stateOf(host)).toBe("queued")
  expect(badge(host)).toBe("Not sent yet")
  expect(root(host).textContent).toContain("Not saved yet")
  expect(root(host).getAttribute("aria-busy")).toBe("true")
  expect(
    choice(host, "venus").querySelector("[data-slot=spinner]")
  ).not.toBeNull()
  expect(choice(host, "venus").dataset.verdict).toBeUndefined()
  expect(enabled(host)).toEqual([])
  act(() => {
    for (const b of choices(host)) click(b)
    press(root(host), "2")
  })
  expect(s.calls).toHaveLength(1)
  expect(why(host)).toBeNull()
  await resolve(s.calls[0]!, false)
  expect(stateOf(host)).toBe("wrong")
  expect(choice(host, "venus").dataset.verdict).toBe("wrong")
})

test("queued after the answer was already answered is ignored: a late `queued` never hides a verdict", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "mercury")))
  await resolve(s.calls[0]!, true)
  act(() => s.calls[0]!.queued())
  expect(stateOf(host)).toBe("right")
})

test("pending: an answer kept from an earlier page starts queued over the record, then shows the verdict it gets", async () => {
  let settle!: (v: { correct: boolean }) => void
  const verdict = new Promise<{ correct: boolean }>((r) => (settle = r))
  const s = server()
  const host = render(
    <Quiz
      {...quiz}
      onAnswer={s.onAnswer}
      recorded={{ choiceId: "venus", correct: false }}
      pending={{ choiceId: "mars", verdict }}
    />
  )
  expect(stateOf(host)).toBe("queued")
  expect(
    choice(host, "mars").querySelector("[data-slot=spinner]")
  ).not.toBeNull()
  expect(enabled(host)).toEqual([])
  await act(async () => settle({ correct: true }))
  expect(stateOf(host)).toBe("right")
  expect(choice(host, "mars").dataset.verdict).toBe("right")
  expect(why(host)).toBe(quiz.why)
  expect(s.calls).toEqual([])
})

test("a refusal says why in the page's words, returns the quiz to where it was, and allows another try", async () => {
  const s = server()
  const host = render(<Quiz {...quiz} onAnswer={s.onAnswer} />)
  act(() => click(choice(host, "venus")))
  act(() => s.calls[0]!.queued())
  await act(async () =>
    s.calls[0]!.reject(
      new QuizAnswerError(
        "School refused this answer (conflict). It was not recorded."
      )
    )
  )
  expect(stateOf(host)).toBe("unanswered")
  expect(errorOf(host)).toBe(
    "School refused this answer (conflict). It was not recorded."
  )
  expect(enabled(host)).toEqual(["venus", "mercury", "mars"])
})

test("a pending answer that is refused returns the quiz to the record as it was, with the reason", async () => {
  let refuse!: (e: unknown) => void
  const verdict = new Promise<{ correct: boolean }>((_, r) => (refuse = r))
  const host = render(
    <Quiz
      {...quiz}
      onAnswer={server().onAnswer}
      recorded={{ choiceId: "venus", correct: false }}
      pending={{ choiceId: "mars", verdict }}
    />
  )
  await act(async () =>
    refuse(new QuizAnswerError("School refused this answer (rejected)."))
  )
  expect(stateOf(host)).toBe("wrong")
  expect(choice(host, "venus").dataset.verdict).toBe("wrong")
  expect(errorOf(host)).toBe("School refused this answer (rejected).")
  expect(enabled(host)).toEqual(["mercury", "mars"])
})

// The slides view shows a quiz to read only (flyingrobots/school#43): it records nothing, so the
// quiz offers nothing to choose and shows no explanation, which would be help nobody recorded.
test("read only: the question and every choice, none of them choosable by click or key, no key hints and no explanation", () => {
  const host = render(
    <QuizReadOnly id={quiz.id} q={quiz.q} choices={quiz.choices} />
  )
  expect(root(host).dataset.readOnly).toBe("true")
  expect(root(host).textContent).toContain(quiz.q)
  expect(root(host).textContent).toContain("To read only")
  expect(root(host).querySelector("[data-slot=badge]")?.textContent).toBe(
    "Read only"
  )
  expect(choices(host).map((b) => b.textContent)).toEqual([
    "Venus",
    "Mercury",
    "Mars",
  ])
  expect(choices(host).map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(
    [null, null, null]
  )
  expect(enabled(host)).toEqual([])
  act(() => {
    click(choice(host, "mercury"))
    press(root(host), "2")
  })
  expect(stateOf(host)).toBe("unanswered")
  expect(why(host)).toBeNull()
  expect(host.querySelector("[data-quiz=why]")).toBeNull()
})
