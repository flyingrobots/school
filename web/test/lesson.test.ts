// The lesson page (flyingrobots/school#42), driven in a real browser: Chrome through playwright-core,
// against the Vite dev server, with the page's /api requests answered by a real School process on
// the development course in test/fixtures/course. Oracles are the issue's acceptance items:
// - a wrong then right answer is recorded, and a reload shows what the record holds;
// - an explanation is saved before grading, and a failed grading offers a retry;
// - the server being down while answering never shows the answer as saved;
// - a lesson id that does not exist shows a not-found state.
// And flyingrobots/school#51's: the page opens lessons with ?aid=1 and records each kind of help it
// shows exactly once per showing, and RFC 2 Figure 4 (submit, reveal, revise) reaches the server in
// that order.
// What a reload shows is the learner history's oracle (server/contract/learner-history.ts,
// `pageShows`): each quiz by its latest answer, each explanation by its latest grading.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { startSchool, timeout, type Started } from "../../server/testing/processes.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")
const COURSE = join(import.meta.dir, "fixtures", "course")
const TOKEN = "lesson-page-test-token"

// Each test that writes to the record uses its own course name, all served from the one fixture,
// so no test resumes an encounter another test opened.
const NAMES = ["golden", "wrong", "saved", "failed", "keys", "aid", "pager", "loading", "down", "feedback", "model", "source", "trace", "resend"] as const
type Name = (typeof NAMES)[number]

/** A fake bridge: answers each grading with the next reply queued, or a failure when none is. */
const replies: ("fail" | "succeed")[] = []
const findings = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "It agrees with the sources." },
  completeness: { verdict: "partly", note: "Say what the tilt does to the length of the day." },
  accessibility: { verdict: "meets", note: "Plain words throughout." },
  contradictions: [],
  summary: "Clear and right: the tilt, not the distance.",
}
let bridge: ReturnType<typeof Bun.serve>
let gradings = 0

/** A School process, and the environment it was started with so it can be started again. */
type Stack = { school: Started; env: Record<string, string | undefined> }

async function stack(state: string): Promise<Stack> {
  const env = {
    ...process.env,
    SCHOOL_COURSE: undefined,
    SCHOOL_COURSES: NAMES.map((n) => `${n}=${COURSE}`).join(","),
    SCHOOL_STATE: state,
    SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""),
    SCHOOL_BRIDGE_TOKEN: TOKEN,
    HOST: "127.0.0.1",
  }
  return { school: await startSchool(env), env }
}

async function stop(s: Stack | undefined) {
  if (!s) return
  s.school.proc.kill("SIGKILL")
  await s.school.proc.exited
}

let browser: Browser
let vite: ViteDevServer
let base = ""
let root: string
let main: Stack

beforeAll(async () => {
  bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname !== "/run") return new Response("not found", { status: 404 })
      gradings += 1
      return replies.shift() === "succeed"
        ? Response.json({ status: "succeeded", agent: "fake", output: findings, attempts: [{ agent: "fake", status: "succeeded" }] })
        : Response.json({ status: "failed", error: "the fake agent gave up", attempts: [{ agent: "fake", status: "failed", error: "gave up" }] })
    },
  })
  root = mkdtempSync(join(tmpdir(), "school-lesson-page-"))
  main = await stack(join(root, "state"))
  vite = await createServer({ root: web, configFile: join(web, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
  // A missing Chrome fails here, loudly; it is never a skip.
  browser = await chromium.launch({ channel: "chrome" })
}, timeout(1) + 10_000)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  await stop(main)
  bridge?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const lessonPath = (course: Name, lesson = "orbits") => `/courses/${course}/lessons/${lesson}`

/**
 * A page whose /api requests reach `s`'s School wherever it is listening now, as the course page's
 * tests do. While School is down, they fail as a refused connection would.
 */
async function newPage(s: Stack = main): Promise<Page> {
  const c = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    try {
      await route.fulfill({ response: await route.fetch({ url: s.school.url + u.pathname + u.search }) })
    } catch {
      await route.abort("connectionrefused")
    }
  })
  const p = await c.newPage()
  p.setDefaultTimeout(5_000)
  return p
}

