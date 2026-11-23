// The registry explain block (@flyingrobots/explain, flyingrobots/school#37): it saves a written
// explanation through a callback, then shows the grading it is given. It never grades.
// Oracle: the issue's states (empty, saving, saved, grading, graded, failed) and acceptance: the
// model answer is not in the DOM before submission; a failed grading says so, offers a retry and
// never shows a verdict; model text renders as escaped text. Verdicts are words, never numbers.
import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

// happy-dom stands in for the browser for this file only, then gives the globals back.
GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { Explain, ExplainView } = await import("@/components/explain")
const { ariaKeyshortcuts } = await import("@ui-sdk/react/shortcuts")
// `mod` is Command on Apple platforms and Control elsewhere; ask ui-sdk which one this platform uses.
const mod: KeyboardEventInit = ariaKeyshortcuts("mod+enter").startsWith("Meta") ? { metaKey: true } : { ctrlKey: true }
type ExplainState = import("@/components/explain").ExplainState
type Explanation = import("@/components/explain").ExplainExplanation
type Findings = import("@/components/explain").ExplainFindings

const MODEL = "MODEL-ANSWER: a quorum is a majority of the voting members."
const block = {
  id: "e1",
  prompt: "Explain what a quorum is, in your own words.",
  model: MODEL,
  sources: [
    { id: "s1", title: "Robert's Rules, chapter 3", text: "A quorum is the minimum number of members who must be present." },
    { id: "s2", title: "Glossary", text: "Majority: more than half." },
  ],
}

const findings: Findings = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "Matches the sources." },
  completeness: { verdict: "partly", note: "Leaves out who counts as a member." },
  accessibility: { verdict: "misses", note: "Uses jargon without saying what it means." },
  contradictions: [
    { source_id: "s1", quote: "the minimum number of members", note: "Says a majority, not a minimum.", quote_verified: true },
    { source_id: "s9", quote: "a quote nobody wrote", note: "Cites text that is not there.", quote_verified: false },
  ],
  summary: "Right idea, but say who counts.",
}

const explanation = (grading: Explanation["grading"] = null): Explanation => ({
  submissionId: "sub-1", blockId: "e1", text: "Enough people to decide.", at: "2026-11-22T12:00:00.000Z", grading,
})
const succeeded = (f: Findings = findings): Explanation["grading"] =>
  ({ id: 1, status: "succeeded", findings: f, model: "grader-model", supersedes: null, at: "2026-11-22T12:01:00.000Z" })
const failed = (error = "The grader timed out."): Explanation["grading"] =>
  ({ id: 1, status: "failed", error, model: "grader-model", supersedes: null, at: "2026-11-22T12:01:00.000Z" })

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

type Call<A> = { arg: A; resolve: (v: Explanation) => void; reject: (e: unknown) => void }
/** A server stand-in: each save and each grading waits until the test settles it. */
function server() {
  const saves: Call<string>[] = []
  const grades: Call<string>[] = []
  const onSave = (text: string) => new Promise<Explanation>((resolve, reject) => saves.push({ arg: text, resolve, reject }))
  const onGrade = (submissionId: string) => new Promise<Explanation>((resolve, reject) => grades.push({ arg: submissionId, resolve, reject }))
  return { saves, grades, onSave, onGrade }
}

const q = <T extends Element = HTMLElement>(host: HTMLElement, part: string) => host.querySelector<T>(`[data-explain="${part}"]`)
const stateOf = (host: HTMLElement) => q(host, "root")!.dataset.state
const textarea = (host: HTMLElement) => q<HTMLTextAreaElement>(host, "draft")
const saveButton = (host: HTMLElement) => q<HTMLButtonElement>(host, "save")
const gradeButton = (host: HTMLElement) => q<HTMLButtonElement>(host, "grade")
const verdicts = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>("[data-explain=criterion]")].map((c) => [c.dataset.criterion, c.dataset.verdict])
/** A key hint as people read it, without the invisible left-to-right isolates around it. */
const hint = (el: Element | null | undefined) => el?.textContent?.replace(/[\u2066-\u2069]/g, "")
const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }))

/** Types into the textarea the way React hears it: set the native value, then fire input. */
function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function saved(s: ReturnType<typeof server>, host: HTMLElement) {
  type(textarea(host)!, "Enough people to decide.")
  act(() => click(saveButton(host)!))
  await act(async () => s.saves[0]!.resolve(explanation()))
}

