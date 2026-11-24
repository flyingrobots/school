// Courses named by their title (flyingrobots/school#143), driven in Chrome against the Vite dev
// server, with the page's /api requests answered by a real School server over real course folders.
// Oracles are the issue's acceptance items: the sidebar, Home, the course page and the breadcrumbs
// name a course by the title its course.json declares; a course that declares none is named by its
// slug; and the slug, never the title, is what the addresses carry.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import {
  startSchool,
  timeout,
  type Started,
} from "../../server/testing/processes.ts"
import { close } from "./routes.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")
const TITLE = "AIΩN Foundations"

let vite: ViteDevServer
let school: Started
let browser: Browser
let base = ""
let root = ""

const lesson = (title: string) =>
  JSON.stringify({
    type: "page",
    id: "l1",
    title,
    subtitle: `About ${title.toLowerCase()}`,
    children: [
      {
        type: "quiz",
        id: "q1",
        q: "Which?",
        why: "Because.",
        choices: [
          { id: "a", text: "A", correct: false },
          { id: "b", text: "B", correct: true },
        ],
      },
    ],
  })

beforeAll(
  async () => {
    root = mkdtempSync(join(tmpdir(), "school-course-title-"))
    // aion declares a title; plain declares none. aion comes first by name, so Home's hero starts there.
    for (const [name, title] of [
      ["aion", "Orbits"],
      ["plain", "Cells"],
    ] as const) {
      mkdirSync(join(root, name, "lessons"), { recursive: true })
      mkdirSync(join(root, name, "reference"), { recursive: true })
      writeFileSync(join(root, name, "lessons", "0001.json"), lesson(title))
      writeFileSync(
        join(root, name, "reference", "glossary.html"),
        "<p>Glossary</p>"
      )
    }
    writeFileSync(
      join(root, "aion", "course.json"),
      JSON.stringify({ title: TITLE })
    )
    school = await startSchool({
      ...process.env,
      HOST: "127.0.0.1",
      SCHOOL_STATE: join(root, "state"),
      SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
      SCHOOL_COURSES: ["aion", "plain"]
        .map((c) => `${c}=${join(root, c)}`)
        .join(","),
    })
    vite = await createServer({
      root: web,
      configFile: join(web, "vite.config.ts"),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    })
    await vite.listen()
    base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
    browser = await chromium.launch({ channel: "chrome" })
  },
  timeout(1) + 20_000
)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  school?.proc.kill()
  await school?.proc.exited
  if (root) rmSync(root, { recursive: true, force: true })
})

async function context(): Promise<BrowserContext> {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    await route.fulfill({
      response: await route.fetch({ url: school.url + u.pathname + u.search }),
    })
  })
  return c
}

async function open(path: string): Promise<Page> {
  const p = await (await context()).newPage()
  p.setDefaultTimeout(5_000)
  await p.goto(base + path)
  await p.getByRole("heading", { level: 1 }).waitFor()
  return p
}

const main = (p: Page) => p.locator("[data-nav-region=main]")
const sidebarLink = (p: Page, course: string) =>
  p.locator(`[data-nav-region=sidebar] a[data-course=${course}]`)
/** The breadcrumb's text, its items joined by " / ". */
const crumbs = (p: Page) =>
  p
    .locator("nav[aria-label=breadcrumb] li[data-slot=breadcrumb-item]")
    .evaluateAll((els) => els.map((e) => e.textContent?.trim()).join(" / "))

describe("the sidebar", () => {
  test("names each course by its title, and by its slug when it declares none, linking by slug", async () => {
    const p = await open("/")
    await sidebarLink(p, "aion").waitFor()
    expect((await sidebarLink(p, "aion").textContent())?.trim()).toBe(TITLE)
    expect(await sidebarLink(p, "aion").getAttribute("href")).toBe(
      "/courses/aion"
    )
    expect((await sidebarLink(p, "plain").textContent())?.trim()).toBe("plain")
    expect(await sidebarLink(p, "plain").getAttribute("href")).toBe(
      "/courses/plain"
    )
    await close(p.context())
  })
})

