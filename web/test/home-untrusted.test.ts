// An untrusted course's text on the home page (flyingrobots/school#272), driven in Chrome against
// the Vite dev server, with the page's /api requests answered by a real School server. The one
// course is untrusted, and every string it writes (its title, its lessons' titles, hook questions
// and teasers, a quiz's question, an explain prompt), and the grader's words seeded into the
// record, hold the whole cross-site scripting corpus from web/test/xss-corpus.ts behind a marker
// naming the place. The page reads them from /api/showcase, /api/resume, /api/feedback,
// /api/review, /api/activity and /api/courses, all of which now say the course is untrusted.
// Oracle: the issue's section 2d, "renders a hostile untrusted item inert in each place it
// appears". Inert means every payload is shown as the text it is (the place's text holds the marked
// string exactly, so nothing was parsed as markup or dropped), no payload's `pwn()` ever runs, and
// nothing in the document could run script: no script, frame or object element the app did not
// load itself, no `on*` or `srcdoc` attribute, and no script URL (the rules of
// web/test/sanitise.test.tsx, applied to the live page).
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
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { openDatabase } from "../../server/adapters/database.ts"
import { postgresRecord } from "../../server/adapters/postgres.ts"
import type { Block, GradingRecord } from "../../server/core/model.ts"
import {
  startSchool,
  timeout,
  type Started,
} from "../../server/testing/processes.ts"
import { close } from "./routes.ts"
import { warm } from "./vite.ts"
import { CORPUS } from "./xss-corpus.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")

/** The hostile string for one place: a marker naming it, then every payload in the corpus. */
const hostile = (place: string) => `[${place}] ${CORPUS.join(" ")}`

const quiz = (id: string, q: string): Block => ({
  type: "quiz",
  id,
  q,
  why: "Because.",
  choices: [
    { id: "wrong", text: "Not this one", correct: false },
    { id: "right", text: "This one", correct: true },
  ],
})
const first = {
  type: "page",
  id: "g1",
  title: hostile("first lesson title"),
  subtitle: hostile("first lesson subtitle"),
  hook: {
    question: hostile("first hook question"),
    teaser: hostile("first hook teaser"),
  },
  children: [
    quiz("q1", hostile("review question")),
    quiz("q2", hostile("second question")),
    quiz("q3", hostile("third question")),
    {
      type: "explain",
      id: "e1",
      prompt: hostile("explain prompt"),
      model: "Because.",
      sources: [],
    },
  ],
} as Block
const second = {
  type: "page",
  id: "g2",
  title: hostile("second lesson title"),
  subtitle: hostile("second lesson subtitle"),
  hook: {
    question: hostile("second hook question"),
    teaser: hostile("second hook teaser"),
  },
  children: [quiz("q4", hostile("fourth question"))],
} as Block
const findings: NonNullable<GradingRecord["findings"]> = {
  insufficient_evidence: false,
  summary: hostile("feedback summary"),
  contradictions: [],
  fidelity: { verdict: "meets", note: hostile("fidelity note") },
  completeness: { verdict: "partly", note: hostile("completeness note") },
  accessibility: { verdict: "meets", note: hostile("accessibility note") },
}

// Seeds are relative to now, and a day is named in the learner's zone: run everything in a
// fixed-offset zone where it is about midday, so "ten hours ago" is never tomorrow (as in
// web/test/home.test.ts). Etc/GMT signs are inverted.
const NOON = (() => {
  const h = 12 - new Date().getUTCHours()
  return h === 0 ? "Etc/UTC" : `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`
})()

let vite: ViteDevServer
let school: Started
let browser: Browser
let base = ""
let root = ""