test("empty: the prompt, a place to write, a save with its key hint, and no model answer anywhere in the DOM", () => {
  const host = render(<Explain {...block} onSave={server().onSave} onGrade={server().onGrade} />)
  expect(stateOf(host)).toBe("empty")
  expect(q(host, "root")!.textContent).toContain(block.prompt)
  expect(textarea(host)).not.toBeNull()
  expect(saveButton(host)!.disabled).toBe(true) // nothing written yet
  expect(hint(saveButton(host)!.querySelector("[data-slot=kbd]"))).not.toBe("")
  expect(saveButton(host)!.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+Enter$/)
  expect(host.innerHTML).not.toContain("MODEL-ANSWER")
  expect(gradeButton(host)).toBeNull()
})

test("saving: the text is sent once, a spinner shows, nothing can be edited, and the model answer is still absent", () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  type(textarea(host)!, "Enough people to decide.")
  act(() => {
    click(saveButton(host)!)
    click(saveButton(host)!) // the same tick: `disabled` cannot be what stops it
  })
  expect(s.saves.map((c) => c.arg)).toEqual(["Enough people to decide."])
  expect(stateOf(host)).toBe("saving")
  expect(q(host, "root")!.getAttribute("aria-busy")).toBe("true")
  expect(saveButton(host)!.querySelector("[data-slot=spinner]")).not.toBeNull()
  expect(textarea(host)!.disabled).toBe(true)
  expect(host.innerHTML).not.toContain("MODEL-ANSWER")
})

test("the platform's mod+Enter in the textarea saves; plain Enter does not", () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  type(textarea(host)!, "Enough people to decide.")
  act(() => press(textarea(host)!, "Enter"))
  expect(s.saves).toEqual([])
  act(() => press(textarea(host)!, "Enter", mod))
  expect(s.saves.map((c) => c.arg)).toEqual(["Enough people to decide."])
})

test("a blank explanation cannot be saved", () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  type(textarea(host)!, "   ")
  act(() => {
    click(saveButton(host)!)
    press(textarea(host)!, "Enter", mod)
  })
  expect(s.saves).toEqual([])
})

test("a save the server did not take keeps the text, says so, hides the model answer and allows another try", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  type(textarea(host)!, "Enough people to decide.")
  act(() => click(saveButton(host)!))
  await act(async () => s.saves[0]!.reject(new Error("offline")))
  expect(stateOf(host)).toBe("empty")
  expect(textarea(host)!.value).toBe("Enough people to decide.")
  expect(q(host, "error")?.getAttribute("role")).toBe("alert")
  expect(host.innerHTML).not.toContain("MODEL-ANSWER")
  act(() => click(saveButton(host)!))
  expect(s.saves).toHaveLength(2)
  expect(q(host, "error")).toBeNull()
})

test("saved: the explanation as stored, the model answer revealed, the sources, and a robot-labelled grade action", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  await saved(s, host)
  expect(stateOf(host)).toBe("saved")
  expect(textarea(host)).toBeNull()
  expect(q(host, "explanation")!.textContent).toContain("Enough people to decide.")
  expect(q(host, "model")!.textContent).toContain(MODEL)
  expect(q(host, "sources")!.textContent).toContain("Robert's Rules, chapter 3")
  const grade = gradeButton(host)!
  expect(grade.disabled).toBe(false)
  expect(grade.querySelector("svg.lucide-bot")).not.toBeNull() // the AI action is labelled with a robot
  expect(hint(grade.querySelector("[data-slot=kbd]"))).toBe("G")
  expect(grade.getAttribute("aria-keyshortcuts")).toBe("G")
  expect(verdicts(host)).toEqual([])
})

test("grading: one request for the saved submission, a spinner and skeletons, and no verdict yet", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  await saved(s, host)
  act(() => {
    click(gradeButton(host)!)
    click(gradeButton(host)!)
    gradeButton(host)!.focus()
    press(gradeButton(host)!, "g")
  })
  expect(s.grades.map((c) => c.arg)).toEqual(["sub-1"])
  expect(stateOf(host)).toBe("grading")
  expect(gradeButton(host)!.disabled).toBe(true)
  expect(gradeButton(host)!.querySelector("[data-slot=spinner]")).not.toBeNull()
  expect(host.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0)
  expect(verdicts(host)).toEqual([])
})

