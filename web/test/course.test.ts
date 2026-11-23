// The course page (flyingrobots/school#40), driven in Chrome against the Vite dev server, with the
// page's /api requests answered by a real School server over real course folders.
// Oracles are the issue's acceptance items: the progress shown matches GET /api/courses/:c, in
// words ("1 of 2 quizzes answered correctly"), never a percentage or a score; a course with no
// lessons and an unreadable course each show a clear state; loading shows Skeleton and Spinner.
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
let school: Started
let browser: Browser
let base = ""
let root = ""

const quiz = (id: string) => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
})
const lesson = (id: string, title: string, quizzes: string[]) =>
  JSON.stringify({ type: "page", id, title, subtitle: `About ${title.toLowerCase()}`, children: quizzes.map(quiz) })

type CourseJson = { name: string; reference: string[]; lessons: { id: string; title: string; quizzes: number; answeredCorrectly: number }[] }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-course-page-"))
  // aion: three lessons, with progress in two of them and no quizzes in the third.
  mkdirSync(join(root, "aion", "lessons"), { recursive: true })
  mkdirSync(join(root, "aion", "reference"), { recursive: true })
  writeFileSync(join(root, "aion", "lessons", "0001.json"), lesson("l1", "Orbits", ["q1", "q2"]))
  writeFileSync(join(root, "aion", "lessons", "0002.json"), lesson("l2", "Tides", ["q3", "q4", "q5"]))
  writeFileSync(join(root, "aion", "lessons", "0003.json"), lesson("l3", "Reading", []))
  writeFileSync(join(root, "aion", "reference", "glossary.html"), "<p>Glossary</p>")
  // empty: a course with no lessons directory at all, which the server lists as no lessons.
  mkdirSync(join(root, "empty"), { recursive: true })
  // broken: lessons that never validated, which the server answers with a 500 and its reason.
  mkdirSync(join(root, "broken", "lessons"), { recursive: true })
  writeFileSync(join(root, "broken", "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "b1", title: "B", subtitle: "", children: [{ ref: "missing" }] }))

  // The helper chooses the port (flyingrobots/school#82).
  school = await startSchool({
    ...process.env,
    SCHOOL_COURSES: ["aion", "empty", "broken"].map((c) => `${c}=${join(root, c)}`).join(","),
    SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1",
  })

  // Progress, recorded the way the lesson page records it: l1 has q1 right (after a wrong try),
  // l2 has q3 and q4 right and q5 wrong.
  const answer = async (lessonId: string, picks: [string, string][]) => {
    const opened = await (await fetch(`${school.url}/api/courses/aion/lessons/${lessonId}`)).json()
    for (const [blockId, choiceId] of picks) {
      const r = await fetch(`${school.url}/api/answer`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: crypto.randomUUID(), encounterId: opened.encounterId, blockId, choiceId, ms: 10 }),
      })
      expect(r.status).toBe(200)
    }
  }
  await answer("l1", [["q1", "wrong"], ["q1", "right"]])
  await answer("l2", [["q3", "right"], ["q4", "right"], ["q5", "wrong"]])

  vite = await createServer({ root: web, configFile: join(web, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
  browser = await chromium.launch({ channel: "chrome" })
}, timeout(1) + 20_000)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  school?.proc.kill()
  await school?.proc.exited
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A browser context whose /api requests reach the School server. */
async function context(viewport = { width: 1280, height: 900 }): Promise<BrowserContext> {
  const c = await browser.newContext({ viewport })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    await route.fulfill({ response: await route.fetch({ url: school.url + u.pathname + u.search }) })
  })
  return c
}

async function open(path: string, c?: BrowserContext): Promise<Page> {
  const p = await (c ?? (await context())).newPage()
  p.setDefaultTimeout(5_000)
  await p.goto(base + path)
  await p.getByRole("heading", { level: 1 }).waitFor()
  return p
}

const main = (p: Page) => p.locator("[data-nav-region=main]")
const lessons = (p: Page) => main(p).locator("[data-lesson]")
const api = async (course: string): Promise<CourseJson> => (await fetch(`${school.url}/api/courses/${course}`)).json()

const words = (l: { quizzes: number; answeredCorrectly: number }) =>
  l.quizzes === 0 ? "No quizzes" : `${l.answeredCorrectly} of ${l.quizzes} ${l.quizzes === 1 ? "quiz" : "quizzes"} answered correctly`

