// The lesson page (flyingrobots/school#42), driven in a real browser: Chrome through playwright-core,
// against the Vite dev server proxying /api to a real School process on the development course in
// test/fixtures/course. Oracles are the issue's acceptance items:
// - a wrong then right answer is recorded, and a reload shows what the record holds;
// - an explanation is saved before grading, and a failed grading offers a retry;
// - the server being down while answering never shows the answer as saved;
// - a lesson id that does not exist shows a not-found state.
// What a reload shows is the learner history's oracle (server/contract/learner-history.ts,
// `pageShows`): each quiz by its latest answer, each explanation by its latest grading.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { freePort, startSchool, timeout, type Started } from "../../server/testing/processes.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")
const COURSE = join(import.meta.dir, "fixtures", "course")
const TOKEN = "lesson-page-test-token"

// Each test that writes to the record uses its own course name, all served from the one fixture,
// so no test resumes an encounter another test opened.
const NAMES = ["golden", "wrong", "saved", "failed", "keys", "aid", "pager", "loading", "down"] as const
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

/** School and a Vite dev server in front of it, as the browser sees them. */
type Stack = { school: Started; vite: ViteDevServer; base: string; api: string; env: Record<string, string | undefined> }

async function stack(state: string): Promise<Stack> {
  const port = freePort()
  const env = {
    ...process.env,
    SCHOOL_COURSE: undefined,
    SCHOOL_COURSES: NAMES.map((n) => `${n}=${COURSE}`).join(","),
    SCHOOL_STATE: state,
    SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""),
    SCHOOL_BRIDGE_TOKEN: TOKEN,
    HOST: "127.0.0.1",
    PORT: String(port),
  }
  const school = await startSchool(env)
  const vite = await createServer({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: school.url, changeOrigin: true } } },
  })
  await vite.listen()
  return { school, vite, base: vite.resolvedUrls!.local[0]!.replace(/\/$/, ""), api: school.url, env }
}

async function stop(s: Stack | undefined) {
  if (!s) return
  s.school.proc.kill("SIGKILL")
  await s.school.proc.exited
  await s.vite.close()
}

let browser: Browser
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
  // A missing Chrome fails here, loudly; it is never a skip.
  browser = await chromium.launch({ channel: "chrome" })
}, timeout(1) + 10_000)

afterAll(async () => {
  await browser?.close()
  await stop(main)
  bridge?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const lessonPath = (course: Name, lesson = "orbits") => `/courses/${course}/lessons/${lesson}`

async function newPage(): Promise<Page> {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  p.setDefaultTimeout(5_000)
  return p
}

/** Opens a lesson and waits for it to be playable: its title is the page heading. */
async function open(s: Stack, path: string, title = "Orbits", page?: Page): Promise<Page> {
  const p = page ?? (await newPage())
  await p.goto(s.base + path)
  await p.getByRole("heading", { level: 1, name: title, exact: true }).waitFor()
  return p
}

const quiz = (p: Page, id: string) => p.locator(`[data-quiz=root][data-quiz-id="${id}"]`)
const explain = (p: Page, id: string) => p.locator(`[data-explain=root][data-explain-id="${id}"]`)
const stateOf = async (l: ReturnType<Page["locator"]>) => l.getAttribute("data-state")

/** The lesson as the API returns it, read straight from School, bypassing the page. */
const record = async (s: Stack, course: Name, lesson = "orbits") =>
  (await (await fetch(`${s.api}/api/courses/${course}/lessons/${lesson}`)).json()) as {
    answers: { blockId: string; choiceId: string; correct: boolean }[]
    explanations: { blockId: string; text: string; grading: { status: string } | null }[]
  }

describe("golden path", () => {
  test("study a lesson: prose, a wrong then right answer, an explanation saved then graded after a retry, and a reload shows it all", async () => {
    const p = await open(main, lessonPath("golden"))

    // Prose is the lesson's HTML, rendered through the markdown item, not shown as markup.
    const prose = p.locator("[data-lesson-block=prose]").first()
    expect(await prose.locator("[data-slot=markdown] strong").textContent()).toBe("circular")
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
    await p.goto(main.base + path)
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
      await route.continue()
    })
    await p.goto(main.base + lessonPath("loading"))
    await p.locator("[data-lesson=loading]").waitFor()
    expect(await p.locator("[data-lesson=loading] [data-slot=skeleton]").count()).toBeGreaterThan(0)
    expect(await p.locator("[data-lesson=loading] [data-slot=spinner], [data-lesson=loading] [role=status]").count()).toBeGreaterThan(0)
    release()
    await p.getByRole("heading", { level: 1, name: "Orbits", exact: true }).waitFor()
    expect(await p.locator("[data-lesson=loading]").count()).toBe(0)
    await p.context().close()
  })
})

describe("exposures are not claimed", () => {
  test("the page opens the lesson without ?aid=, since it does not record exposures yet (flyingrobots/school#51)", async () => {
    const p = await newPage()
    const asked: string[] = []
    p.on("request", (r) => {
      if (r.url().includes("/api/courses/")) asked.push(r.url())
    })
    await open(main, lessonPath("aid"), "Orbits", p)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.filter((u) => new URL(u).searchParams.has("aid"))).toEqual([])
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
  test("↓ and j step through the lesson's blocks in order, scrolling each into view", async () => {
    const p = await open(main, lessonPath("keys"))
    const at = () =>
      p.evaluate(() => {
        const el = document.activeElement
        return { block: el?.getAttribute("data-lesson-block") ?? el?.closest("[data-lesson-block]")?.getAttribute("data-lesson-block") ?? null, y: window.scrollY }
      })
    const seen: string[] = []
    for (let i = 0; i < 30; i++) {
      await p.keyboard.press(i % 2 ? "j" : "ArrowDown")
      const { block } = await at()
      if (block && seen.at(-1) !== block) seen.push(block)
    }
    // Every kind of block is a stop, in the lesson's order.
    expect(seen).toEqual(["prose", "quiz", "card", "aside", "quote", "prose", "explain", "nest"])
    expect((await at()).y).toBeGreaterThan(0)
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

      // School comes back on the same port and state; the same page saves both.
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
    await p.goto(main.base + lessonPath("golden"))
    await p.getByRole("heading", { level: 1, name: "The lesson did not load", exact: true }).waitFor()
    await p.unroute("**/api/courses/**")
    await p.getByRole("button", { name: "Try again" }).click()
    await p.getByRole("heading", { level: 1, name: "Orbits", exact: true }).waitFor()
    await p.context().close()
  })
})