test("the g key grades while focus is in the block, but not while typing, not from outside, and not with a modifier", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  textarea(host)!.focus()
  act(() => press(textarea(host)!, "g"))
  await saved(s, host)
  act(() => press(document.body, "g")) // focus is elsewhere on the page
  act(() => {
    gradeButton(host)!.focus()
    press(gradeButton(host)!, "g", { ctrlKey: true })
  })
  expect(s.grades).toEqual([])
  act(() => press(gradeButton(host)!, "g"))
  expect(s.grades.map((c) => c.arg)).toEqual(["sub-1"])
})

test("graded: each criterion's verdict in words with its note, the summary, and contradictions; never a number", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  await saved(s, host)
  act(() => click(gradeButton(host)!))
  await act(async () => s.grades[0]!.resolve(explanation(succeeded())))
  expect(stateOf(host)).toBe("graded")
  expect(verdicts(host)).toEqual([["fidelity", "meets"], ["completeness", "partly"], ["accessibility", "misses"]])
  const criteria = [...host.querySelectorAll<HTMLElement>("[data-explain=criterion]")].map((c) => c.textContent)
  expect(criteria[0]).toContain("Meets")
  expect(criteria[0]).toContain("Matches the sources.")
  expect(criteria[1]).toContain("Partly")
  expect(criteria[2]).toContain("Misses")
  expect(q(host, "summary")!.textContent).toContain(findings.summary)
  const contradictions = [...host.querySelectorAll<HTMLElement>("[data-explain=contradiction]")]
  expect(contradictions.map((c) => c.dataset.verified)).toEqual(["true", "false"])
  expect(contradictions[0]!.textContent).toContain("Robert's Rules, chapter 3") // the source by title
  expect(contradictions[0]!.textContent).not.toContain("not found")
  expect(contradictions[1]!.textContent).toContain("not found")
  // Words, never scores, letters or percentages: each verdict is exactly one of three words.
  const badges = [...host.querySelectorAll("[data-explain=criterion] [data-slot=badge]")].map((b) => b.textContent)
  expect(badges).toEqual(["Meets", "Partly meets", "Misses"])
  expect(q(host, "findings")!.textContent).not.toMatch(/\d+\s*(%|\/|out of)|score|grade [A-F]\b/i)
  expect(gradeButton(host)).toBeNull()
})

test("graded with insufficient evidence: says there was not enough to judge and shows no verdict", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  await saved(s, host)
  act(() => click(gradeButton(host)!))
  await act(async () => s.grades[0]!.resolve(explanation(succeeded({ ...findings, insufficient_evidence: true }))))
  expect(stateOf(host)).toBe("graded")
  expect(q(host, "insufficient")).not.toBeNull()
  expect(verdicts(host)).toEqual([])
  expect(q(host, "summary")!.textContent).toContain(findings.summary)
})

test("failed: a stored failed grading says so, offers a robot-labelled retry, and never shows a verdict", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  await saved(s, host)
  act(() => click(gradeButton(host)!))
  await act(async () => s.grades[0]!.resolve(explanation(failed())))
  expect(stateOf(host)).toBe("failed")
  expect(q(host, "failed")!.getAttribute("role")).toBe("alert")
  expect(q(host, "failed")!.textContent).toContain("not a verdict")
  expect(q(host, "failed")!.textContent).toContain("The grader timed out.")
  expect(verdicts(host)).toEqual([])
  expect(q(host, "findings")).toBeNull()
  const retry = gradeButton(host)!
  expect(retry.textContent).toContain("Retry")
  expect(retry.querySelector("svg.lucide-bot")).not.toBeNull()
  act(() => click(retry))
  expect(s.grades.map((c) => c.arg)).toEqual(["sub-1", "sub-1"])
  expect(stateOf(host)).toBe("grading")
  await act(async () => s.grades[1]!.resolve(explanation(succeeded())))
  expect(stateOf(host)).toBe("graded")
})

test("failed: a grading request that never reached the server is a failure too, with a retry", async () => {
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  await saved(s, host)
  act(() => click(gradeButton(host)!))
  await act(async () => s.grades[0]!.reject(new Error("offline")))
  expect(stateOf(host)).toBe("failed")
  expect(verdicts(host)).toEqual([])
  expect(gradeButton(host)!.textContent).toContain("Retry")
})

test.each<[string, Explanation["grading"], string]>([
  ["saved", null, "saved"],
  ["graded", succeeded(), "graded"],
  ["failed", failed(), "failed"],
])("a %s explanation the record already holds resumes in that state, with the model answer shown", (_, grading, status) => {
  const s = server()
  const host = render(<Explain {...block} saved={explanation(grading)} onSave={s.onSave} onGrade={s.onGrade} />)
  expect(stateOf(host)).toBe(status)
  expect(q(host, "model")!.textContent).toContain(MODEL)
  expect(textarea(host)).toBeNull()
})