describe("a course with lessons", () => {
  test("lists every lesson, in order, with its progress in words, matching the API", async () => {
    const expected = await api("aion")
    expect(expected.lessons.map((l) => [l.id, l.quizzes, l.answeredCorrectly])).toEqual([["l1", 2, 1], ["l2", 3, 2], ["l3", 0, 0]])
    const p = await open("/courses/aion")
    expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe("aion")
    await lessons(p).first().waitFor()
    expect(await lessons(p).count()).toBe(expected.lessons.length)
    for (const [i, l] of expected.lessons.entries()) {
      const item = lessons(p).nth(i)
      expect(await item.getAttribute("data-lesson")).toBe(l.id)
      const text = await item.textContent()
      expect(text).toContain(l.title)
      expect(text).toContain(words(l))
    }
    await p.context().close()
  })

  test("shows no percentage, letter or score", async () => {
    const p = await open("/courses/aion")
    await lessons(p).first().waitFor()
    const text = (await main(p).textContent()) ?? ""
    expect(text).not.toMatch(/%|\bscore|\bgrade\b|\d+\s*\/\s*\d+/i)
    expect(await main(p).locator("[role=progressbar], [data-slot=progress]").count()).toBe(0)
    await p.context().close()
  })

  test("each lesson links to its lesson page, routed on the client", async () => {
    const p = await open("/courses/aion")
    await lessons(p).first().waitFor()
    const links = main(p).getByRole("link", { name: /Tides/ })
    expect(await links.getAttribute("href")).toBe("/courses/aion/lessons/l2")
    await p.evaluate(() => ((window as unknown as { marker: number }).marker = 1))
    await links.click()
    await p.waitForURL(base + "/courses/aion/lessons/l2")
    expect(await p.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1)
    await p.context().close()
  })

  test("the lessons are reachable with j and k, and Enter opens one", async () => {
    const p = await open("/courses/aion")
    await lessons(p).first().waitFor()
    const hrefs = await main(p).locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("href")))
    const first = hrefs.indexOf("/courses/aion/lessons/l1")
    expect(first).toBeGreaterThanOrEqual(0)
    for (let i = 0; i <= first; i++) await p.keyboard.press("j")
    expect(await p.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/courses/aion/lessons/l1")
    await p.keyboard.press("j")
    expect(await p.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/courses/aion/lessons/l2")
    await p.keyboard.press("Enter")
    await p.waitForURL(base + "/courses/aion/lessons/l2")
    await p.context().close()
  })

  test("links to the course's reference when it has reference documents", async () => {
    const p = await open("/courses/aion")
    await lessons(p).first().waitFor()
    expect(await main(p).getByRole("link", { name: /Reference/ }).getAttribute("href")).toBe("/courses/aion/reference")
    await p.context().close()
  })

  test("uses the width: one column on a phone, several on a wide screen", async () => {
    const columns = async (viewport: { width: number; height: number }) => {
      const p = await open("/courses/aion", await context(viewport))
      await lessons(p).first().waitFor()
      const xs = await lessons(p).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
      await p.context().close()
      return new Set(xs).size
    }
    expect(await columns({ width: 390, height: 844 })).toBe(1)
    expect(await columns({ width: 1920, height: 1080 })).toBe(3)
  })
})

describe("states", () => {
  test("while the course loads, it shows Skeletons and a Spinner, then the lessons", async () => {
    const c = await context()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await c.route(/\/api\/courses\/aion$/, async (route) => {
      await held
      await route.fallback()
    })
    const p = await open("/courses/aion", c)
    await main(p).locator("[data-slot=skeleton]").first().waitFor()
    expect(await main(p).locator("[data-slot=spinner], [role=status]").count()).toBeGreaterThan(0)
    expect(await lessons(p).count()).toBe(0)
    release()
    await lessons(p).first().waitFor()
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await c.close()
  })

  test("a course with no lessons says so", async () => {
    expect((await api("empty")).lessons).toEqual([])
    const p = await open("/courses/empty")
    const empty = main(p).locator("[data-slot=empty]")
    await empty.waitFor()
    expect(await empty.textContent()).toContain("No lessons yet")
    expect(await lessons(p).count()).toBe(0)
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await p.context().close()
  })

  test("an unreadable course says it could not be read, with the server's reason", async () => {
    const r = await fetch(`${school.url}/api/courses/broken`)
    expect(r.status).toBe(500)
    const reason = (await r.json()).error as string
    expect(reason).toContain('unknown ref "missing"')
    const p = await open("/courses/broken")
    const alert = main(p).getByRole("alert")
    await alert.waitFor()
    const text = await alert.textContent()
    expect(text).toContain("This course could not be read")
    expect(text).toContain(reason)
    expect(await lessons(p).count()).toBe(0)
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await p.context().close()
  })

  test("a course that does not exist says so", async () => {
    expect((await fetch(`${school.url}/api/courses/nowhere`)).status).toBe(404)
    const p = await open("/courses/nowhere")
    const empty = main(p).locator("[data-slot=empty]")
    await empty.waitFor()
    expect(await empty.textContent()).toContain("There is no course called nowhere")
    await p.context().close()
  })

  test("a server that cannot be reached is reported, not shown as loading forever", async () => {
    const c = await context()
    await c.route(/\/api\/courses\/aion$/, (route) => route.abort("connectionrefused"))
    const p = await open("/courses/aion", c)
    const alert = main(p).getByRole("alert")
    await alert.waitFor()
    expect(await alert.textContent()).toContain("This course could not be loaded")
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await c.close()
  })

  test("Try again asks the server again and shows the lessons once it answers", async () => {
    const c = await context()
    let refuse = true
    await c.route(/\/api\/courses\/aion$/, (route) => (refuse ? route.abort("connectionrefused") : route.fallback()))
    const p = await open("/courses/aion", c)
    await main(p).getByRole("alert").waitFor()
    refuse = false
    await main(p).getByRole("button", { name: "Try again" }).click()
    await lessons(p).first().waitFor()
    expect(await main(p).getByRole("alert").count()).toBe(0)
    await c.close()
  })
})
