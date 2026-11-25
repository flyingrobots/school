// The home page (flyingrobots/school#166), driven in Chrome against the Vite dev server, with the
// page's /api requests answered by real School servers over real course folders and records the
// test writes. Failures are stubbed routes.
// Oracles are the issue's acceptance items: a hero question from a course not started yet, or else
// the lesson to study now; the questions still ahead, each linking to its lesson; the newest
// feedback; questions ready for another look, each naming its course and lesson and saying why;
// a timeline whose marks open their day; each part failing on its own; results in words only.
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

import { openDatabase } from "../../server/adapters/database.ts"
import { postgresRecord } from "../../server/adapters/postgres.ts"
import type { Block } from "../../server/core/model.ts"
import {
  startSchool,
  timeout,
  type Started,
} from "../../server/testing/processes.ts"
import { close } from "./routes.ts"
import { warm } from "./vite.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")

let vite: ViteDevServer
let partway: Started // astro started, bio not
let everywhere: Started // both started
let browser: Browser
let base = ""
let root = ""

const quiz = (id: string): Block => ({
  type: "quiz",
  id,
  q: `Question ${id}?`,
  why: "Because.",
  choices: [
    { id: "wrong", text: "Wrong one", correct: false },
    { id: "right", text: "Right one", correct: true },
  ],
})
const explain: Block = {
  type: "explain",
  id: "e1",
  prompt: "How would you say why planets keep going?",
  model: "Because.",
  sources: [],
}
const page = (
  id: string,
  title: string,
  children: Block[],
  hook?: object
): Block =>
  ({
    type: "page",
    id,
    title,
    subtitle: `About ${title.toLowerCase()}`,
    ...(hook ? { hook } : {}),
    children,
  }) as Block

// A figure that tries to run something: the page keeps only the drawing.
const FIGURE =
  '<svg viewBox="0 0 10 10" onload="window.__ran = 1"><script>window.__ran = 2</script><circle data-dot cx="5" cy="5" r="4" fill="var(--primary)"/></svg>'
const orbits = page("orbits", "Orbits", [quiz("q1"), quiz("q2"), explain], {
  question: "Why do planets keep going?",
  teaser: "Nothing stops them.",
})
const tides = page("tides", "Tides", [quiz("q3"), quiz("q4")])
const cells = page("cells", "Cells", [quiz("q9")], {
  question: "What is a cell made of?",
  teaser: "Smaller than you'd think.",
  figure: FIGURE,
})

const findings = {
  insufficient_evidence: false,
  summary: "Good start: you have the core idea.",
  contradictions: [],
  fidelity: { verdict: "meets" as const, note: "Right idea." },
  completeness: { verdict: "misses" as const, note: "One more step." },
  accessibility: { verdict: "partly" as const, note: "Mostly plain." },
}