/** Opens a lesson and waits for it to be playable: its title is the page heading. */
async function open(s: Stack, path: string, title = "Orbits", page?: Page): Promise<Page> {
  const p = page ?? (await newPage(s))
  await p.goto(base + path)
  await p.getByRole("heading", { level: 1, name: title, exact: true }).waitFor()
  return p
}

const quiz = (p: Page, id: string) => p.locator(`[data-quiz=root][data-quiz-id="${id}"]`)
const explain = (p: Page, id: string) => p.locator(`[data-explain=root][data-explain-id="${id}"]`)
const stateOf = async (l: ReturnType<Page["locator"]>) => l.getAttribute("data-state")

/** The lesson as the API returns it, read straight from School, bypassing the page. */
const record = async (s: Stack, course: Name, lesson = "orbits") =>
  // With the page's ?aid=1, so it resumes the page's encounter: a different aid opens another (RFC 2 §3).
  (await (await fetch(`${s.school.url}/api/courses/${course}/lessons/${lesson}?aid=1`)).json()) as {
    answers: { blockId: string; choiceId: string; correct: boolean }[]
    explanations: { blockId: string; text: string; grading: { status: string } | null }[]
  }

describe("golden path", () => {
  test("study a lesson: prose, a wrong then right answer, an explanation saved then graded after a retry, and a reload shows it all", async () => {
    const p = await open(main, lessonPath("golden"))

    // Prose is the lesson's HTML, rendered through the markdown item, not shown as markup.
    // Streamdown renders <strong> as its own bold element.
    const prose = p.locator("[data-lesson-block=prose]").first()
    expect(await prose.locator("[data-slot=markdown] [data-streamdown=strong]").textContent()).toBe("circular")
    expect(await prose.locator("[data-slot=markdown] li").count()).toBe(2)
    expect(await prose.textContent()).not.toContain("<strong>")
    expect(await p.getByRole("heading", { level: 2, name: "Where the planets are", exact: true }).count()).toBe(1)
    expect(await p.getByRole("heading", { level: 2, name: "Why the seasons turn", exact: true }).count()).toBe(1)
    expect(await p.locator("[data-lesson-block=card]").textContent()).toContain("astronomical unit")
    expect(await p.locator("[data-lesson-block=aside]").textContent()).toContain("Pluto")
    expect(await p.locator("[data-lesson-block=quote]").textContent()).toContain("ellipse")
    expect(await p.locator("[data-nest=root], [data-lesson-block=nest] [role=tree]").count()).toBeGreaterThan(0)

    // Wrong, then right. Each verdict is the server's.
    const q = quiz(p, "closest")
    await q.locator("[data-choice=venus]").click()
    await p.waitForFunction(() => document.querySelector("[data-quiz-id=closest]")?.getAttribute("data-state") === "wrong")
    await q.locator("[data-choice=mercury]").click()
    await p.waitForFunction(() => document.querySelector("[data-quiz-id=closest]")?.getAttribute("data-state") === "right")
    expect(await q.locator("[data-quiz=why]").textContent()).toContain("0.39 AU")
    expect((await record(main, "golden")).answers).toEqual([
      { blockId: "closest", choiceId: "venus", correct: false },
      { blockId: "closest", choiceId: "mercury", correct: true },
    ])

    // The explanation is saved before anything grades it.
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("The tilt of the Earth's axis, not its distance from the Sun.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    expect(gradings).toBe(0)
    const saved = (await record(main, "golden")).explanations
    expect(saved).toMatchObject([{ blockId: "seasons", text: "The tilt of the Earth's axis, not its distance from the Sun.", grading: null }])
    expect(await x.locator("[data-explain=model]").textContent()).toContain("each hemisphere in turn")

    // The first grading fails, and the page offers a retry; the retry succeeds.
    replies.push("fail", "succeed")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "failed")
    expect(await x.locator("[data-explain=failed]").textContent()).toContain("the fake agent gave up")
    expect(await x.locator("[data-explain=grade]").textContent()).toContain("Retry")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "graded")
    expect(await x.locator("[data-explain=summary]").textContent()).toContain("the tilt, not the distance")
    expect(gradings).toBe(2)

    // A reload shows what the encounter holds: the quiz settled on the right answer, the
    // explanation graded. Nothing is asked again.
    await open(main, lessonPath("golden"), "Orbits", p)
    expect(await stateOf(quiz(p, "closest"))).toBe("settled")
    expect(await quiz(p, "closest").locator("[data-choice=mercury]").getAttribute("data-verdict")).toBe("right")
    expect(await stateOf(explain(p, "seasons"))).toBe("graded")
    expect(await explain(p, "seasons").locator("[data-explain=summary]").textContent()).toContain("the tilt, not the distance")
    expect(await explain(p, "seasons").locator("[data-explain=explanation]").textContent()).toContain("not its distance")
    expect((await record(main, "golden")).answers).toHaveLength(2) // the reload recorded nothing new
    await p.context().close()
  })
})