beforeAll(
  async () => {
    root = mkdtempSync(join(tmpdir(), "school-home-untrusted-"))
    mkdirSync(join(root, "guest", "lessons"), { recursive: true })
    writeFileSync(
      join(root, "guest", "course.json"),
      JSON.stringify({ title: hostile("course title") })
    )
    writeFileSync(
      join(root, "guest", "lessons", "0001.json"),
      JSON.stringify(first)
    )
    writeFileSync(
      join(root, "guest", "lessons", "0002.json"),
      JSON.stringify(second)
    )

    // Two days ago q1 wrong then right (due now, so ready for another look); ten hours ago q2
    // wrong then right (it comes back tomorrow, a mark on the timeline) and an explanation, graded.
    // q3 is never answered, so the first lesson is the one to continue.
    const HOUR = 3600_000
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    const db = await openDatabase({
      driver: "pglite",
      dir: join(root, "record"),
    })
    const r = postgresRecord(db.sql)
    const answer = async (encounterId: string, blockId: string, at: number) => {
      for (const [choiceId, ms] of [
        ["wrong", 1000],
        ["right", 2000],
      ] as const)
        await r.submit(
          {
            submissionId: crypto.randomUUID(),
            encounterId,
            blockId,
            choiceId,
            ms: 10,
          },
          ago(at - ms)
        )
    }
    const opened = async (at: number) =>
      (
        await r.openEncounter({
          course: "guest",
          lesson: "g1",
          page: first,
          now: ago(at),
          aidTracking: 1,
        })
      ).id
    await answer(await opened(48 * HOUR), "q1", 48 * HOUR)
    const e = await opened(10 * HOUR)
    await answer(e, "q2", 10 * HOUR)
    const sub = crypto.randomUUID()
    await r.saveExplanation(
      {
        submissionId: sub,
        encounterId: e,
        blockId: "e1",
        text: "Because.",
        ms: 10,
      },
      ago(10 * HOUR - 3000)
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
      ago(10 * HOUR - 4000)
    )
    await db.close()

    school = await startSchool({
      ...process.env,
      TZ: NOON,
      HOST: "127.0.0.1",
      SCHOOL_STATE: join(root, "state"),
      SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
      SCHOOL_UNTRUSTED_COURSES: `guest=${join(root, "guest")}`,
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
  timeout(1) + 60_000
)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  school?.proc.kill()
  await school?.proc.exited
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The home page, its /api requests answered by School, with a counter every payload would bump. */
async function home(): Promise<Page> {
  const c = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    timezoneId: NOON,
  })
  await c.addInitScript(() => {
    const w = window as unknown as { pwned: number; pwn: () => void }
    w.pwned = 0
    w.pwn = () => {
      w.pwned++
    }
  })
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    await route.fulfill({
      response: await route.fetch({ url: school.url + u.pathname + u.search }),
    })
  })
  const p = await c.newPage()
  p.setDefaultTimeout(5_000)
  await p.goto(base + "/")
  await p.locator("[data-hero]").waitFor()
  await p.locator("[data-review]").waitFor()
  await p.locator("[data-feedback]").waitFor()
  await p.locator("[data-lane]").first().waitFor()
  return p
}

/**
 * Everything on the page that could run script, as readable findings; empty means inert. The same
 * rules as web/test/sanitise.test.tsx, run in the page. The app's own module scripts (an external
 * `src` on this origin, no inline text) are not findings.
 */
function hazards(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const runs = new Set([
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "base",
      "meta",
      "link",
      "applet",
      "portal",
    ])
    const urls = new Set([
      "href",
      "xlink:href",
      "src",
      "srcset",
      "action",
      "formaction",
      "data",
      "poster",
      "background",
      "codebase",
      "cite",
    ])
    const own = (e: Element) =>
      e.localName === "script" &&
      e.textContent === "" &&
      (e.getAttribute("src") ?? "").startsWith("/")
    const found: string[] = []
    for (const e of document.body.querySelectorAll("*")) {
      const tag = e.localName.toLowerCase()
      if (runs.has(tag) && !own(e)) found.push(`<${tag}>`)
      for (const a of [...e.attributes]) {
        const name = a.name.toLowerCase()
        if (name.startsWith("on")) found.push(`<${tag} ${name}>`)
        if (name === "srcdoc") found.push(`<${tag} srcdoc>`)
        if (urls.has(name)) {
          const url = [...a.value]
            .filter((ch) => ch.charCodeAt(0) > 0x20)
            .join("")
            .toLowerCase()
          if (/^(javascript|vbscript|data:text\/html)/.test(url))
            found.push(`<${tag} ${name}="${a.value}">`)
        }
      }
    }
    return found
  })
}