const views: [ExplainState, boolean][] = [
  [{ status: "empty" }, false],
  [{ status: "saving", text: "Enough people to decide." }, false],
  [{ status: "saved", explanation: explanation() }, true],
  [{ status: "grading", explanation: explanation() }, true],
  [{ status: "graded", explanation: explanation(), findings }, true],
  [{ status: "failed", explanation: explanation(), error: "The grader timed out." }, true],
]
// The presentational view renders any state as given, which is what /demo shows.
test.each(views)("ExplainView renders %o as given; the model answer only once submitted", (state, shown) => {
  const host = render(<ExplainView {...block} state={state} draft="" onDraftChange={() => {}} onSave={() => {}} onGrade={() => {}} />)
  expect(stateOf(host)).toBe(state.status)
  expect(host.innerHTML.includes("MODEL-ANSWER")).toBe(shown)
  expect(verdicts(host).length).toBe(state.status === "graded" ? 3 : 0)
})

test("model text with an injected <script> renders as inert, escaped text", async () => {
  const evil = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned = true">'
  const hostile: Findings = {
    insufficient_evidence: false,
    fidelity: { verdict: "meets", note: evil },
    completeness: { verdict: "partly", note: evil },
    accessibility: { verdict: "misses", note: evil },
    contradictions: [{ source_id: "s1", quote: evil, note: evil, quote_verified: false }],
    summary: evil,
  }
  const s = server()
  const host = render(<Explain {...block} onSave={s.onSave} onGrade={s.onGrade} />)
  await saved(s, host)
  act(() => click(gradeButton(host)!))
  await act(async () => s.grades[0]!.resolve(explanation(succeeded(hostile))))
  const failedHost = render(<ExplainView {...block} state={{ status: "failed", explanation: explanation(), error: evil }} draft="" onDraftChange={() => {}} onSave={() => {}} onGrade={() => {}} />)
  for (const h of [host, failedHost]) {
    expect(h.querySelector("script")).toBeNull()
    expect(h.querySelector("img")).toBeNull()
    expect(h.textContent).toContain("<script>window.__pwned = true</script>")
  }
  expect(q(host, "summary")!.textContent).toContain(evil)
  expect(q(failedHost, "failed")!.textContent).toContain(evil)
  expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
})

// The block is composition only: ui-sdk behaviours, stock shadcn components and the icon set they use.
test("the block and its example import only React, ui-sdk entries, lucide icons, stock shadcn components and each other", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const components = join(import.meta.dir, "..", "src", "components")
  const stock = new Set(readdirSync(join(components, "ui")).map((f) => f.replace(/\.tsx$/, "")))
  const imports = (file: string) =>
    [...readFileSync(join(components, file), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]!)
  const foreign = (file: string, allowed: string[]) =>
    imports(file).filter((spec) => !allowed.includes(spec) && !(spec.startsWith("@/components/ui/") && stock.has(spec.slice(16))))
  expect(imports("explain.tsx").length).toBeGreaterThan(1) // zero witnesses would mean the harvest read nothing
  expect(foreign("explain.tsx", ["react", "lucide-react"]).filter((spec) => !spec.startsWith("@ui-sdk/react/"))).toEqual([])
  expect(foreign("explain-example.tsx", ["@/components/example", "@/components/explain"])).toEqual([])
})

test("the block never renders model text as HTML", async () => {
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const source = readFileSync(join(import.meta.dir, "..", "src", "components", "explain.tsx"), "utf8")
  expect(source).not.toContain("dangerouslySetInnerHTML")
  expect(source).not.toContain("innerHTML")
})

// Showing the model answer and opening a source are help the record must see (RFC 2 §3,
// flyingrobots/school#51): the block says when it shows each, once per showing, and the page
// records it. Strict mode runs every effect twice in development, so the counts are checked there.
// Revising is what makes the help matter: an explanation written after the model answer was shown
// is aided (RFC 2 Figure 4).
const revise = (host: HTMLElement) => q<HTMLButtonElement>(host, "revise")

function watched(props: Partial<React.ComponentProps<typeof Explain>> = {}) {
  const s = server()
  const models: number[] = []
  const sources: string[] = []
  const host = render(
    <React.StrictMode>
      <Explain {...block} onSave={s.onSave} onGrade={s.onGrade} onModelShown={() => models.push(1)} onSourceOpened={(id) => sources.push(id)} {...props} />
    </React.StrictMode>
  )
  return { s, host, models, sources }
}

