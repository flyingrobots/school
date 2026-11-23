// Courses named by their title (flyingrobots/school#143), driven in Chrome against the Vite dev
// server, with the page's /api requests answered by a real School server over real course folders.
// Oracles are the issue's acceptance items: the sidebar, Home, the course page and the breadcrumbs
// name a course by the title its course.json declares; a course that declares none is named by its
// slug; and the slug, never the title, is what the addresses carry.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { startSchool, timeout, type Started } from "../../server/testing/processes.ts"

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
    type: "page", id: "l1", title, subtitle: `About ${title.toLowerCase()}`,
    children: [{ type: "quiz", id: "q1", q: "Which?", why: "Because.", choices: [{ id: "a", text: "A", correct: false }, { id: "b", text: "B", correct: true }] }],
  })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-course-title-"))
  // aion declares a title; plain declares none. aion comes first by name, so Home starts there.
  for (const [name, title] of [["aion", "Orbits"], ["plain", "Cells"]] as const) {
    mkdirSync(join(root, name, "lessons"), { recursive: true })
    mkdirSync(join(root, name, "reference"), { recursive: true })
    writeFileSync(join(root, name, "lessons", "0001.json"), lesson(title))
    writeFileSync(join(root, name, "reference", "glossary.html"), "<p>Glossary</p>")
  }
  writeFileSync(join(root, "aion", "course.json"), JSON.stringify({ title: TITLE }))
  school = await startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
    SCHOOL_COURSES: ["aion", "plain"].map((c) => `${c}=${join(root, c)}`).join(","),
  })
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

async function context(): Promise<BrowserContext> {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    await route.fulfill({ response: await route.fetch({ url: school.url + u.pathname + u.search }) })
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
const sidebarLink = (p: Page, course: string) => p.locator(`[data-nav-region=sidebar] a[data-course=${course}]`)
/** The breadcrumb's text, its items joined by " / ". */
const crumbs = (p: Page) =>
  p.locator("nav[aria-label=breadcrumb] li[data-slot=breadcrumb-item]").evaluateAll((els) => els.map((e) => e.textContent?.trim()).join(" / "))

describe("the sidebar", () => {
  test("names each course by its title, and by its slug when it declares none, linking by slug", async () => {
    const p = await open("/")
    await sidebarLink(p, "aion").waitFor()
    expect((await sidebarLink(p, "aion").textContent())?.trim()).toBe(TITLE)
    expect(await sidebarLink(p, "aion").getAttribute("href")).toBe("/courses/aion")
    expect((await sidebarLink(p, "plain").textContent())?.trim()).toBe("plain")
    expect(await sidebarLink(p, "plain").getAttribute("href")).toBe("/courses/plain")
    await p.context().close()
  })
})

describe("Home", () => {
  test("names each course in the list by its title, falling back to the slug", async () => {
    const p = await open("/")
    const item = (c: string) => main(p).locator(`a[data-course=${c}]`)
    await item("aion").waitFor()
    expect(await item("aion").locator("[data-slot=item-title]").textContent()).toBe(TITLE)
    expect(await item("aion").getAttribute("href")).toBe("/courses/aion")
    expect(await item("plain").locator("[data-slot=item-title]").textContent()).toBe("plain")
    await p.context().close()
  })

  test("names the course of the lesson to study now by its title", async () => {
    const p = await open("/")
    const resume = main(p).locator("[data-resume]")
    await resume.waitFor()
    // The title comes from the course list, which may answer after the resume card.
    await p.waitForFunction((t) => document.querySelector("[data-resume]")?.textContent?.includes(`Lesson 1 of 1 in ${t}`), TITLE)
    const all = resume.getByRole("link", { name: `All lessons in ${TITLE}` })
    expect(await all.getAttribute("href")).toBe("/courses/aion")
    expect(await resume.textContent()).not.toContain("in aion")
    await p.context().close()
  })
})

describe("the course page", () => {
  test("its heading and breadcrumb name the course by its title", async () => {
    const p = await open("/courses/aion")
    await main(p).locator("[data-lesson]").first().waitFor()
    expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe(TITLE)
    expect(await crumbs(p)).toBe(`Home / ${TITLE}`)
    await p.context().close()
  })

  test("a course that declares no title is named by its slug", async () => {
    const p = await open("/courses/plain")
    await main(p).locator("[data-lesson]").first().waitFor()
    expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe("plain")
    expect(await crumbs(p)).toBe("Home / plain")
    await p.context().close()
  })
})

describe("breadcrumbs below a course", () => {
  test("the reference page's breadcrumb names the course by its title and links by slug", async () => {
    const p = await open("/courses/aion/reference")
    await main(p).locator("[data-reference]").first().waitFor()
    expect(await crumbs(p)).toBe(`Home / ${TITLE} / Reference`)
    expect(await p.locator("nav[aria-label=breadcrumb]").getByRole("link", { name: TITLE }).getAttribute("href")).toBe("/courses/aion")
    await p.context().close()
  })

  test("the lesson page's breadcrumb names the course by its title and links by slug", async () => {
    const p = await open("/courses/aion/lessons/l1")
    // Both the course list (the title) and the lesson (its crumb) have answered.
    await p.waitForFunction((t) => [t, "Orbits"].every((s) => document.querySelector("nav[aria-label=breadcrumb]")?.textContent?.includes(s)), TITLE)
    expect(await crumbs(p)).toBe(`Home / ${TITLE} / Orbits`)
    expect(await p.locator("nav[aria-label=breadcrumb]").getByRole("link", { name: TITLE }).getAttribute("href")).toBe("/courses/aion")
    await p.context().close()
  })

  test("the slides view's breadcrumb names the course by its title", async () => {
    const p = await open("/courses/aion/lessons/l1?view=slides")
    // Both the course list (the title) and the lesson (its crumb) have answered.
    await p.waitForFunction((t) => [t, "Orbits"].every((s) => document.querySelector("nav[aria-label=breadcrumb]")?.textContent?.includes(s)), TITLE)
    expect(await crumbs(p)).toBe(`Home / ${TITLE} / Orbits`)
    await p.context().close()
  })

  test("a lesson in a course that declares no title has its slug in the breadcrumb", async () => {
    const p = await open("/courses/plain/lessons/l1")
    await p.waitForFunction(() => document.querySelector("nav[aria-label=breadcrumb]")?.textContent?.includes("Cells"))
    // Wait for the course list too, so the slug is the fallback, not a list still loading.
    await sidebarLink(p, "plain").waitFor()
    expect(await crumbs(p)).toBe("Home / plain / Cells")
    await p.context().close()
  })
})
