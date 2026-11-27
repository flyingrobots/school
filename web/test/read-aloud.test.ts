// Reading aloud in the browser (flyingrobots/school#175), driven in Chrome against the Vite dev
// server, with the page's /api requests answered by a real School on the development course
// (test/fixtures/course), whose bridge is faked here: it answers the /speak routes with three
// segments of silent WAV, served with byte ranges as the real bridge serves them. No daemon runs and
// nothing is spoken. Oracles are the issue's acceptance items: Read aloud shows the bar with its
// robot label, plays the first segment, Next and Stop work, and `r` starts it; and the home page's
// feedback card reads its feedback, which the server builds.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { fileResponse } from "../../bridge/speech.ts"
import { silentWav } from "../../bridge/testing/fake-aitts.ts"
import {
  startSchool,
  timeout,
  type Started,
} from "../../server/testing/processes.ts"
import { close } from "./routes.ts"
import { warm } from "./vite.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")
const COURSE = join(import.meta.dir, "fixtures", "course")
const TOKEN = "read-aloud-test-token"
const ID = `utt_${"0f".repeat(16)}`

/** What the fake bridge was asked, in order. */
const asked: { method: string; path: string; body: string }[] = []
/** Segments the fake bridge reports ready; the third waits until a test says so. */
let ready = [true, true, false]
/** When set, the fake bridge answers POST /speak with this, as the real one does with no daemon. */
let unavailable: string | null = null
/** When true, the browser's progress requests fail as if School were down. */
let pollsRefused = false

let bridge: ReturnType<typeof Bun.serve>
let school: Started
let vite: ViteDevServer
let browser: Browser
let base = ""
let root = ""
let wav = ""

beforeEach(() => {
  asked.length = 0
  ready = [true, true, false]
  unavailable = null
  pollsRefused = false
})