describe("reload shows what the encounter holds", () => {
  test("a wrong answer alone: the quiz reopens wrong, and the other choices can still be tried", async () => {
    const p = await open(main, lessonPath("wrong"))
    await quiz(p, "closest").locator("[data-choice=mars]").click()
    await p.waitForFunction(() => document.querySelector("[data-quiz-id=closest]")?.getAttribute("data-state") === "wrong")
    await open(main, lessonPath("wrong"), "Orbits", p)
    const q = quiz(p, "closest")
    expect(await stateOf(q)).toBe("wrong")
    expect(await q.locator("[data-choice=mars]").getAttribute("data-verdict")).toBe("wrong")
    expect(await q.locator("[data-choice=mercury]").isEnabled()).toBe(true)
    await q.locator("[data-choice=mercury]").click()
    await p.waitForFunction(() => document.querySelector("[data-quiz-id=closest]")?.getAttribute("data-state") === "right")
    await p.context().close()
  })

  test("a saved explanation not yet graded: it reopens saved, with its model answer and the feedback button", async () => {
    const p = await open(main, lessonPath("saved"))
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("Because of the tilt.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    await open(main, lessonPath("saved"), "Orbits", p)
    expect(await stateOf(explain(p, "seasons"))).toBe("saved")
    expect(await explain(p, "seasons").locator("[data-explain=explanation]").textContent()).toContain("Because of the tilt.")
    expect(await explain(p, "seasons").locator("[data-explain=grade]").isEnabled()).toBe(true)
    await p.context().close()
  })

  test("a failed grading: it reopens not graded, still offering the retry", async () => {
    const p = await open(main, lessonPath("failed"))
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("Because of the tilt.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    replies.push("fail")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "failed")
    await open(main, lessonPath("failed"), "Orbits", p)
    expect(await stateOf(explain(p, "seasons"))).toBe("failed")
    expect(await explain(p, "seasons").locator("[data-explain=grade]").textContent()).toContain("Retry")
    await p.context().close()
  })
})

describe("not found", () => {
  test.each([
    ["a lesson id that does not exist", "/courses/golden/lessons/no-such-lesson"],
    ["a course that does not exist", "/courses/no-such-course/lessons/orbits"],
  ])("%s shows a not-found state", async (_, path) => {
    const p = await newPage()
    await p.goto(base + path)
    await p.getByRole("heading", { level: 1, name: "Lesson not found", exact: true }).waitFor()
    expect(await p.locator("[data-quiz=root], [data-explain=root]").count()).toBe(0)
    await p.context().close()
  })
})

describe("loading", () => {
  test("shows Skeletons and a Spinner until the lesson arrives", async () => {
    const p = await newPage()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await p.route("**/api/courses/loading/lessons/orbits", async (route) => {
      await held
      await route.fallback()
    })
    await p.goto(base + lessonPath("loading"))
    await p.locator("[data-lesson=loading]").waitFor()
    expect(await p.locator("[data-lesson=loading] [data-slot=skeleton]").count()).toBeGreaterThan(0)
    expect(await p.locator("[data-lesson=loading] [data-slot=spinner], [data-lesson=loading] [role=status]").count()).toBeGreaterThan(0)
    release()
    await p.getByRole("heading", { level: 1, name: "Orbits", exact: true }).waitFor()
    expect(await p.locator("[data-lesson=loading]").count()).toBe(0)
    await p.context().close()
  })
})

describe("aid tracking (flyingrobots/school#51)", () => {
  test("the page opens the lesson with ?aid=1: it declares that it records the help it shows", async () => {
    const p = await newPage()
    const asked: string[] = []
    p.on("request", (r) => {
      if (r.url().includes("/api/courses/")) asked.push(r.url())
    })
    await open(main, lessonPath("aid"), "Orbits", p)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.map((u) => new URL(u).searchParams.getAll("aid"))).toEqual(asked.map(() => ["1"]))
    await p.context().close()
  })
})

/** Every POST the page sends to School, in order, with its JSON body. */
function posts(p: Page) {
  const sent: { path: string; body: Record<string, string> }[] = []
  p.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/")) sent.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() })
  })
  const exposures = () => sent.filter((x) => x.path === "/api/exposure").map((x) => x.body)
  return { sent, exposures }
}

