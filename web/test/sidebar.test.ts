// The sidebar's course list (flyingrobots/school#95), driven in Chrome against the Vite dev server,
// with the page's /api requests answered by a real School server over real course folders.
// Failures and slow answers are stubbed routes in front of it.
// Oracles are the issue's acceptance items: every course from GET /api/courses is listed on every
// page, in the server's order, each linking to /courses/:course, the current course marked;
// Skeletons only while loading; a failure shown with Try again, which recovers; the list loaded
// once for the visit, not again on each navigation.
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

const lesson = (id: string, title: string) => JSON.stringify({ type: "page", id, title, subtitle: `About ${title.toLowerCase()}`, children: [] })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-sidebar-"))
  // Named out of order on disk, so the list's order is the server's (by name), not the folders'.
  for (const [name, title] of [["zoo", "Animals"], ["aion", "Orbits"], ["bio", "Cells"]] as const) {
    mkdirSync(join(root, name, "lessons"), { recursive: true })
    writeFileSync(join(root, name, "lessons", "0001.json"), lesson("l1", title))
  }
  school = await startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "record")}`,
    SCHOOL_COURSES: ["zoo", "aion", "bio"].map((c) => `${c}=${join(root, c)}`).join(","),
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

/** A browser context whose /api requests reach School, counting the requests for the course list. */
async function context(): Promise<{ c: BrowserContext; listed: () => number }> {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  let n = 0
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    if (u.pathname === "/api/courses") n++
    await route.fulfill({ response: await route.fetch({ url: school.url + u.pathname + u.search }) })
  })
  return { c, listed: () => n }
}

async function open(path: string, c?: BrowserContext): Promise<Page> {
  const p = await (c ?? (await context()).c).newPage()
  p.setDefaultTimeout(5_000)
  await p.goto(base + path)
  await p.getByRole("heading", { level: 1 }).waitFor()
  return p
}

const sidebar = (p: Page) => p.locator("[data-nav-region=sidebar]")
const links = (p: Page) => sidebar(p).locator("a[data-course]")
const skeletons = (p: Page) => sidebar(p).locator("[data-slot=skeleton]")
const hrefs = (p: Page) => links(p).evaluateAll((els) => els.map((e) => e.getAttribute("href")))
const active = (p: Page) => links(p).evaluateAll((els) => els.filter((e) => e.getAttribute("data-active") === "true").map((e) => e.getAttribute("data-course")))
const names = async () => ((await (await fetch(school.url + "/api/courses")).json()) as { name: string }[]).map((c) => c.name)

describe("loaded", () => {
  test.each(["/", "/settings", "/courses/bio", "/courses/aion/reference", "/courses/aion/lessons/l1", "/no/such/page"])(
    "on %s it lists every course from the API, in order, each linking to its course page",
    async (path) => {
      const expected = await names()
      expect(expected).toEqual(["aion", "bio", "zoo"])
      const p = await open(path)
      await links(p).first().waitFor()
      expect(await links(p).evaluateAll((els) => els.map((e) => e.textContent?.trim()))).toEqual(expected)
      expect(await hrefs(p)).toEqual(expected.map((n) => `/courses/${n}`))
      expect(await skeletons(p).count()).toBe(0)
      expect(await sidebar(p).getByRole("alert").count()).toBe(0)
      // The page may still be loading its own content (the lesson, on a lesson page); a request
      // still in its route when the context closes is not this test's concern.
      await p.context().unrouteAll({ behavior: "ignoreErrors" })
      await p.context().close()
    }
  )

  test("marks the current course, on its page and every page under it, and none elsewhere", async () => {
    for (const [path, current] of [["/courses/bio", ["bio"]], ["/courses/aion/lessons/l1", ["aion"]], ["/courses/zoo/reference", ["zoo"]], ["/settings", []], ["/", []]] as const) {
      const p = await open(path)
      await links(p).first().waitFor()
      expect({ path, active: await active(p) }).toEqual({ path, active: [...current] })
      expect(await sidebar(p).locator("a[data-course][aria-current=page]").evaluateAll((els) => els.map((e) => e.getAttribute("data-course")))).toEqual([...current])
      await p.context().close()
    }
  })

  test("a course link routes on the client, and the mark follows it", async () => {
    const p = await open("/settings")
    await links(p).first().waitFor()
    await p.evaluate(() => ((window as unknown as { marker: number }).marker = 1))
    await links(p).filter({ hasText: "zoo" }).click()
    await p.getByRole("heading", { level: 1, name: "zoo" }).waitFor()
    expect(p.url()).toBe(base + "/courses/zoo")
    expect(await p.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1)
    expect(await active(p)).toEqual(["zoo"])
    await p.context().close()
  })

  test("the course links are focus stops for j and k", async () => {
    const p = await open("/settings")
    await links(p).first().waitFor()
    const stops = await sidebar(p).locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("href")))
    expect(stops).toEqual(expect.arrayContaining(["/courses/aion", "/courses/bio", "/courses/zoo"]))
    await p.context().close()
  })
})

describe("loaded once", () => {
  test("navigating between pages does not ask for the course list again", async () => {
    const { c, listed } = await context()
    const p = await open("/settings", c)
    await links(p).first().waitFor()
    expect(listed()).toBe(1)
    for (const name of ["aion", "bio", "zoo"]) {
      await links(p).filter({ hasText: name }).click()
      await p.getByRole("heading", { level: 1, name }).waitFor()
    }
    await sidebar(p).getByRole("link", { name: /Settings/ }).click()
    await p.getByRole("heading", { level: 1, name: "Settings" }).waitFor()
    await p.goto(base + "/courses/aion/lessons/l1") // a fresh visit loads it, once
    await links(p).first().waitFor()
    await links(p).filter({ hasText: "bio" }).click()
    await p.getByRole("heading", { level: 1, name: "bio" }).waitFor()
    expect(listed()).toBe(2)
    expect(await skeletons(p).count()).toBe(0)
    await c.close()
  })
})

describe("states", () => {
  test("while the request is in flight it shows Skeletons and no links, then the courses", async () => {
    const { c } = await context()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await c.route(/\/api\/courses$/, async (route) => {
      await held
      await route.fallback()
    })
    const p = await open("/settings", c)
    await skeletons(p).first().waitFor()
    expect(await links(p).count()).toBe(0)
    expect(await sidebar(p).getByRole("alert").count()).toBe(0)
    release()
    await links(p).first().waitFor()
    expect(await links(p).count()).toBe(3)
    expect(await skeletons(p).count()).toBe(0)
    await c.close()
  })

  test("a list that cannot be loaded is reported with Try again, which recovers", async () => {
    const { c } = await context()
    let refuse = true
    await c.route(/\/api\/courses$/, (route) => (refuse ? route.abort("connectionrefused") : route.fallback()))
    const p = await open("/settings", c)
    const alert = sidebar(p).getByRole("alert")
    await alert.waitFor()
    expect(await alert.textContent()).toContain("Courses could not be loaded")
    expect(await skeletons(p).count()).toBe(0)
    expect(await links(p).count()).toBe(0)
    refuse = false
    await alert.getByRole("button", { name: "Try again" }).click()
    await links(p).first().waitFor()
    expect(await hrefs(p)).toEqual(["/courses/aion", "/courses/bio", "/courses/zoo"])
    expect(await sidebar(p).getByRole("alert").count()).toBe(0)
    await c.close()
  })

  test("a reply of the wrong shape is a failure, not a list", async () => {
    const { c } = await context()
    await c.route(/\/api\/courses$/, (route) => route.fulfill({ json: [{ title: "not a course" }] }))
    const p = await open("/settings", c)
    await sidebar(p).getByRole("alert").waitFor()
    expect(await links(p).count()).toBe(0)
    await c.close()
  })

  test("the server's own reason is shown", async () => {
    const { c } = await context()
    await c.route(/\/api\/courses$/, (route) => route.fulfill({ status: 500, json: { error: "the courses folder is unreadable" } }))
    const p = await open("/settings", c)
    const alert = sidebar(p).getByRole("alert")
    await alert.waitFor()
    expect(await alert.textContent()).toContain("the courses folder is unreadable")
    await c.close()
  })

  test("on the home page the sidebar and the page share one request, and one Try again recovers both", async () => {
    const { c } = await context()
    let refuse = true
    let asked = 0
    await c.route(/\/api\/courses$/, (route) => (asked++, refuse ? route.abort("connectionrefused") : route.fallback()))
    const p = await open("/", c)
    const main = p.locator("[data-nav-region=main]")
    await sidebar(p).getByRole("alert").waitFor()
    await main.getByRole("alert").filter({ hasText: "Your courses could not be loaded" }).waitFor()
    refuse = false
    await sidebar(p).getByRole("button", { name: "Try again" }).click()
    await links(p).first().waitFor()
    await main.locator("[data-course]").first().waitFor()
    expect(await main.locator("[data-course]").count()).toBe(3)
    expect(asked).toBe(2) // the failed attempt and the retry; the page did not make its own
    await c.close()
  })
})
