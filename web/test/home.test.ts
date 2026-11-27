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
let holding: Started // geo with one quiz faded, one holding, one not started; bio not started
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
const rocks = page("rocks", "Rocks", [quiz("g1"), quiz("g2"), quiz("g3")])
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

// Every seed below is relative to Date.now() ("two days ago", "an hour ago"), and a day is named in
// the learner's zone. Run the servers and the browser in a fixed-offset zone where it is about
// midday now, so "an hour ago" is always today (flyingrobots/school#293). Etc/GMT signs are inverted.
const NOON = (() => {
  const h = 12 - new Date().getUTCHours()
  return h === 0 ? "Etc/UTC" : `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`
})()

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
    course("geo", "Geology", [rocks])

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
    // How Geology is holding (RFC 5 §4.1, Table 4.5; flyingrobots/school#222), each answer a clean
    // first try in an encounter of its own. g1, two days ago: stability one day, strength 0.25
    // now, so faded today. g2, three days ago and again an hour ago: stability 2.5 days, holding
    // now, and below one half from 60 hours on, so it comes back three days ahead (strength 0.43;
    // 0.57 two days ahead). g3 is never answered. Biology is not started.
    {
      const db = await openDatabase({
        driver: "pglite",
        dir: join(root, "holding", "record"),
      })
      const r = postgresRecord(db.sql)
      for (const [blockId, ms] of [
        ["g2", 3 * DAY],
        ["g1", 2 * DAY],
        ["g2", 3600_000],
      ] as const) {
        const e = await r.openEncounter({
          course: "geo",
          lesson: "rocks",
          page: rocks,
          now: ago(ms + 1000),
          aidTracking: 1,
        })
        await r.submit(
          {
            submissionId: crypto.randomUUID(),
            encounterId: e.id,
            blockId,
            choiceId: "right",
            ms: 10,
          },
          ago(ms)
        )
      }
      await db.close()
    }
    const env = (state: string, courses = ["astro", "bio"]) => ({
      ...process.env,
      TZ: NOON,
      HOST: "127.0.0.1",
      SCHOOL_STATE: join(root, state),
      SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, state, "record")}`,
      SCHOOL_COURSES: courses.map((c) => `${c}=${join(root, c)}`).join(","),
    })
    partway = await startSchool(env("partway"))
    everywhere = await startSchool(env("everywhere"))
    holding = await startSchool(env("holding", ["geo", "bio"]))

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
  timeout(3) + 60_000
)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  for (const s of [partway, everywhere, holding]) {
    s?.proc.kill()
    await s?.proc.exited
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A browser context whose /api requests reach `school`. */
async function context(
  school = partway,
  viewport = { width: 1280, height: 900 },
  reducedMotion: "reduce" | "no-preference" = "reduce",
  colorScheme: "light" | "dark" = "light"
): Promise<BrowserContext> {
  const c = await browser.newContext({
    viewport,
    reducedMotion,
    colorScheme,
    timezoneId: NOON,
  })
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

  test("while what's ahead loads, no question ready for another look has an Answer link yet, then it opens the next lesson", async () => {
    const c = await context()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await c.route(/\/api\/showcase$/, async (route) => {
      await held
      await route.fallback()
    })
    const p = await c.newPage()
    const review = p.waitForResponse((r) => /\/api\/review(\?|$)/.test(r.url()))
    await p.goto(base + "/")
    await review
    await main(p).locator("[data-feedback]").waitFor()
    expect(await main(p).locator("[data-review] a").count()).toBe(0)
    release()
    const answer = main(p)
      .locator("[data-review=q1]")
      .getByRole("link", { name: /Answer/ })
    await answer.waitFor()
    expect(await answer.getAttribute("href")).toBe(
      "/courses/astro/lessons/tides"
    )
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

// RFC 5 Table 5.1 step 6 (flyingrobots/school#222): each lane says, in words, how its course's
// quizzes are holding today, with the registry's Badge in the theme's colours, and a quiz that will
// fade is a ring on the day it comes back. Oracle: the Geology record above, worked from RFC 5
// §4.1 and Table 4.5, and the words of RFC 5 Table 4.7.
describe("how each course is holding", () => {
  const lane = (p: Page, course: string) =>
    main(p).locator(`[data-timeline] [data-lane=${course}]`)
  const words = (p: Page, course: string) =>
    lane(p, course).locator("[data-holding] [data-slot=badge]")
  const localDay = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: NOON,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms)

  test.each(["light", "dark"] as const)(
    "a course's lane says how its quizzes are holding, in Badges in the theme's colours (%s)",
    async (colorScheme) => {
      const p = await open(
        await context(holding, undefined, undefined, colorScheme)
      )
      await words(p, "geo").first().waitFor()
      expect(await words(p, "geo").allTextContents()).toEqual([
        "1 of 3 quizzes holding",
        "1 ready for another look",
        "1 not started yet",
      ])
      const got = await words(p, "geo")
        .first()
        .evaluate((el) => {
          // The tokens as the browser resolves them, through the same property.
          const probe = document.createElement("div")
          probe.style.backgroundColor = "var(--secondary)"
          probe.style.color = "var(--secondary-foreground)"
          document.body.append(probe)
          const want = getComputedStyle(probe)
          const have = getComputedStyle(el)
          const out = {
            background: have.backgroundColor === want.backgroundColor,
            text: have.color === want.color,
            dark: document.documentElement.classList.contains("dark"),
          }
          probe.remove()
          return out
        })
      expect(got).toEqual({
        background: true,
        text: true,
        dark: colorScheme === "dark",
      })
      await close(p.context())
    }
  )

  test("a course not started says so in its lane", async () => {
    const p = await open(await context(holding))
    await words(p, "bio").first().waitFor()
    expect(await words(p, "bio").allTextContents()).toEqual(["Not started yet"])
    await close(p.context())
  })

  test("a quiz that fades is a ring on the day it comes back, three days ahead, and on no day before", async () => {
    const p = await open(await context(holding))
    await lane(p, "geo").waitFor()
    const back = localDay(Date.now() + 3 * 24 * 3600 * 1000)
    expect(
      await lane(p, "geo")
        .locator("[data-mark^='due:']")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-mark")))
    ).toEqual([`due:geo:${back}`])
    const ring = lane(p, "geo").locator(`[data-mark='due:geo:${back}']`)
    expect(await ring.getAttribute("aria-label")).toStartWith(
      "1 question comes back in Geology, "
    )
    await ring.click()
    expect((await main(p).locator("[data-day]").textContent()) ?? "").toContain(
      "1 question comes back on"
    )
    await close(p.context())
  })

  test("the lane's words sit inside the timeline above the lane's line, from a phone to a wide screen", async () => {
    for (const width of [390, 1440]) {
      const p = await open(await context(holding, { width, height: 900 }))
      await words(p, "geo").first().waitFor()
      const svg = (await main(p)
        .locator("[data-timeline] svg[aria-label^='Days you studied']")
        .boundingBox())!
      const line = (await lane(p, "geo").locator("line").first().boundingBox())!
      const boxes = await words(p, "geo").evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect)
      )
      expect(boxes.length).toBe(3)
      for (const b of boxes) {
        expect(b.left).toBeGreaterThanOrEqual(svg.x)
        expect(b.right).toBeLessThanOrEqual(svg.x + svg.width + 0.5)
        expect(b.bottom).toBeLessThanOrEqual(line.y - 8)
      }
      await close(p.context())
    }
  })

  // The app opens the answer outbox's IndexedDB database on every page (web/src/lib/outbox.ts,
  // flyingrobots/school#28), so the database may exist; what counts is that nothing is in it.
  test("nothing is written to browser storage", async () => {
    const p = await open(await context(holding))
    await words(p, "geo").first().waitFor()
    await lane(p, "geo").locator("[data-mark^='due:']").click()
    await main(p).locator("[data-day]").waitFor()
    expect(
      await p.evaluate(async () => {
        const kept: Record<string, number> = {}
        for (const { name } of await indexedDB.databases()) {
          const db = await new Promise<IDBDatabase>((ok, no) => {
            const r = indexedDB.open(name!)
            r.onsuccess = () => ok(r.result)
            r.onerror = () => no(r.error)
          })
          for (const store of Array.from(db.objectStoreNames))
            kept[`${name}/${store}`] = await new Promise<number>((ok, no) => {
              const r = db.transaction(store).objectStore(store).count()
              r.onsuccess = () => ok(r.result)
              r.onerror = () => no(r.error)
            })
          db.close()
        }
        return {
          local: localStorage.length,
          session: sessionStorage.length,
          indexedDB: Object.values(kept).reduce((n, k) => n + k, 0),
        }
      })
    ).toEqual({ local: 0, session: 0, indexedDB: 0 })
    await close(p.context())
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