/**
 * Waits until `n` exposures have been sent, then a while longer, so that a second send of one
 * showing (an effect run twice, say) would be seen. Strict mode's second run is in the same commit,
 * well inside this.
 */
async function exposed(p: Page, seen: ReturnType<typeof posts>, n: number) {
  const until = Date.now() + 5_000
  while (seen.exposures().length < n && Date.now() < until) await p.waitForTimeout(25)
  await p.waitForTimeout(300)
  return seen.exposures()
}

const encounterOf = (seen: ReturnType<typeof posts>) => seen.sent.find((x) => x.path !== "/api/exposure")!.body.encounterId
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("every exposure the page shows is recorded once per showing (flyingrobots/school#51)", () => {
  test("feedback: the quiz's why, once when a right answer shows it, never for a wrong one, and once more on a reload that shows it again", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("feedback"), "Orbits", p)
    const q = quiz(p, "closest")
    await q.locator("[data-choice=venus]").click()
    await p.waitForFunction(() => document.querySelector("[data-quiz-id=closest]")?.getAttribute("data-state") === "wrong")
    expect(await exposed(p, seen, 0)).toEqual([])
    await q.locator("[data-choice=mercury]").click()
    await p.waitForFunction(() => document.querySelector("[data-quiz-id=closest]")?.getAttribute("data-state") === "right")
    const once = await exposed(p, seen, 1)
    expect(once).toEqual([{ exposureId: expect.stringMatching(UUID), encounterId: encounterOf(seen), blockId: "closest", kind: "feedback" }])
    // School on SQLite answers 501 (exposures unsupported); that is "not tracked", never an error.
    expect(await q.locator("[data-quiz=error]").count()).toBe(0)

    await open(main, lessonPath("feedback"), "Orbits", p)
    expect(await stateOf(quiz(p, "closest"))).toBe("settled")
    const twice = await exposed(p, seen, 2)
    expect(twice.map((x) => [x.blockId, x.kind])).toEqual([["closest", "feedback"], ["closest", "feedback"]])
    expect(twice[1]!.exposureId).not.toBe(twice[0]!.exposureId)
    await p.context().close()
  })

  test("model-answer: once when a saved explanation shows it, not again while it is graded, and once more on a reload that shows it again", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("model"), "Orbits", p)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("The tilt of the axis.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    replies.push("fail", "succeed")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "failed")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "graded")
    const once = await exposed(p, seen, 1)
    expect(once).toEqual([{ exposureId: expect.stringMatching(UUID), encounterId: encounterOf(seen), blockId: "seasons", kind: "model-answer" }])
    expect(await x.locator("[data-explain=error]").count()).toBe(0)

    await open(main, lessonPath("model"), "Orbits", p)
    expect(await stateOf(explain(p, "seasons"))).toBe("graded")
    expect((await exposed(p, seen, 2)).map((e) => [e.blockId, e.kind])).toEqual([["seasons", "model-answer"], ["seasons", "model-answer"]])
    await p.context().close()
  })

  test("reference: once each time one of an explain block's sources is opened", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("source"), "Orbits", p)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("The tilt of the axis.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    expect((await exposed(p, seen, 1)).map((e) => e.kind)).toEqual(["model-answer"])
    const source = x.locator("[data-explain=sources]").getByRole("button", { name: "The tilt" })
    await source.click()
    await x.locator("[data-explain=sources]").getByText("23.4 degrees").waitFor()
    expect((await exposed(p, seen, 2)).map((e) => [e.blockId, e.kind])).toEqual([["seasons", "model-answer"], ["seasons", "reference"]])
    await source.click() // closing it shows nothing
    expect(await exposed(p, seen, 2)).toHaveLength(2)
    await p.context().close()
  })
})