test("onModelShown: once when a saved explanation brings up the model answer, not again while it is graded", async () => {
  const { s, host, models } = watched()
  type(textarea(host)!, "Enough people to decide.")
  act(() => click(saveButton(host)!))
  expect(models).toEqual([]) // saving: the model answer is not shown yet
  await act(async () => s.saves[0]!.resolve(explanation()))
  expect(q(host, "model")!.textContent).toContain(MODEL)
  expect(models).toEqual([1])
  act(() => click(gradeButton(host)!))
  await act(async () => s.grades[0]!.resolve(explanation(failed())))
  act(() => click(gradeButton(host)!))
  await act(async () => s.grades[1]!.resolve(explanation(succeeded())))
  expect(stateOf(host)).toBe("graded")
  expect(models).toEqual([1])
})

test("onModelShown: never for a save the server did not take", async () => {
  const { s, host, models } = watched()
  type(textarea(host)!, "Enough people to decide.")
  act(() => click(saveButton(host)!))
  await act(async () => s.saves[0]!.reject(new Error("offline")))
  expect(stateOf(host)).toBe("empty")
  expect(models).toEqual([])
})

test.each<[string, Explanation["grading"]]>([
  ["saved", null],
  ["graded", succeeded()],
  ["failed", failed()],
])("onModelShown: once when a %s explanation the record holds first renders", (_, grading) => {
  const { models } = watched({ saved: explanation(grading) })
  expect(models).toEqual([1])
})

test("onSourceOpened: once each time a source is opened, never on closing it", async () => {
  const { s, host, sources } = watched()
  await saved(s, host)
  expect(sources).toEqual([])
  const trigger = (title: string) => [...q(host, "sources")!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(title))!
  act(() => click(trigger("Glossary")))
  expect(sources).toEqual(["s2"])
  act(() => click(trigger("Robert's Rules")))
  expect(sources).toEqual(["s2", "s1"])
  act(() => click(trigger("Glossary"))) // closed
  expect(sources).toEqual(["s2", "s1"])
  act(() => click(trigger("Glossary"))) // opened again: a second showing
  expect(sources).toEqual(["s2", "s1", "s2"])
})

test.each<[string, Explanation["grading"]]>([
  ["saved", null],
  ["graded", succeeded()],
  ["failed", failed()],
])("revise: from %s, Revise returns to writing with the saved text, hides the model answer, and saves the revision as a new explanation", async (_, grading) => {
  const { s, host, models } = watched({ saved: explanation(grading) })
  expect(models).toEqual([1])
  const button = revise(host)!
  expect(hint(button.querySelector("[data-slot=kbd]"))).toBe("R")
  expect(button.getAttribute("aria-keyshortcuts")).toBe("R")
  act(() => click(button))
  expect(stateOf(host)).toBe("empty")
  expect(textarea(host)!.value).toBe("Enough people to decide.")
  expect(host.innerHTML.includes("MODEL-ANSWER")).toBe(false)
  type(textarea(host)!, "A majority of the voting members, present.")
  act(() => click(saveButton(host)!))
  expect(s.saves.map((c) => c.arg)).toEqual(["A majority of the voting members, present."])
  await act(async () => s.saves[0]!.resolve({ ...explanation(), submissionId: "sub-2", text: "A majority of the voting members, present." }))
  expect(stateOf(host)).toBe("saved")
  expect(q(host, "explanation")!.textContent).toContain("A majority of the voting members")
  expect(models).toEqual([1, 1]) // the model answer is shown again: a second showing
})

test("revise: the r key revises while focus is in the block, not from outside, not while grading", async () => {
  const { s, host } = watched()
  await saved(s, host)
  act(() => press(document.body, "r"))
  expect(stateOf(host)).toBe("saved")
  act(() => click(gradeButton(host)!))
  gradeButton(host)!.focus()
  act(() => press(gradeButton(host)!, "r"))
  expect(stateOf(host)).toBe("grading")
  expect(revise(host)?.disabled ?? true).toBe(true)
  await act(async () => s.grades[0]!.resolve(explanation(failed())))
  gradeButton(host)!.focus()
  act(() => press(gradeButton(host)!, "r"))
  expect(stateOf(host)).toBe("empty")
})

test("revise: nothing to revise while writing or saving", () => {
  const { host } = watched()
  expect(revise(host)).toBeNull()
  type(textarea(host)!, "Enough people to decide.")
  act(() => click(saveButton(host)!))
  expect(revise(host)).toBeNull()
})