describe("Home", () => {
  test("the hero names its course by its title", async () => {
    const p = await open("/")
    const hero = main(p).locator("[data-hero]")
    await hero.waitFor()
    // A fresh record, so the hero starts the first course, aion, by name.
    expect(await hero.textContent()).toContain(
      `${TITLE} · Lesson 1 of 1: Orbits`
    )
    expect(await hero.textContent()).not.toContain("aion ·")
    expect(
      await hero
        .getByRole("link", { name: "See all 1 lessons" })
        .getAttribute("href")
    ).toBe("/courses/aion")
    await close(p.context())
  })

  test("what's ahead names a course that declares no title by its slug", async () => {
    const p = await open("/")
    const card = main(p).locator("[data-ahead='plain:l1']")
    await card.waitFor()
    expect(await card.textContent()).toContain("plain")
    expect(await card.getAttribute("href")).toBe("/courses/plain/lessons/l1")
    await close(p.context())
  })
})

describe("the course page", () => {
  test("its heading and breadcrumb name the course by its title", async () => {
    const p = await open("/courses/aion")
    await main(p).locator("[data-lesson]").first().waitFor()
    expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe(TITLE)
    expect(await crumbs(p)).toBe(`Home / ${TITLE}`)
    await close(p.context())
  })

  test("a course that declares no title is named by its slug", async () => {
    const p = await open("/courses/plain")
    await main(p).locator("[data-lesson]").first().waitFor()
    expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe(
      "plain"
    )
    expect(await crumbs(p)).toBe("Home / plain")
    await close(p.context())
  })
})

describe("breadcrumbs below a course", () => {
  test("the reference page's breadcrumb names the course by its title and links by slug", async () => {
    const p = await open("/courses/aion/reference")
    await main(p).locator("[data-reference]").first().waitFor()
    expect(await crumbs(p)).toBe(`Home / ${TITLE} / Reference`)
    expect(
      await p
        .locator("nav[aria-label=breadcrumb]")
        .getByRole("link", { name: TITLE })
        .getAttribute("href")
    ).toBe("/courses/aion")
    await close(p.context())
  })

  test("the lesson page's breadcrumb names the course by its title and links by slug", async () => {
    const p = await open("/courses/aion/lessons/l1")
    // Both the course list (the title) and the lesson (its crumb) have answered.
    await p.waitForFunction(
      (t) =>
        [t, "Orbits"].every((s) =>
          document
            .querySelector("nav[aria-label=breadcrumb]")
            ?.textContent?.includes(s)
        ),
      TITLE
    )
    expect(await crumbs(p)).toBe(`Home / ${TITLE} / Orbits`)
    expect(
      await p
        .locator("nav[aria-label=breadcrumb]")
        .getByRole("link", { name: TITLE })
        .getAttribute("href")
    ).toBe("/courses/aion")
    await close(p.context())
  })

  test("the slides view's breadcrumb names the course by its title", async () => {
    const p = await open("/courses/aion/lessons/l1?view=slides")
    // Both the course list (the title) and the lesson (its crumb) have answered.
    await p.waitForFunction(
      (t) =>
        [t, "Orbits"].every((s) =>
          document
            .querySelector("nav[aria-label=breadcrumb]")
            ?.textContent?.includes(s)
        ),
      TITLE
    )
    expect(await crumbs(p)).toBe(`Home / ${TITLE} / Orbits`)
    await close(p.context())
  })

  test("a lesson in a course that declares no title has its slug in the breadcrumb", async () => {
    const p = await open("/courses/plain/lessons/l1")
    await p.waitForFunction(() =>
      document
        .querySelector("nav[aria-label=breadcrumb]")
        ?.textContent?.includes("Cells")
    )
    // Wait for the course list too, so the slug is the fallback, not a list still loading.
    await sidebarLink(p, "plain").waitFor()
    expect(await crumbs(p)).toBe("Home / plain / Cells")
    await close(p.context())
  })
})