describe("RFC 2 Figure 4 over the page: submit, reveal, revise (flyingrobots/school#51)", () => {
  test("the first explanation, the model answer it reveals, and the revision reach School in that order, in one encounter", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("trace"), "Orbits", p)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("Because the Earth is closer to the Sun in summer.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    expect(await x.locator("[data-explain=model]").textContent()).toContain("each hemisphere in turn")
    await x.locator("[data-explain=revise]").click()
    expect(await x.locator("[data-explain=draft]").inputValue()).toBe("Because the Earth is closer to the Sun in summer.")
    await x.locator("[data-explain=draft]").fill("The axis is tilted, so each hemisphere in turn leans towards the Sun.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    await exposed(p, seen, 2)

    const trace = seen.sent.map((s) => (s.path === "/api/exposure" ? `${s.path} ${s.body.kind}` : `${s.path} ${s.body.text}`))
    expect(trace).toEqual([
      "/api/explanation Because the Earth is closer to the Sun in summer.",
      "/api/exposure model-answer",
      "/api/explanation The axis is tilted, so each hemisphere in turn leans towards the Sun.",
      "/api/exposure model-answer", // the revision shows the model answer again
    ])
    expect(new Set(seen.sent.map((s) => s.body.encounterId))).toEqual(new Set([encounterOf(seen)]))
    expect((await record(main, "trace")).explanations.map((e) => e.text)).toEqual([
      "Because the Earth is closer to the Sun in summer.",
      "The axis is tilted, so each hemisphere in turn leans towards the Sun.",
    ])
    await p.context().close()
  })

  // The derived aid needs School on Postgres: on SQLite every exposure is refused as unsupported and
  // every aid is unknown. On `pglite:` (flyingrobots/school#79), the same trace must leave the first
  // explanation "no-recorded-aid" and the revision "aided".
  test.todo("the first explanation has no recorded aid and the revision is aided, on a School served from pglite: (flyingrobots/school#79)")
})