beforeAll(
  async () => {
    root = mkdtempSync(join(tmpdir(), "school-home-page-"))
    const course = (name: string, title: string, pages: Block[]) => {
      mkdirSync(join(root, name, "lessons"), { recursive: true })
      writeFileSync(join(root, name, "course.json"), JSON.stringify({ title }))
      pages.forEach((p, i) =>
        writeFileSync(
          join(root, name, "lessons", `000${i + 1}.json`),
          JSON.stringify(p)
        )
      )
    }
    course("astro", "Astronomy", [orbits, tides])
    course("bio", "Biology", [cells])

    // Two days ago, in Orbits: q1 wrong then right (so it is due now), and an explanation, graded.
    const DAY = 24 * 3600 * 1000
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    const seed = async (dir: string, alsoBio: boolean) => {
      const db = await openDatabase({ driver: "pglite", dir })
      const r = postgresRecord(db.sql)
      const e = await r.openEncounter({
        course: "astro",
        lesson: "orbits",
        page: orbits,
        now: ago(2 * DAY),
        aidTracking: 1,
      })
      for (const [choiceId, ms] of [
        ["wrong", 1000],
        ["right", 2000],
      ] as const)
        await r.submit(
          {
            submissionId: crypto.randomUUID(),
            encounterId: e.id,
            blockId: "q1",
            choiceId,
            ms: 10,
          },
          ago(2 * DAY - ms)
        )
      const sub = crypto.randomUUID()
      await r.saveExplanation(
        {
          submissionId: sub,
          encounterId: e.id,
          blockId: "e1",
          text: "They just do.",
          ms: 10,
        },
        ago(2 * DAY - 3000)
      )
      await r.recordGrading(
        {
          status: "succeeded",
          error: null,
          submissionId: sub,
          rubricVersion: "r",
          promptVersion: "p",
          adapter: "test",
          model: "claude",
          sources: [],
          raw: "{}",
          findings,
        },
        ago(2 * DAY - 4000)
      )
      // Earlier today, in Cells (for the record where every course is started): q9 right.
      if (alsoBio) {
        const b = await r.openEncounter({
          course: "bio",
          lesson: "cells",
          page: cells,
          now: ago(7200_000),
          aidTracking: 1,
        })
        await r.submit(
          {
            submissionId: crypto.randomUUID(),
            encounterId: b.id,
            blockId: "q9",
            choiceId: "right",
            ms: 10,
          },
          ago(7200_000 - 1000)
        )
      }
      // Visits, not study (flyingrobots/school#177): five days ago a view of Tides, and four days ago
      // Tides opened with nothing answered. Neither makes a study day.
      await r.recordView({ course: "astro", lesson: "tides" }, ago(5 * DAY))
      await r.openEncounter({
        course: "astro",
        lesson: "tides",
        page: tides,
        now: ago(4 * DAY),
        aidTracking: 1,
      })
      // An hour ago, in Tides: q3 right, so Tides is where the learner left off.
      const t = await r.openEncounter({
        course: "astro",
        lesson: "tides",
        page: tides,
        now: ago(3600_000),
        aidTracking: 1,
      })
      await r.submit(
        {
          submissionId: crypto.randomUUID(),
          encounterId: t.id,
          blockId: "q3",
          choiceId: "right",
          ms: 10,
        },
        ago(3600_000 - 1000)
      )
      await db.close()
    }
    await seed(join(root, "partway", "record"), false)
    await seed(join(root, "everywhere", "record"), true)
    const env = (state: string) => ({
      ...process.env,
      HOST: "127.0.0.1",
      SCHOOL_STATE: join(root, state),
      SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, state, "record")}`,
      SCHOOL_COURSES: ["astro", "bio"]
        .map((c) => `${c}=${join(root, c)}`)
        .join(","),
    })
    partway = await startSchool(env("partway"))
    everywhere = await startSchool(env("everywhere"))

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
  timeout(2) + 60_000
)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  for (const s of [partway, everywhere]) {
    s?.proc.kill()
    await s?.proc.exited
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A browser context whose /api requests reach `school`. */
async function context(
  school = partway,
  viewport = { width: 1280, height: 900 },
  reducedMotion: "reduce" | "no-preference" = "reduce"
): Promise<BrowserContext> {
  const c = await browser.newContext({ viewport, reducedMotion })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    await route.fulfill({
      response: await route.fetch({ url: school.url + u.pathname + u.search }),
    })
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
const hero = (p: Page) => main(p).locator("[data-hero]")

describe("the hero", () => {
  test("asks the question of a course not started yet, with its teaser and figure, and Enter starts it", async () => {
    const p = await open()
    await hero(p).waitFor()
    expect(await hero(p).getAttribute("data-hero")).toBe("new")
    expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe(
      "What is a cell made of?"
    )
    const text = (await hero(p).textContent()) ?? ""
    expect(text).toContain("New for you")
    expect(text).toContain("Biology · Lesson 1 of 1: Cells")
    expect(text).toContain("Smaller than you'd think.")
    // The figure is drawn, and nothing in it ran.
    await hero(p).locator("[data-figure] [data-dot]").waitFor()
    expect(await hero(p).locator("[data-figure] script").count()).toBe(0)
    expect(
      await hero(p).locator("[data-figure] svg").getAttribute("onload")
    ).toBeNull()
    expect(await p.evaluate(() => (window as { __ran?: number }).__ran)).toBe(
      undefined
    )
    // Focus starts on Start, so one key opens the lesson.
    await p.waitForFunction(
      () =>
        document.activeElement?.getAttribute("href") ===
        "/courses/bio/lessons/cells"
    )
    await p.keyboard.press("Enter")
    await p.waitForURL(base + "/courses/bio/lessons/cells")
    await close(p.context())
  })

  test("a learner who has studied, with every started course finished, is offered the new course as new, not as a start", async () => {
    const c = await context()
    // Astronomy is finished, so only Biology is ahead; the learner has still studied before.
    await c.route(/\/api\/showcase$/, async (route) => {
      const all = (await (
        await fetch(partway.url + "/api/showcase")
      ).json()) as { course: string }[]
      await route.fulfill({ json: all.filter((a) => a.course === "bio") })
    })
    const p = await open(c)
    await hero(p).waitFor()
    expect((await hero(p).textContent()) ?? "").toContain("New for you")
    expect((await hero(p).textContent()) ?? "").not.toContain("Start here")
    await close(c)
  })

  test("when every course is started, it is the lesson to study now, with Continue", async () => {
    const p = await open(await context(everywhere))
    await hero(p).waitFor()
    expect(await hero(p).getAttribute("data-hero")).toBe("started")
    const text = (await hero(p).textContent()) ?? ""
    expect(text).toContain("Pick up where you left off")
    expect(text).toContain("Continue")
    // Tides has no hook, so its title stands in for the question.
    expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe(
      "Tides"
    )
    expect(
      await hero(p)
        .getByRole("link", { name: /Continue/ })
        .getAttribute("href")
    ).toBe("/courses/astro/lessons/tides")
    await close(p.context())
  })
})

describe("still ahead", () => {
  test("lists the other unfinished lessons, the one partway through first and marked, each linking to its lesson", async () => {
    const p = await open()
    const cards = main(p).locator("[data-ahead]")
    await cards.first().waitFor()
    expect(
      await cards.evaluateAll((els) => els.map((e) => e.getAttribute("href")))
    ).toEqual(["/courses/astro/lessons/tides", "/courses/astro/lessons/orbits"])
    const first = (await cards.first().textContent()) ?? ""
    expect(first).toContain("You're partway")
    expect(first).toContain("Lesson 2 of 2: Tides")
    const second = (await cards.nth(1).textContent()) ?? ""
    expect(second).toContain("Why do planets keep going?")
    expect(second).not.toContain("You're partway")
    await close(p.context())
  })
})

describe("since you were last here", () => {
  test("the newest feedback names its lesson and course, each criterion in words, and links to a new draft", async () => {
    const p = await open()
    const f = main(p).locator("[data-feedback]")
    await f.waitFor()
    const text = (await f.textContent()) ?? ""
    expect(text).toContain("graded by Claude")
    expect(text).toContain("Your explanation of Orbits")
    expect(text).toContain("How would you say why planets keep going?")
    expect(text).toContain("Good start: you have the core idea.")
    const verdict = async (k: string) =>
      await f.locator(`[data-criterion=${k}] [data-slot=badge]`).textContent()
    expect(await verdict("fidelity")).toBe("Meets")
    expect(await verdict("completeness")).toBe("Not yet")
    expect(await verdict("accessibility")).toBe("Partly")
    expect(
      await f
        .getByRole("link", { name: /Write a new draft/ })
        .getAttribute("href")
    ).toBe("/courses/astro/lessons/orbits#e1")
    await close(p.context())
  })

  test("a question ready for another look names its course and lesson, and says why it's back", async () => {
    const p = await open()
    const item = main(p).locator("[data-review=q1]")
    await item.waitFor()
    const text = (await item.textContent()) ?? ""
    expect(text).toContain("Astronomy · Orbits")
    expect(text).toContain("Question q1?")
    // It comes back at the top of another lesson in its course.
    expect(
      await item.getByRole("link", { name: /Answer/ }).getAttribute("href")
    ).toBe("/courses/astro/lessons/tides")
    await item
      .getByRole("button", { name: "Why am I being asked this question?" })
      .click()
    const why = p.getByRole("dialog")
    await why.waitFor()
    const words = (await why.textContent()) ?? ""
    expect(words).toContain("Why am I being asked this?")
    expect(words).toContain("you found this one on a second go")
    expect(words).toContain("It's from Orbits, in Astronomy.")
    await close(p.context())
  })

  test("the timeline shows the days studied, and a mark opens its day in the letter's place; t comes back to today", async () => {
    const p = await open()
    const timeline = main(p).locator("[data-timeline]")
    await timeline.waitFor()
    expect((await timeline.textContent()) ?? "").toContain(
      "You studied on 2 of the last 14 days"
    )
    const past = timeline.locator("[data-mark^='studied:astro:']")
    expect(await past.count()).toBe(1)
    await past.click()
    const day = main(p).locator("[data-day]")
    await day.waitFor()
    expect((await day.textContent()) ?? "").toContain("You studied on")
    expect(await main(p).locator("[data-feedback]").count()).toBe(0)
    await p.locator("body").click({ position: { x: 5, y: 5 } })
    await p.keyboard.press("t")
    await main(p).locator("[data-feedback]").waitFor()
    // [ steps to the earlier mark again.
    await p.keyboard.press("[")
    await day.waitFor()
    await close(p.context())
  })
})

describe("the learner's zone", () => {
  test("the home page and a lesson send the browser's time zone with every request that names a day", async () => {
    const c = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      timezoneId: "Pacific/Kiritimati",
    })
    const sent: string[] = []
    await c.route(/\/api\//, async (route) => {
      const u = new URL(route.request().url())
      sent.push(u.pathname + u.search)
      await route.fulfill({
        response: await route.fetch({
          url: partway.url + u.pathname + u.search,
        }),
      })
    })
    const p = await open(c)
    await main(p).locator("[data-timeline]").waitFor()
    await p.goto(base + "/courses/astro/lessons/tides")
    await p.getByRole("heading", { level: 1 }).waitFor()
    const zone = (path: string) =>
      sent
        .filter((s) => s.startsWith(path))
        .map((s) => new URL("http://x" + s).searchParams.get("tz"))
    for (const path of [
      "/api/activity",
      "/api/review",
      "/api/courses/astro/lessons/tides",
    ]) {
      const zones = zone(path)
      expect({ path, sent: zones.length > 0 }).toEqual({ path, sent: true })
      expect(new Set(zones)).toEqual(new Set(["Pacific/Kiritimati"]))
    }
    await close(c)
  })
})

describe("study days", () => {
  test("a day with only a visit has no mark; a day with an answer has one", async () => {
    const p = await open()
    const timeline = main(p).locator("[data-timeline]")
    await timeline.waitFor()
    const DAY = 24 * 3600 * 1000
    const { tz } = (await (
      await fetch(partway.url + "/api/activity?days=14")
    ).json()) as { tz: string }
    const local = (ms: number) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
        new Date(Date.now() - ms)
      )
    const marks = await timeline
      .locator("[data-mark^='studied:astro:']")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-mark")))
    expect(marks).toContain(`studied:astro:${local(2 * DAY)}`)
    expect(marks).not.toContain(`studied:astro:${local(4 * DAY)}`)
    expect(marks).not.toContain(`studied:astro:${local(5 * DAY)}`)
    await close(p.context())
  })
})

describe("words, not scores", () => {
  test("shows no percentage, letter grade or score anywhere", async () => {
    const p = await open()
    await main(p).locator("[data-feedback]").waitFor()
    await main(p).locator("[data-timeline]").waitFor()
    const text = (await main(p).textContent()) ?? ""
    expect(text).not.toMatch(/\d+\s?%|score|points?\b|grade [A-F]\b/i)
    await close(p.context())
  })
})

describe("states", () => {
  test("while what's ahead loads, it shows a Spinner and a Skeleton, then the hero", async () => {
    const c = await context()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await c.route(/\/api\/showcase$/, async (route) => {
      await held
      await route.fallback()
    })
    const p = await c.newPage()
    await p.goto(base + "/")
    await main(p).getByText("Finding what's next").waitFor()
    expect(
      await main(p).locator("[data-slot=skeleton]").count()
    ).toBeGreaterThan(0)
    release()
    await hero(p).waitFor()
    await close(c)
  })

  test("what's ahead failing is reported with Try again, and the rest of the page still loads", async () => {
    const c = await context()
    let fail = true
    await c.route(/\/api\/showcase$/, (route) =>
      fail
        ? route.fulfill({
            status: 500,
            json: { error: "the lessons are on fire" },
          })
        : route.fallback()
    )
    const p = await open(c)
    const alert = main(p)
      .getByRole("alert")
      .filter({ hasText: "What's ahead could not be loaded" })
    await alert.waitFor()
    expect((await alert.textContent()) ?? "").toContain(
      "the lessons are on fire"
    )
    await main(p).locator("[data-feedback]").waitFor()
    fail = false
    await alert.getByRole("button", { name: "Try again" }).click()
    await hero(p).waitFor()
    await close(c)
  })

  test("feedback, review and the timeline each fail on their own", async () => {
    for (const [path, title] of [
      ["feedback", "Your feedback could not be loaded"],
      ["review", "Questions to review could not be loaded"],
      ["activity", "Your timeline could not be loaded"],
    ] as const) {
      const c = await context()
      await c.route(new RegExp(`/api/${path}(\\?.*)?$`), (route) =>
        route.fulfill({ status: 500, json: { error: "down" } })
      )
      const p = await open(c)
      await main(p).getByRole("alert").filter({ hasText: title }).waitFor()
      await hero(p).waitFor()
      await close(c)
    }
  })

  test("a quiet day says nothing is new", async () => {
    const c = await context()
    await c.route(/\/api\/feedback$/, (route) => route.fulfill({ json: null }))
    await c.route(/\/api\/review(\?|$)/, (route) => route.fulfill({ json: [] }))
    const p = await open(c)
    await main(p).locator("[data-quiet]").waitFor()
    expect(
      (await main(p).locator("[data-quiet]").textContent()) ?? ""
    ).toContain("Nothing new since you were last here")
    await close(c)
  })

  test("nothing ahead says so", async () => {
    const c = await context()
    await c.route(/\/api\/showcase$/, (route) => route.fulfill({ json: [] }))
    const p = await open(c)
    await main(p).getByText("Nothing ahead right now").waitFor()
    await close(c)
  })
})

describe("layout", () => {
  test("the timeline spans the section above today's detail, at a readable size, every label inside it", async () => {
    const p = await open(await context(partway, { width: 1440, height: 900 }))
    const timeline = main(p).locator("[data-timeline]")
    await timeline.waitFor()
    const section = await main(p)
      .locator("section[aria-labelledby=home-since]")
      .boundingBox()
    const card = await timeline.boundingBox()
    const detail = await main(p).locator("[data-since]").boundingBox()
    expect(card!.width).toBeGreaterThan(section!.width - 2)
    expect(detail!.y).toBeGreaterThan(card!.y + card!.height - 1)
    const svg = await timeline
      .locator("svg[aria-label^='Days you studied']")
      .boundingBox()
    const labels = timeline.locator("svg[aria-label^='Days you studied'] text")
    for (let i = 0; i < (await labels.count()); i++) {
      const b = (await labels.nth(i).boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(svg!.x)
      expect(b.x + b.width).toBeLessThanOrEqual(svg!.x + svg!.width + 0.5)
      expect(b.height).toBeGreaterThanOrEqual(12)
    }
    await close(p.context())
  })

  test("never scrolls sideways, from a phone to a wide screen", async () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 900 },
      { width: 1024, height: 900 },
      { width: 1440, height: 900 },
    ]) {
      const p = await open(await context(partway, viewport))
      await hero(p).waitFor()
      await main(p).locator("[data-timeline]").waitFor()
      expect(
        await p.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        )
      ).toBe(false)
      await close(p.context())
    }
  })
})