beforeAll(
  async () => {
    root = mkdtempSync(join(tmpdir(), "school-read-aloud-"))
    // Long enough that no segment ends by itself during a test.
    wav = join(root, "segment.wav")
    writeFileSync(wav, silentWav(30))
    bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url)
        if (req.headers.get("authorization") !== `Bearer ${TOKEN}`)
          return Response.json({ status: "unauthorised" }, { status: 401 })
        asked.push({
          method: req.method,
          path: pathname,
          body: await req.text(),
        })
        if (pathname === "/speak") {
          if (unavailable !== null)
            return Response.json(
              { status: "unavailable", error: unavailable },
              { status: 503 }
            )
          return Response.json({ id: ID, state: "Queued", segments: 3 })
        }
        if (pathname === `/speak/${ID}`)
          return Response.json({
            id: ID,
            state: ready.every(Boolean) ? "Ready" : "Synthesizing",
            error: null,
            segments: ready.map((r, index) => ({
              index,
              ready: r,
              durationMs: r ? 30_000 : null,
            })),
          })
        if (pathname === `/speak/${ID}/cancel`)
          return Response.json({ id: ID, state: "Cancelled" })
        const seg = new RegExp(`^/speak/${ID}/segments/(\\d)$`).exec(pathname)
        if (seg !== null && ready[Number(seg[1])])
          return fileResponse(wav, req.headers.get("range"), "audio/wav")
        return Response.json({ status: "not found" }, { status: 404 })
      },
    })
    school = await startSchool({
      ...process.env,
      SCHOOL_COURSE: undefined,
      SCHOOL_COURSES: `astro=${COURSE}`,
      SCHOOL_STATE: join(root, "state"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "record")}`,
      SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""),
      SCHOOL_BRIDGE_TOKEN: TOKEN,
      HOST: "127.0.0.1",
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
    await warm(browser, base)
  },
  timeout(1) + 40_000
)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  school?.proc.kill()
  await school?.proc.exited
  bridge?.stop(true)
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A page whose /api requests reach School, with `stub` answering any it names first. */
async function open(
  path: string,
  stub: Record<string, unknown> = {}
): Promise<Page> {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    if (pollsRefused && u.pathname === `/api/speak/${ID}`)
      return route.abort("connectionrefused").catch(() => {})
    if (u.pathname in stub)
      return route.fulfill({ json: stub[u.pathname] }).catch(() => {})
    try {
      await route.fulfill({
        response: await route.fetch({
          url: school.url + u.pathname + u.search,
        }),
      })
    } catch {
      await route.abort("connectionrefused").catch(() => {})
    }
  })
  const p = await c.newPage()
  p.setDefaultTimeout(5_000)
  await p.goto(base + path)
  return p
}

const bar = (p: Page) => p.locator("[data-read-aloud-bar]")
const label = (p: Page) => bar(p).locator("[data-read-aloud-label]")
const segments = () =>
  asked
    .filter((a) => a.path.includes("/segments/"))
    .map((a) => Number(a.path.split("/").at(-1)))
const cancels = () => asked.filter((a) => a.path.endsWith("/cancel")).length

/** Waits until the bar says it is playing `n` of `of`. */
async function playing(p: Page, n: number, of = 3) {
  await p.locator('[data-read-aloud-bar][data-phase="playing"]').waitFor()
  await p.waitForFunction(
    (want) =>
      document.querySelector("[data-read-aloud-label]")?.textContent === want,
    `Reading · ${n} of ${of}`
  )
}

describe("reading a lesson aloud", () => {
  test("Read aloud shows the bar with its AI label, plays the first segment, and Next and Stop work", async () => {
    const p = await open("/courses/astro/lessons/orbits")
    const read = p.getByRole("button", { name: /Read aloud/ })
    await read.waitFor()
    expect(await read.locator("kbd").textContent()).toBe("R")
    await read.click()
    await bar(p).waitFor()
    expect(await bar(p).textContent()).toContain("AI voice")
    await playing(p, 1)
    expect(segments()).toContain(0)
    // The server built the text; the browser sent only which lesson.
    const submit = asked.find((a) => a.path === "/speak")!
    const { text } = JSON.parse(submit.body) as { text: string }
    expect(text).toContain("Which planet is closest to the Sun?")
    expect(text).not.toContain("Mercury orbits at about 0.39 AU")

    await bar(p).getByRole("button", { name: "Next part" }).click()
    await playing(p, 2)
    expect(segments()).toContain(1)

    await bar(p).getByRole("button", { name: "Stop reading" }).click()
    await bar(p).waitFor({ state: "detached" })
    await waitUntil(() => cancels() === 1)
    await close(p.context())
  })

  test("r starts it; / pauses and resumes; , and . step; a part still being made shows a spinner; Esc stops", async () => {
    const p = await open("/courses/astro/lessons/orbits")
    await p.getByRole("button", { name: /Read aloud/ }).waitFor()
    await p.locator("body").click({ position: { x: 5, y: 5 } })
    await p.keyboard.press("r")
    await playing(p, 1)
    for (const k of [",", ".", "/", "Esc"])
      expect(await bar(p).locator("kbd", { hasText: k }).count()).toBe(1)

    await p.keyboard.press("/")
    await p.locator('[data-read-aloud-bar][data-phase="paused"]').waitFor()
    expect(await label(p).textContent()).toBe("Paused · 1 of 3")
    await p.keyboard.press("/")
    await playing(p, 1)

    await p.keyboard.press(".")
    await playing(p, 2)
    await p.keyboard.press(".")
    // The third part is not made yet: the bar waits for it, with a spinner.
    await p.locator('[data-read-aloud-bar][data-phase="waiting"]').waitFor()
    await bar(p).locator("[data-slot=spinner]").waitFor()
    expect(await label(p).textContent()).toBe("Getting part 3 of 3 ready")
    ready = [true, true, true]
    await playing(p, 3)
    expect(segments()).toContain(2)

    await p.keyboard.press(",")
    await playing(p, 2)
    await p.keyboard.press("Escape")
    await bar(p).waitFor({ state: "detached" })
    await waitUntil(() => cancels() === 1)
    await close(p.context())
  })

  test("with no AI-TTS, the bar says why in words, and Esc closes it", async () => {
    unavailable =
      "AI-TTS isn't running: its socket is missing. Start AI-TTS, then try again."
    const p = await open("/courses/astro/lessons/orbits")
    await p.getByRole("button", { name: /Read aloud/ }).click()
    await p.locator('[data-read-aloud-bar][data-phase="failed"]').waitFor()
    expect(await bar(p).textContent()).toContain("AI-TTS isn't running")
    await p.keyboard.press("Escape")
    await bar(p).waitFor({ state: "detached" })
    await close(p.context())
  })
})

describe("losing School while reading", () => {
  test("three failed polls in a row stop reading, and the bar says School stopped answering", async () => {
    ready = [false, false, false]
    pollsRefused = true
    const p = await open("/courses/astro/lessons/orbits")
    await p.getByRole("button", { name: /Read aloud/ }).click()
    await p
      .locator('[data-read-aloud-bar][data-phase="failed"]')
      .waitFor({ timeout: 15_000 })
    expect(await bar(p).textContent()).toContain("School stopped answering")
    await p.keyboard.press("Escape")
    await bar(p).waitFor({ state: "detached" })
    await close(p.context())
  })
})

describe("reading the latest feedback aloud", () => {
  test("the home page's feedback card has Read aloud, which asks School for the feedback, never sending text", async () => {
    const feedback = {
      course: "astro",
      courseTitle: "Astronomy",
      trusted: true,
      lesson: { id: "orbits", title: "Orbits" },
      blockId: "seasons-explain",
      prompt: "How would you explain the seasons?",
      model: "claude",
      at: new Date().toISOString(),
      findings: {
        insufficient_evidence: false,
        summary: "Good start.",
        contradictions: [],
        fidelity: { verdict: "meets", note: "Right idea." },
        completeness: { verdict: "partly", note: "One more step." },
        accessibility: { verdict: "meets", note: "Plain." },
      },
    }
    const sent: unknown[] = []
    const p = await open("/", { "/api/feedback": feedback })
    p.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/speak")
        sent.push(r.postDataJSON())
    })
    const card = p.locator("[data-feedback]")
    await card.waitFor()
    await card.getByRole("button", { name: /Read aloud/ }).click()
    await bar(p).waitFor()
    await waitUntil(() => sent.length === 1)
    expect(sent).toEqual([{ feedback: true }])
    await p.keyboard.press("Escape")
    await bar(p).waitFor({ state: "detached" })
    await close(p.context())
  })
})

async function waitUntil(ok: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(25)
  }
}