describe("an exposure that did not reach School (flyingrobots/school#51)", () => {
  test("is resent with the same id before the block's next submission, and while it cannot be recorded, that submission is not sent", async () => {
    const p = await newPage()
    const seen = posts(p)
    let down = true
    await p.route("**/api/exposure", (route) => (down ? route.abort("connectionrefused") : route.fallback()))
    await open(main, lessonPath("resend"), "Orbits", p)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("Because of the distance.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    const [first] = await exposed(p, seen, 1)
    expect(first!.kind).toBe("model-answer")
    expect(await x.locator("[data-explain=error]").count()).toBe(0) // the learner is not told about bookkeeping

    // Still down: the revision is not sent, since School would not know it came after the model answer.
    await x.locator("[data-explain=revise]").click()
    await x.locator("[data-explain=draft]").fill("Because of the tilt.")
    await x.locator("[data-explain=save]").click()
    await x.locator("[data-explain=error]").waitFor()
    expect(await stateOf(x)).toBe("empty")
    expect(await x.locator("[data-explain=draft]").inputValue()).toBe("Because of the tilt.")
    expect(seen.sent.filter((s) => s.path === "/api/explanation")).toHaveLength(1)

    // Back: the same exposure goes first, then the revision.
    down = false
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
    const after = seen.sent.slice(seen.sent.findIndex((s) => s.path === "/api/explanation" && s.body.text === "Because of the tilt.") - 1)
    expect(after.slice(0, 2).map((s) => [s.path, s.body.exposureId ?? s.body.text])).toEqual([
      ["/api/exposure", first!.exposureId],
      ["/api/explanation", "Because of the tilt."],
    ])
    const ids = new Set(seen.exposures().map((e) => e.exposureId))
    expect(ids.size).toBe(2) // the model answer's two showings, however many times each was sent
    await p.context().close()
  })
})

describe("previous and next", () => {
  test("next and previous links move between lessons, on the client", async () => {
    const p = await open(main, lessonPath("pager"))
    await p.evaluate(() => ((window as unknown as { marker: number }).marker = 1))
    expect(await p.locator("a[rel=prev]").count()).toBe(0) // the first lesson has no previous
    await p.locator("a[rel=next]").first().click()
    await p.getByRole("heading", { level: 1, name: "Moons", exact: true }).waitFor()
    expect(await p.locator("a[rel=next]").count()).toBe(0) // the last has no next
    expect(await quiz(p, "moons-none").count()).toBe(1)
    await p.locator("a[rel=prev]").first().click()
    await p.getByRole("heading", { level: 1, name: "Orbits", exact: true }).waitFor()
    expect(await p.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1)
    await p.context().close()
  })
})

describe("keys (flyingrobots/school#84)", () => {
  test.each([["↓", "ArrowDown"], ["j", "j"]])("%s steps through the lesson's sections and blocks in reading order, scrolling each into view", async (_, key) => {
    const p = await open(main, lessonPath("keys"))
    // From the breadcrumb's last link, the first focus stop above the lesson.
    await p.locator("[data-lesson=root] nav[aria-label=breadcrumb] a").last().focus()
    const seen: string[] = []
    const ys: number[] = []
    for (let i = 0; i < 10; i++) {
      await p.keyboard.press(key)
      const at = await p.evaluate(() => {
        const el = document.activeElement
        const stop = el?.getAttribute("data-lesson-block") ?? (el?.closest("[data-lesson=section]") && el.matches("h2") ? `section: ${el.textContent}` : null)
        return { stop, y: window.scrollY }
      })
      seen.push(at.stop ?? "elsewhere")
      ys.push(at.y)
    }
    expect(seen).toEqual([
      "section: Where the planets are", "prose", "quiz", "card", "aside",
      "section: Why the seasons turn", "quote", "prose", "explain", "nest",
    ])
    // The page scrolls to follow, and never back up.
    expect(ys.at(-1)!).toBeGreaterThan(0)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    await p.context().close()
  })
})

describe("the server down", () => {
  test("while answering, the answer is never shown as saved; once it is back, it is", async () => {
    const down = await stack(join(root, "down-state"))
    try {
      const p = await open(down, lessonPath("down"))
      down.school.proc.kill("SIGKILL")
      await down.school.proc.exited

      const q = quiz(p, "closest")
      await q.locator("[data-choice=mercury]").click()
      await q.locator("[data-quiz=error]").waitFor()
      expect(await stateOf(q)).toBe("unanswered")
      expect(await q.locator("[data-verdict]").count()).toBe(0)
      expect(await q.locator("[data-quiz=why]").count()).toBe(0)

      const x = explain(p, "seasons")
      await x.locator("[data-explain=draft]").fill("The tilt.")
      await x.locator("[data-explain=save]").click()
      await x.locator("[data-explain=error]").waitFor()
      expect(await stateOf(x)).toBe("empty")
      expect(await x.locator("[data-explain=draft]").inputValue()).toBe("The tilt.") // nothing typed is lost
      expect(await x.locator("[data-explain=model]").count()).toBe(0)

      // School comes back on the same state (on a new port, which the page's route follows); the same page saves both.
      down.school = await startSchool(down.env)
      await q.locator("[data-choice=mercury]").click()
      await p.waitForFunction(() => document.querySelector("[data-quiz-id=closest]")?.getAttribute("data-state") === "right")
      await x.locator("[data-explain=save]").click()
      await p.waitForFunction(() => document.querySelector("[data-explain-id=seasons]")?.getAttribute("data-state") === "saved")
      expect((await record(down, "down")).answers).toEqual([{ blockId: "closest", choiceId: "mercury", correct: true }])
      await p.context().close()
    } finally {
      await stop(down)
    }
  }, timeout(2) + 15_000)

  test("when the lesson cannot load, the page says so and offers a retry", async () => {
    const p = await newPage()
    await p.route("**/api/courses/**", (route) => route.abort())
    await p.goto(base + lessonPath("golden"))
    await p.getByRole("heading", { level: 1, name: "The lesson did not load", exact: true }).waitFor()
    await p.unroute("**/api/courses/**")
    await p.getByRole("button", { name: "Try again" }).click()
    await p.getByRole("heading", { level: 1, name: "Orbits", exact: true }).waitFor()
    await p.context().close()
  })
})