const pwned = (p: Page) =>
  p.evaluate(() => (window as unknown as { pwned: number }).pwned)

/** Which of `places` the text of `selector` (every match) shows exactly, as the course wrote it. */
async function shown(
  p: Page,
  selector: string,
  places: readonly string[]
): Promise<Record<string, boolean>> {
  const text = (await p.locator(selector).allTextContents()).join("\n")
  return Object.fromEntries(
    places.map((place) => [place, text.includes(hostile(place))])
  )
}
const all = (places: readonly string[]) =>
  Object.fromEntries(places.map((place) => [place, true]))

// Each place on the home page that shows an untrusted course's text, and the strings it shows.
const PLACES = [
  [
    "the hero",
    "[data-hero]",
    [
      "course title",
      "first lesson title",
      "first hook question",
      "first hook teaser",
    ],
  ],
  [
    "a lesson still ahead",
    "[data-ahead]",
    [
      "course title",
      "second lesson title",
      "second hook question",
      "second hook teaser",
    ],
  ],
  [
    "the feedback",
    "[data-feedback]",
    [
      "course title",
      "first lesson title",
      "explain prompt",
      "feedback summary",
      "fidelity note",
      "completeness note",
      "accessibility note",
    ],
  ],
  [
    "a question ready for another look",
    "[data-review]",
    ["course title", "first lesson title", "review question"],
  ],
  ["the timeline", "[data-lane]", ["course title"]],
  ["the sidebar", "[data-sidebar=sidebar]", ["course title"]],
] as const

describe("an untrusted course's text on the home page", () => {
  test("every reply the page reads says the course is untrusted", async () => {
    type Trust = { trusted?: unknown }
    const get = async <T>(path: string): Promise<T> =>
      (await fetch(school.url + path)).json() as Promise<T>
    const trust = (items: Trust[]) => items.map((i) => i.trusted)
    expect({
      showcase: trust(await get<Trust[]>("/api/showcase")),
      resume: (await get<Trust>("/api/resume")).trusted,
      feedback: (await get<Trust>("/api/feedback")).trusted,
      review: trust(await get<Trust[]>("/api/review")),
      activity: trust(
        (await get<{ courses: Trust[] }>("/api/activity")).courses
      ),
    }).toEqual({
      showcase: [false, false],
      resume: false,
      feedback: false,
      review: [false],
      activity: [false],
    })
  })

  test.each(PLACES)(
    "%s shows every payload as plain text",
    async (_name, selector, places) => {
      const p = await home()
      expect(await shown(p, selector, places)).toEqual(all(places))
      expect({ hazards: await hazards(p), pwned: await pwned(p) }).toEqual({
        hazards: [],
        pwned: 0,
      })
      await close(p.context())
    }
  )

  test("why a question is back, opened, shows its lesson and course as plain text", async () => {
    const p = await home()
    await p
      .getByRole("button", { name: "Why am I being asked this question?" })
      .hover()
    const pop = "[data-slot=popover-content]"
    await p.locator(pop).waitFor()
    const places = ["course title", "first lesson title"]
    expect(await shown(p, pop, places)).toEqual(all(places))
    expect({ hazards: await hazards(p), pwned: await pwned(p) }).toEqual({
      hazards: [],
      pwned: 0,
    })
    await close(p.context())
  })

  test("a timeline mark, chosen, names its course as plain text in its label and its day", async () => {
    const p = await home()
    const mark = p.locator("[data-mark^='due:guest:']")
    expect(await mark.getAttribute("aria-label")).toContain(
      hostile("course title")
    )
    await mark.click()
    await p.locator("[data-day]").waitFor()
    expect(await shown(p, "[data-day]", ["course title"])).toEqual(
      all(["course title"])
    )
    expect({ hazards: await hazards(p), pwned: await pwned(p) }).toEqual({
      hazards: [],
      pwned: 0,
    })
    await close(p.context())
  })
})
