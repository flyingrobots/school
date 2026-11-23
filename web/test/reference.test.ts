// The reference page (flyingrobots/school#41), driven in Chrome against the Vite dev server, with
// the page's /api requests and the reference documents it links to answered by a real School
// server over real course folders. Oracles are the issue's acceptance items: every document
// GET /api/courses/:c lists is linked and opens (as School serves it, under its containment
// rules), and a course without references says so; plus the loading, failed and missing states,
// the keys and the breadcrumb.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

const lesson = (id: string, title: string) => JSON.stringify({ type: "page", id, title, subtitle: "", children: [] })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-reference-page-"))
  // aion: four reference documents (one with a space in its name), a file that is not a document,
  // and a symlink that leaves the course, which School neither lists nor serves.
  mkdirSync(join(root, "aion", "lessons"), { recursive: true })
  mkdirSync(join(root, "aion", "reference"), { recursive: true })
  mkdirSync(join(root, "outside"), { recursive: true })
  writeFileSync(join(root, "aion", "lessons", "0001.json"), lesson("l1", "Orbits"))
  writeFileSync(join(root, "aion", "reference", "glossary.html"), "<title>Glossary</title><p>Aphelion: farthest from the sun.</p>")
  writeFileSync(join(root, "aion", "reference", "star charts.html"), "<title>Star charts</title><p>The northern sky.</p>")
  writeFileSync(join(root, "aion", "reference", "tides.html"), "<p>Tides</p>")
  writeFileSync(join(root, "aion", "reference", "units.html"), "<p>Units</p>")
  writeFileSync(join(root, "aion", "reference", "notes.txt"), "not a document")
  writeFileSync(join(root, "outside", "secret.html"), "<p>secret</p>")
  symlinkSync(join(root, "outside", "secret.html"), join(root, "aion", "reference", "leak.html"))
  // plain: lessons, and no reference folder at all.
  mkdirSync(join(root, "plain", "lessons"), { recursive: true })
  writeFileSync(join(root, "plain", "lessons", "0001.json"), lesson("p1", "Only lesson"))
  // broken: lessons that never validated, which the server answers with a 500 and its reason.
  mkdirSync(join(root, "broken", "lessons"), { recursive: true })
  mkdirSync(join(root, "broken", "reference"), { recursive: true })
  writeFileSync(join(root, "broken", "reference", "kept.html"), "<p>kept</p>")
  writeFileSync(join(root, "broken", "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "b1", title: "B", subtitle: "", children: [{ ref: "missing" }] }))

  // The helper chooses the port (flyingrobots/school#82).
  school = await startSchool({
    ...process.env,
    SCHOOL_COURSES: ["aion", "plain", "broken"].map((c) => `${c}=${join(root, c)}`).join(","),
    SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1",
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

/**
 * A browser context whose /api requests, and requests for a course's reference documents, reach
 * the School server, as they do when School serves the built app.
 */
async function context(viewport = { width: 1280, height: 900 }): Promise<BrowserContext> {
  const c = await browser.newContext({ viewport })
  await c.route(/\/api\/|\/courses\/[^/]+\/reference\/./, async (route) => {
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
const docs = (p: Page) => main(p).locator("[data-reference]")
const api = async (course: string): Promise<{ reference: string[] }> => (await fetch(`${school.url}/api/courses/${course}`)).json()
const served = (course: string, file: string) => `/courses/${course}/reference/${encodeURIComponent(file)}`

describe("a course with reference documents", () => {
  test("links every document the API lists, in its order, to the file School serves", async () => {
    const expected = (await api("aion")).reference
    expect(expected).toEqual(["glossary.html", "star charts.html", "tides.html", "units.html"])
    const p = await open("/courses/aion/reference")
    await docs(p).first().waitFor()
    expect(await docs(p).count()).toBe(expected.length)
    for (const [i, file] of expected.entries()) {
      const link = docs(p).nth(i)
      expect(await link.getAttribute("data-reference")).toBe(file)
      expect(await link.getAttribute("href")).toBe(served("aion", file))
      expect(await link.textContent()).toContain(file.replace(/\.html$/, ""))
    }
    // Nothing the API did not list: not the text file, not the symlink that leaves the course.
    const text = (await main(p).textContent()) ?? ""
    expect(text).not.toContain("notes")
    expect(text).not.toContain("leak")
    await p.context().close()
  })

  test("a document opens in a new tab, as School serves it", async () => {
    const p = await open("/courses/aion/reference")
    await docs(p).first().waitFor()
    const link = main(p).getByRole("link", { name: /star charts/ })
    expect(await link.getAttribute("target")).toBe("_blank")
    expect(await link.getAttribute("rel")).toContain("noopener")
    const [tab] = await Promise.all([p.context().waitForEvent("page"), link.click()])
    await tab.waitForLoadState()
    expect(new URL(tab.url()).pathname).toBe(served("aion", "star charts.html"))
    expect(await tab.locator("body").textContent()).toContain("The northern sky.")
    // The app tab stays where it was.
    expect(new URL(p.url()).pathname).toBe("/courses/aion/reference")
    await p.context().close()
  })

  test("the documents are reachable with j and k, and Enter opens the focused one", async () => {
    const p = await open("/courses/aion/reference")
    await docs(p).first().waitFor()
    const hrefs = await main(p).locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("href")))
    const first = hrefs.indexOf(served("aion", "glossary.html"))
    expect(first).toBeGreaterThanOrEqual(0)
    for (let i = 0; i <= first; i++) await p.keyboard.press("j")
    expect(await p.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(served("aion", "glossary.html"))
    await p.keyboard.press("j")
    await p.keyboard.press("j")
    await p.keyboard.press("k")
    expect(await p.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(served("aion", "star charts.html"))
    const [tab] = await Promise.all([p.context().waitForEvent("page"), p.keyboard.press("Enter")])
    await tab.waitForLoadState()
    expect(await tab.locator("body").textContent()).toContain("The northern sky.")
    await p.context().close()
  })

  test("shows the keys with Kbd", async () => {
    const p = await open("/courses/aion/reference")
    await docs(p).first().waitFor()
    const keys = await main(p).locator("[data-slot=kbd]").allTextContents()
    expect(keys).toEqual(expect.arrayContaining(["j", "k", "↵"]))
    await p.context().close()
  })

  test("the breadcrumb leads back to the course, routed on the client", async () => {
    const p = await open("/courses/aion/reference")
    await docs(p).first().waitFor()
    const crumbs = main(p).locator("[data-slot=breadcrumb]")
    expect((await crumbs.textContent())?.replace(/\s+/g, "")).toBe("HomeaionReference")
    await p.evaluate(() => ((window as unknown as { marker: number }).marker = 1))
    await crumbs.getByRole("link", { name: "aion" }).click()
    await p.waitForURL(base + "/courses/aion")
    expect(await p.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1)
    await p.context().close()
  })

  test("uses the width: one column on a phone, several on a wide screen", async () => {
    const columns = async (viewport: { width: number; height: number }) => {
      const p = await open("/courses/aion/reference", await context(viewport))
      await docs(p).first().waitFor()
      const xs = await docs(p).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
      await p.context().close()
      return new Set(xs).size
    }
    expect(await columns({ width: 390, height: 844 })).toBe(1)
    expect(await columns({ width: 1920, height: 1080 })).toBe(4)
  })
})

describe("states", () => {
  test("while the list loads, it shows Skeletons and a Spinner, then the documents", async () => {
    const c = await context()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await c.route(/\/api\/courses\/aion$/, async (route) => {
      await held
      await route.fallback()
    })
    const p = await open("/courses/aion/reference", c)
    await main(p).locator("[data-slot=skeleton]").first().waitFor()
    expect(await main(p).locator("[data-slot=spinner], [role=status]").count()).toBeGreaterThan(0)
    expect(await docs(p).count()).toBe(0)
    release()
    await docs(p).first().waitFor()
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await c.close()
  })

  test("a course without reference documents says so", async () => {
    expect((await api("plain")).reference).toEqual([])
    const p = await open("/courses/plain/reference")
    const empty = main(p).locator("[data-slot=empty]")
    await empty.waitFor()
    expect(await empty.textContent()).toContain("No reference documents")
    expect(await docs(p).count()).toBe(0)
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await p.context().close()
  })

  test("an unreadable course says it could not be read, with the server's reason", async () => {
    const r = await fetch(`${school.url}/api/courses/broken`)
    expect(r.status).toBe(500)
    const reason = (await r.json()).error as string
    const p = await open("/courses/broken/reference")
    const alert = main(p).getByRole("alert")
    await alert.waitFor()
    const text = await alert.textContent()
    expect(text).toContain("This course could not be read")
    expect(text).toContain(reason)
    expect(await docs(p).count()).toBe(0)
    await p.context().close()
  })

  test("a course that does not exist says so", async () => {
    expect((await fetch(`${school.url}/api/courses/nowhere`)).status).toBe(404)
    const p = await open("/courses/nowhere/reference")
    const empty = main(p).locator("[data-slot=empty]")
    await empty.waitFor()
    expect(await empty.textContent()).toContain("There is no course called nowhere")
    await p.context().close()
  })

  test("a server that cannot be reached is reported, and Try again shows the documents once it answers", async () => {
    const c = await context()
    let refuse = true
    await c.route(/\/api\/courses\/aion$/, (route) => (refuse ? route.abort("connectionrefused") : route.fallback()))
    const p = await open("/courses/aion/reference", c)
    const alert = main(p).getByRole("alert")
    await alert.waitFor()
    expect(await alert.textContent()).toContain("The reference documents could not be loaded")
    expect(await main(p).locator("[data-slot=skeleton]").count()).toBe(0)
    refuse = false
    await main(p).getByRole("button", { name: "Try again" }).click()
    await docs(p).first().waitFor()
    expect(await main(p).getByRole("alert").count()).toBe(0)
    await c.close()
  })

  test("an answer of the wrong shape is reported as not loaded, not drawn", async () => {
    const c = await context()
    await c.route(/\/api\/courses\/aion$/, (route) => route.fulfill({ json: { name: "aion", reference: [1, 2] } }))
    const p = await open("/courses/aion/reference", c)
    await main(p).getByRole("alert").waitFor()
    expect(await main(p).getByRole("alert").textContent()).toContain("The reference documents could not be loaded")
    expect(await docs(p).count()).toBe(0)
    await c.close()
  })
})
