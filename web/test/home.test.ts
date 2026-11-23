// The home page (flyingrobots/school#39), driven in Chrome against the Vite dev server, with the
// page's /api requests answered by real School servers over real course folders: one whose learner
// has studied, one whose record is fresh. Failures are stubbed routes.
// Oracles are the issue's acceptance items and RFC 2 §4.3: every course from GET /api/courses is
// listed with its progress in words, never a percentage or a score; where the learner left off
// (GET /api/resume) comes first and one key continues it; loading shows Skeletons and a Spinner;
// an API failure is shown, not swallowed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { startSchool, timeout, type Started } from "../../server/testing/processes.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")

let vite: ViteDevServer
let studied: Started
let fresh: Started
let browser: Browser
let base = ""
let root = ""

const quiz = (id: string) => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
})
const lesson = (id: string, title: string, quizzes: string[]) =>
  JSON.stringify({ type: "page", id, title, subtitle: `About ${title.toLowerCase()}`, children: quizzes.map(quiz) })

type CourseJson = { name: string; lessons: number | null; reference: number; quizzes: number | null; answeredCorrectly: number | null }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-home-page-"))
  // aion: three lessons, the third a reading lesson; bio: one lesson and a reference document;
  // empty: no lessons folder; broken: lessons that never validated.
  mkdirSync(join(root, "aion", "lessons"), { recursive: true })
  writeFileSync(join(root, "aion", "lessons", "0001.json"), lesson("l1", "Orbits", ["q1", "q2"]))
  writeFileSync(join(root, "aion", "lessons", "0002.json"), lesson("l2", "Tides", ["q3", "q4", "q5"]))
  writeFileSync(join(root, "aion", "lessons", "0003.json"), lesson("l3", "Reading", []))
  mkdirSync(join(root, "bio", "lessons"), { recursive: true })
  mkdirSync(join(root, "bio", "reference"), { recursive: true })
  writeFileSync(join(root, "bio", "lessons", "0001.json"), lesson("c1", "Cells", ["q9"]))
  writeFileSync(join(root, "bio", "reference", "glossary.html"), "<p>Glossary</p>")
  mkdirSync(join(root, "empty"), { recursive: true })
  mkdirSync(join(root, "broken", "lessons"), { recursive: true })
  writeFileSync(join(root, "broken", "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "b1", title: "B", subtitle: "", children: [{ ref: "missing" }] }))

  const env = (state: string) => ({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, state), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${join(root, state, "record")}`, // each server its own PGlite record
    SCHOOL_COURSES: ["aion", "bio", "empty", "broken"].map((c) => `${c}=${join(root, c)}`).join(","),
  })
  studied = await startSchool(env("studied"))
  fresh = await startSchool(env("fresh"))

  // The learner got q1 right in Orbits, then moved on to Tides and got q3 right, so Tides is where
  // they left off, with q4 the next question to answer.
  const answer = async (lessonId: string, blockId: string) => {
    const opened = await (await fetch(`${studied.url}/api/courses/aion/lessons/${lessonId}`)).json()
    const r = await fetch(`${studied.url}/api/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionId: crypto.randomUUID(), encounterId: opened.encounterId, blockId, choiceId: "right", ms: 10 }),
    })
    expect(r.status).toBe(200)
  }
  await answer("l1", "q1")
  await answer("l2", "q3")

  vite = await createServer({ root: web, configFile: join(web, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
  browser = await chromium.launch({ channel: "chrome" })
}, timeout(2) + 20_000)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  for (const s of [studied, fresh]) {
    s?.proc.kill()
    await s?.proc.exited
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A browser context whose /api requests reach `school`. */
async function context(school = studied, viewport = { width: 1280, height: 900 }, reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<BrowserContext> {
  const c = await browser.newContext({ viewport, reducedMotion })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    await route.fulfill({ response: await route.fetch({ url: school.url + u.pathname + u.search }) })
  })
  return c
}

async function open(c?: BrowserContext): Promise<Page> {
  const p = await (c ?? (await context())).newPage()
  p.setDefaultTimeout(5_000)
  await p.goto(base + "/")
  await p.getByRole("heading", { level: 1 }).waitFor()
  return p
}

const main = (p: Page) => p.locator("[data-nav-region=main]")
const courses = (p: Page) => main(p).locator("[data-course]")
const resume = (p: Page) => main(p).locator("[data-resume]")
const api = async <T>(school: Started, path: string): Promise<T> => (await fetch(school.url + path)).json() as Promise<T>

/** The oracle for a course's progress in words, from GET /api/courses. */
const words = (c: CourseJson) =>
  c.lessons === null ? "Its lessons could not be read"
  : c.lessons === 0 ? "No lessons yet"
  : c.quizzes === 0 ? "No quizzes"
  : `${c.answeredCorrectly} of ${c.quizzes} ${c.quizzes === 1 ? "quiz" : "quizzes"} answered correctly`

describe("a learner who has studied", () => {
  test("lists every course, in order, with its progress in words, matching the API", async () => {
    const expected = await api<CourseJson[]>(studied, "/api/courses")
    expect(expected.map((c) => c.name)).toEqual(["aion", "bio", "broken", "empty"]) // the server lists courses by name
    expect(expected[0]).toMatchObject({ quizzes: 5, answeredCorrectly: 2 })
    const p = await open()
    await courses(p).first().waitFor()
    expect(await courses(p).count()).toBe(expected.length)
    for (const [i, c] of expected.entries()) {
      const item = courses(p).nth(i)
      expect(await item.getAttribute("data-course")).toBe(c.name)
      const text = await item.textContent()
      expect(text).toContain(c.name)
      expect(text).toContain(words(c))
    }
    expect(await courses(p).nth(0).textContent()).toContain("3 lessons")
    expect(await courses(p).nth(1).textContent()).toContain("1 lesson and a reference")
    await p.context().close()
  })

  test("shows no percentage, letter or score", async () => {
    const p = await open()
    await courses(p).first().waitFor()
    await resume(p).waitFor()
    const text = (await main(p).textContent()) ?? ""
    expect(text).not.toMatch(/%|\bscore|\bgrade\b|\d+\s*\/\s*\d+/i)
    expect(await main(p).locator("[role=progressbar], [data-slot=progress]").count()).toBe(0)
    await p.context().close()
  })

  test("comes first with the lesson to continue: its progress and the next question, linking to it", async () => {
    const expected = await api<{ kind: string; lesson: { id: string } }>(studied, "/api/resume")
    expect(expected).toMatchObject({ kind: "continue", course: "aion", question: "Question q4?", lesson: { id: "l2", quizzes: 3, answeredCorrectly: 1 } })
    const p = await open()
    await resume(p).waitFor()
    const text = (await resume(p).textContent()) ?? ""
    expect(text).toContain("Pick up where you left off")
    expect(text).toContain("Tides")
    expect(text).toContain("1 of 3 quizzes answered correctly")
    expect(text).toContain("Question q4?")
    const go = resume(p).getByRole("link", { name: /Continue/ })
    expect(await go.getAttribute("href")).toBe("/courses/aion/lessons/l2")
    // Nothing in the page's content comes before it (the shell's header buttons are not the page's).
    const first = await main(p).locator("[data-nav]").evaluateAll((els) => els.find((e) => e.closest("header") === null)?.getAttribute("href"))
    expect(first).toBe("/courses/aion/lessons/l2")
    await p.context().close()
  })

  test("Enter, straight after the page loads, continues the lesson", async () => {
    const p = await open()
    await resume(p).waitFor()
    await p.waitForFunction(() => document.activeElement?.getAttribute("href") === "/courses/aion/lessons/l2")
    await p.keyboard.press("Enter")
    await p.waitForURL(base + "/courses/aion/lessons/l2")
    await p.context().close()
  })

  test("j reaches every course in order, and Enter opens the focused one", async () => {
    const p = await open()
    await courses(p).first().waitFor()
    const hrefs = await main(p).locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("href")))
    const at = () => p.evaluate(() => {
      const all = [...document.querySelectorAll("[data-nav-region=main] [data-nav]")]
      return all.indexOf(document.activeElement as Element)
    })
    for (const name of ["aion", "bio", "broken", "empty"]) {
      const target = hrefs.indexOf(`/courses/${name}`)
      expect(target).toBeGreaterThanOrEqual(0)
      for (let i = await at(); i < target; i++) await p.keyboard.press("j")
      expect(await p.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(`/courses/${name}`)
    }
    await p.keyboard.press("k")
    expect(await p.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/courses/broken")
    await p.keyboard.press("Enter")
    await p.waitForURL(base + "/courses/broken")
    await p.context().close()
  })

  test("uses the width: one column on a phone, the lesson and the courses side by side on a laptop", async () => {
    const layout = async (viewport: { width: number; height: number }) => {
      // Reduced motion, so the entrance timeline's offsets are not measured as layout.
      const p = await open(await context(studied, viewport, "reduce"))
      await courses(p).first().waitFor()
      await resume(p).waitFor()
      const box = async (l: ReturnType<typeof resume>) => (await l.boundingBox())!
      const [r, c] = [await box(resume(p)), await box(courses(p).first())]
      await p.context().close()
      return { sideBySide: c.x >= r.x + r.width, stacked: Math.round(c.x) === Math.round(r.x) && c.y > r.y + r.height }
    }
    expect(await layout({ width: 390, height: 844 })).toEqual({ sideBySide: false, stacked: true })
    expect(await layout({ width: 1280, height: 900 })).toEqual({ sideBySide: true, stacked: false })
  })
})

describe("a fresh record", () => {
  test("starts at the first lesson of the first course", async () => {
    expect(await api(fresh, "/api/resume")).toMatchObject({ kind: "start", course: "aion", lastStudied: null, lesson: { id: "l1" } })
    const p = await open(await context(fresh))
    await resume(p).waitFor()
    const text = (await resume(p).textContent()) ?? ""
    expect(text).toContain("Start here")
    expect(text).toContain("Orbits")
    expect(await resume(p).getByRole("link", { name: /Start/ }).getAttribute("href")).toBe("/courses/aion/lessons/l1")
    await p.context().close()
  })
})

describe("states", () => {
  test("while the requests are in flight, it shows Skeletons and a Spinner, then the page", async () => {
    const c = await context()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await c.route(/\/api\/(courses|resume)$/, async (route) => {
      await held
      await route.fallback()
    })
    const p = await open(c)
    await main(p).locator("[data-slot=skeleton]").first().waitFor()
    expect(await main(p).locator("[data-slot=spinner], [role=status]").count()).toBeGreaterThan(0)
    expect(await courses(p).count()).toBe(0)
    release()
    await courses(p).first().waitFor()
    await resume(p).waitFor()
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await c.close()
  })

  test("a course list that cannot be loaded is reported, and Try again recovers", async () => {
    const c = await context()
    let refuse = true
    await c.route(/\/api\/courses$/, (route) => (refuse ? route.abort("connectionrefused") : route.fallback()))
    const p = await open(c)
    const alert = main(p).getByRole("alert")
    await alert.waitFor()
    expect(await alert.textContent()).toContain("Your courses could not be loaded")
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    refuse = false
    await alert.getByRole("button", { name: "Try again" }).click()
    await courses(p).first().waitFor()
    expect(await main(p).getByRole("alert").count()).toBe(0)
    await c.close()
  })

  test("where the learner left off failing is reported, and the courses are still listed", async () => {
    const c = await context()
    await c.route(/\/api\/resume$/, (route) => route.fulfill({ status: 500, json: { error: "the record is unavailable" } }))
    const p = await open(c)
    const alert = main(p).getByRole("alert")
    await alert.waitFor()
    const text = await alert.textContent()
    expect(text).toContain("Where you left off could not be loaded")
    expect(text).toContain("the record is unavailable")
    await courses(p).first().waitFor()
    expect(await courses(p).count()).toBe(4)
    await c.close()
  })

  test("no courses at all says so", async () => {
    const c = await context()
    await c.route(/\/api\/courses$/, (route) => route.fulfill({ json: [] }))
    await c.route(/\/api\/resume$/, (route) => route.fulfill({ json: { kind: "nothing" } }))
    const p = await open(c)
    const empty = main(p).locator("[data-slot=empty]")
    await empty.waitFor()
    expect(await empty.textContent()).toContain("No courses yet")
    expect(await resume(p).count()).toBe(0)
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await c.close()
  })
})
