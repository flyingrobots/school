// The lesson page (flyingrobots/school#42), driven in a real browser: Chrome through playwright-core,
// against the Vite dev server, with the page's /api requests answered by a real School process on
// the development course in test/fixtures/course. Oracles are the issue's acceptance items:
// - a wrong then right answer is recorded, and a reload shows what the record holds;
// - an explanation is saved before grading, and a failed grading offers a retry;
// - the server being down while answering never shows the answer as saved;
// - a lesson id that does not exist shows a not-found state.
// And flyingrobots/school#51's: the page opens lessons with ?aid=1 and records each kind of help it
// shows exactly once per showing, and RFC 2 Figure 4 (submit, reveal, revise) reaches the server in
// that order.
// And flyingrobots/school#28's: a submission made while School cannot be reached waits in the
// outbox, shown as not sent yet, and is stored exactly once when School is reachable again, even
// from a new tab after the first was closed; a refusal is shown and never retried; without
// browser storage it is send-or-fail with an honest message; queued answers keep their order.
// And flyingrobots/school#43's: the slides view sends no write request and opens no encounter (the
// record's latest activity stays empty), its keys move between slides, reduced motion skips the
// animation, and the link to the web view goes there and back.
// And flyingrobots/school#125's: a relative or same-origin link in lesson prose opens in the same
// tab with no confirmation, and a link to another origin still asks first.
// What a reload shows is the learner history's oracle (server/contract/learner-history.ts,
// `pageShows`): each quiz by its latest answer, each explanation by its latest grading.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { loadLibrary } from "../../server/blocks.ts"
import { openDatabase } from "../../server/adapters/database.ts"
import { postgresRecord } from "../../server/adapters/postgres.ts"
import {
  startSchool,
  timeout,
  type Started,
} from "../../server/testing/processes.ts"
import { warm } from "./vite.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")
const COURSE = join(import.meta.dir, "fixtures", "course")
const TOKEN = "lesson-page-test-token"

// Each test that writes to the record uses its own course name, all served from the one fixture,
// so no test resumes an encounter another test opened.
const NAMES = [
  "golden",
  "wrong",
  "saved",
  "failed",
  "keys",
  "aid",
  "pager",
  "loading",
  "down",
  "feedback",
  "model",
  "source",
  "trace",
  "figure4",
  "resend",
  "final-501",
  "final-400",
  "final-409",
  "ob-golden",
  "ob-lost",
  "ob-private",
  "ob-409",
  "ob-400",
  "ob-order",
  "ob-50",
  "review",
  "slides-none",
  "slides-keys",
  "slides-motion",
  "slides-trip",
] as const
type Name = (typeof NAMES)[number]

/** A fake bridge: answers each grading with the next reply queued, or a failure when none is. */
const replies: ("fail" | "succeed")[] = []
const findings = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "It agrees with the sources." },
  completeness: {
    verdict: "partly",
    note: "Say what the tilt does to the length of the day.",
  },
  accessibility: { verdict: "meets", note: "Plain words throughout." },
  contradictions: [],
  summary: "Clear and right: the tilt, not the distance.",
}
let bridge: ReturnType<typeof Bun.serve>
let gradings = 0
// Each test owns the fake bridge's state: no grading counted or reply queued by another test,
// whatever order the tests run in (`bun test --randomize`).
beforeEach(() => {
  gradings = 0
  replies.length = 0
})

/** A School process, and the environment it was started with so it can be started again. */
type Stack = { school: Started; env: Record<string, string | undefined> }

async function stack(
  state: string,
  courses = NAMES.map((n) => `${n}=${COURSE}`).join(","),
  extra: Record<string, string> = {}
): Promise<Stack> {
  const env = {
    ...process.env,
    ...extra,
    SCHOOL_COURSE: undefined,
    SCHOOL_COURSES: courses,
    SCHOOL_STATE: state,
    SCHOOL_DATABASE_URL: `pglite:${join(state, "record")}`, // its own PGlite record beside its state
    SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""),
    SCHOOL_BRIDGE_TOKEN: TOKEN,
    HOST: "127.0.0.1",
  }
  return { school: await startSchool(env), env }
}

async function stop(s: Stack | undefined) {
  if (!s) return
  s.school.proc.kill("SIGKILL")
  await s.school.proc.exited
}

let browser: Browser
let vite: ViteDevServer
let base = ""
let root: string
let main: Stack

beforeAll(
  async () => {
    bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/run")
          return new Response("not found", { status: 404 })
        gradings += 1
        return replies.shift() === "succeed"
          ? Response.json({
              status: "succeeded",
              agent: "fake",
              output: findings,
              attempts: [{ agent: "fake", status: "succeeded" }],
            })
          : Response.json({
              status: "failed",
              error: "the fake agent gave up",
              attempts: [{ agent: "fake", status: "failed", error: "gave up" }],
            })
      },
    })
    root = mkdtempSync(join(tmpdir(), "school-lesson-page-"))
    main = await stack(join(root, "state"))
    vite = await createServer({
      root: web,
      configFile: join(web, "vite.config.ts"),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    })
    await vite.listen()
    base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
    // A missing Chrome fails here, loudly; it is never a skip.
    browser = await chromium.launch({ channel: "chrome" })
    await warm(browser, base)
  },
  timeout(1) + 40_000
)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  await stop(main)
  bridge?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const lessonPath = (course: Name, lesson = "orbits") =>
  `/courses/${course}/lessons/${lesson}`

/** Browser contexts whose /api requests fail as they would with no network (flyingrobots/school#28). */
const offline = new WeakSet<BrowserContext>()

/** Takes a context off the network, or puts it back and says so, as the browser's `online` event does. */
async function network(c: BrowserContext, on: boolean) {
  if (on) offline.delete(c)
  else offline.add(c)
  if (on)
    for (const p of c.pages())
      await p
        .evaluate(() => window.dispatchEvent(new Event("online")))
        .catch(() => {})
}

/** Closes the tab and opens a new one in the same browser profile, which keeps its IndexedDB. */
async function reopen(p: Page): Promise<Page> {
  const c = p.context()
  await p.close()
  const next = await c.newPage()
  next.setDefaultTimeout(5_000)
  return next
}

/**
 * A page whose /api requests reach `s`'s School wherever it is listening now, as the course page's
 * tests do. While School is down, they fail as a refused connection would.
 */
async function newPage(
  s: Stack = main,
  init?: () => void,
  options: { reducedMotion?: "reduce" | "no-preference" } = {}
): Promise<Page> {
  const c = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ...options,
  })
  if (init) await c.addInitScript(init)
  await c.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url())
    if (offline.has(c)) return route.abort("internetdisconnected")
    try {
      await route.fulfill({
        response: await route.fetch({
          url: s.school.url + u.pathname + u.search,
        }),
      })
    } catch {
      // A request still in flight when its context closes (an exposure, say) is already gone.
      await route.abort("connectionrefused").catch(() => {})
    }
  })
  const p = await c.newPage()
  p.setDefaultTimeout(5_000)
  return p
}

/** Opens a lesson and waits for it to be playable: its title is the page heading. */
async function open(
  s: Stack,
  path: string,
  title = "Orbits",
  page?: Page
): Promise<Page> {
  const p = page ?? (await newPage(s))
  await p.goto(base + path)
  await p.getByRole("heading", { level: 1, name: title, exact: true }).waitFor()
  return p
}

const quiz = (p: Page, id: string) =>
  p.locator(`[data-quiz=root][data-quiz-id="${id}"]`)
const explain = (p: Page, id: string) =>
  p.locator(`[data-explain=root][data-explain-id="${id}"]`)
const stateOf = async (l: ReturnType<Page["locator"]>) =>
  l.getAttribute("data-state")

/** The lesson as the API returns it, read straight from School, bypassing the page. */
const record = async (s: Stack, course: Name, lesson = "orbits") =>
  // With the page's ?aid=1, so it resumes the page's encounter: a different aid opens another (RFC 2 §3).
  (await (
    await fetch(`${s.school.url}/api/courses/${course}/lessons/${lesson}?aid=1`)
  ).json()) as {
    encounterId: string
    answers: { blockId: string; choiceId: string; correct: boolean }[]
    explanations: {
      blockId: string
      text: string
      grading: { status: string } | null
    }[]
  }

describe("golden path", () => {
  test("study a lesson: prose, a wrong then right answer, an explanation saved then graded after a retry, and a reload shows it all", async () => {
    const p = await open(main, lessonPath("golden"))

    // Prose is the lesson's HTML, rendered through the markdown item, not shown as markup.
    // Streamdown renders <strong> as its own bold element.
    const prose = p.locator("[data-lesson-block=prose]").first()
    expect(
      await prose
        .locator("[data-slot=markdown] [data-streamdown=strong]")
        .textContent()
    ).toBe("circular")
    expect(await prose.locator("[data-slot=markdown] li").count()).toBe(2)
    expect(await prose.textContent()).not.toContain("<strong>")
    expect(
      await p
        .getByRole("heading", {
          level: 2,
          name: "Where the planets are",
          exact: true,
        })
        .count()
    ).toBe(1)
    expect(
      await p
        .getByRole("heading", {
          level: 2,
          name: "Why the seasons turn",
          exact: true,
        })
        .count()
    ).toBe(1)
    expect(await p.locator("[data-lesson-block=card]").textContent()).toContain(
      "astronomical unit"
    )
    expect(
      await p.locator("[data-lesson-block=aside]").textContent()
    ).toContain("Pluto")
    expect(
      await p.locator("[data-lesson-block=quote]").textContent()
    ).toContain("ellipse")
    expect(
      await p
        .locator("[data-nest=root], [data-lesson-block=nest] [role=tree]")
        .count()
    ).toBeGreaterThan(0)

    // Wrong, then right. Each verdict is the server's.
    const q = quiz(p, "closest")
    await q.locator("[data-choice=venus]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") === "wrong"
    )
    await q.locator("[data-choice=mercury]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") === "right"
    )
    expect(await q.locator("[data-quiz=why]").textContent()).toContain(
      "0.39 AU"
    )
    expect((await record(main, "golden")).answers).toEqual([
      { blockId: "closest", choiceId: "venus", correct: false },
      { blockId: "closest", choiceId: "mercury", correct: true },
    ])

    // The explanation is saved before anything grades it.
    const x = explain(p, "seasons")
    await x
      .locator("[data-explain=draft]")
      .fill("The tilt of the Earth's axis, not its distance from the Sun.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    expect(gradings).toBe(0)
    const saved = (await record(main, "golden")).explanations
    expect(saved).toMatchObject([
      {
        blockId: "seasons",
        text: "The tilt of the Earth's axis, not its distance from the Sun.",
        grading: null,
      },
    ])
    expect(await x.locator("[data-explain=model]").textContent()).toContain(
      "each hemisphere in turn"
    )

    // The first grading fails, and the page offers a retry; the retry succeeds.
    replies.push("fail", "succeed")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "failed"
    )
    expect(await x.locator("[data-explain=failed]").textContent()).toContain(
      "the fake agent gave up"
    )
    expect(await x.locator("[data-explain=grade]").textContent()).toContain(
      "Retry"
    )
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "graded"
    )
    expect(await x.locator("[data-explain=summary]").textContent()).toContain(
      "the tilt, not the distance"
    )
    expect(gradings).toBe(2)

    // A reload shows what the encounter holds: the quiz settled on the right answer, the
    // explanation graded. Nothing is asked again.
    await open(main, lessonPath("golden"), "Orbits", p)
    expect(await stateOf(quiz(p, "closest"))).toBe("settled")
    expect(
      await quiz(p, "closest")
        .locator("[data-choice=mercury]")
        .getAttribute("data-verdict")
    ).toBe("right")
    expect(await stateOf(explain(p, "seasons"))).toBe("graded")
    expect(
      await explain(p, "seasons")
        .locator("[data-explain=summary]")
        .textContent()
    ).toContain("the tilt, not the distance")
    expect(
      await explain(p, "seasons")
        .locator("[data-explain=explanation]")
        .textContent()
    ).toContain("not its distance")
    expect((await record(main, "golden")).answers).toHaveLength(2) // the reload recorded nothing new
    await p.context().close()
  })
})

describe("reload shows what the encounter holds", () => {
  test("a wrong answer alone: the quiz reopens wrong, and the other choices can still be tried", async () => {
    const p = await open(main, lessonPath("wrong"))
    await quiz(p, "closest").locator("[data-choice=mars]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") === "wrong"
    )
    await open(main, lessonPath("wrong"), "Orbits", p)
    const q = quiz(p, "closest")
    expect(await stateOf(q)).toBe("wrong")
    expect(
      await q.locator("[data-choice=mars]").getAttribute("data-verdict")
    ).toBe("wrong")
    expect(await q.locator("[data-choice=mercury]").isEnabled()).toBe(true)
    await q.locator("[data-choice=mercury]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") === "right"
    )
    await p.context().close()
  })

  test("a saved explanation not yet graded: it reopens saved, with its model answer and the feedback button", async () => {
    const p = await open(main, lessonPath("saved"))
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("Because of the tilt.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    await open(main, lessonPath("saved"), "Orbits", p)
    expect(await stateOf(explain(p, "seasons"))).toBe("saved")
    expect(
      await explain(p, "seasons")
        .locator("[data-explain=explanation]")
        .textContent()
    ).toContain("Because of the tilt.")
    expect(
      await explain(p, "seasons").locator("[data-explain=grade]").isEnabled()
    ).toBe(true)
    await p.context().close()
  })

  test("a failed grading: it reopens not graded, still offering the retry", async () => {
    const p = await open(main, lessonPath("failed"))
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("Because of the tilt.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    replies.push("fail")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "failed"
    )
    await open(main, lessonPath("failed"), "Orbits", p)
    expect(await stateOf(explain(p, "seasons"))).toBe("failed")
    expect(
      await explain(p, "seasons").locator("[data-explain=grade]").textContent()
    ).toContain("Retry")
    await p.context().close()
  })
})

describe("browser title", () => {
  test("names the lesson, its course and School, in the web view and in slides", async () => {
    const p = await open(main, lessonPath("golden"))
    expect(await p.title()).toBe("Orbits · golden · School")
    await p.goto(base + lessonPath("golden") + "?view=slides")
    await p.getByRole("heading", { name: "Orbits" }).first().waitFor()
    expect(await p.title()).toBe("Orbits · golden · School")
    await p.context().close()
  })

  test("a lesson that is not found says so in the title", async () => {
    const p = await newPage()
    await p.goto(base + "/courses/golden/lessons/no-such-lesson")
    await p
      .getByRole("heading", { level: 1, name: "Lesson not found", exact: true })
      .waitFor()
    expect(await p.title()).toBe("Lesson not found · golden · School")
    await p.context().close()
  })
})

describe("not found", () => {
  test.each([
    [
      "a lesson id that does not exist",
      "/courses/golden/lessons/no-such-lesson",
    ],
    ["a course that does not exist", "/courses/no-such-course/lessons/orbits"],
  ])("%s shows a not-found state", async (_, path) => {
    const p = await newPage()
    await p.goto(base + path)
    await p
      .getByRole("heading", { level: 1, name: "Lesson not found", exact: true })
      .waitFor()
    expect(
      await p.locator("[data-quiz=root], [data-explain=root]").count()
    ).toBe(0)
    await p.context().close()
  })
})

describe("loading", () => {
  test("shows Skeletons and a Spinner until the lesson arrives", async () => {
    const p = await newPage()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await p.route(
      "**/api/courses/loading/lessons/orbits?aid=1",
      async (route) => {
        await held
        await route.fallback()
      }
    )
    await p.goto(base + lessonPath("loading"))
    await p.locator("[data-lesson=loading]").waitFor()
    expect(
      await p.locator("[data-lesson=loading] [data-slot=skeleton]").count()
    ).toBeGreaterThan(0)
    expect(
      await p
        .locator(
          "[data-lesson=loading] [data-slot=spinner], [data-lesson=loading] [role=status]"
        )
        .count()
    ).toBeGreaterThan(0)
    release()
    await p
      .getByRole("heading", { level: 1, name: "Orbits", exact: true })
      .waitFor()
    expect(await p.locator("[data-lesson=loading]").count()).toBe(0)
    await p.context().close()
  })
})

describe("aid tracking (flyingrobots/school#51)", () => {
  test("the page opens the lesson with ?aid=1: it declares that it records the help it shows", async () => {
    const p = await newPage()
    const asked: string[] = []
    p.on("request", (r) => {
      if (r.url().includes("/api/courses/")) asked.push(r.url())
    })
    await open(main, lessonPath("aid"), "Orbits", p)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.map((u) => new URL(u).searchParams.getAll("aid"))).toEqual(
      asked.map(() => ["1"])
    )
    await p.context().close()
  })
})

/** Every POST the page sends to School, in order, with its JSON body. */
function posts(p: Page) {
  const sent: { path: string; body: Record<string, string> }[] = []
  p.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/"))
      sent.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() })
  })
  const exposures = () =>
    sent.filter((x) => x.path === "/api/exposure").map((x) => x.body)
  return { sent, exposures }
}

/**
 * Waits until `n` exposures have been sent, then a while longer, so that a second send of one
 * showing (an effect run twice, say) would be seen. Strict mode's second run is in the same commit,
 * well inside this.
 */
async function exposed(p: Page, seen: ReturnType<typeof posts>, n: number) {
  const until = Date.now() + 5_000
  while (seen.exposures().length < n && Date.now() < until)
    await p.waitForTimeout(25)
  await p.waitForTimeout(300)
  return seen.exposures()
}

const encounterOf = (seen: ReturnType<typeof posts>) =>
  seen.sent.find((x) => x.path !== "/api/exposure")!.body.encounterId
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("every exposure the page shows is recorded once per showing (flyingrobots/school#51)", () => {
  test("feedback: the quiz's why, once when a right answer shows it, never for a wrong one, and once more on a reload that shows it again", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("feedback"), "Orbits", p)
    const q = quiz(p, "closest")
    await q.locator("[data-choice=venus]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") === "wrong"
    )
    expect(await exposed(p, seen, 0)).toEqual([])
    await q.locator("[data-choice=mercury]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") === "right"
    )
    const once = await exposed(p, seen, 1)
    expect(once).toEqual([
      {
        exposureId: expect.stringMatching(UUID),
        encounterId: encounterOf(seen),
        blockId: "closest",
        kind: "feedback",
      },
    ])
    // Stored, and never anything the learner sees.
    expect(await q.locator("[data-quiz=error]").count()).toBe(0)

    await open(main, lessonPath("feedback"), "Orbits", p)
    expect(await stateOf(quiz(p, "closest"))).toBe("settled")
    const twice = await exposed(p, seen, 2)
    expect(twice.map((x) => [x.blockId, x.kind])).toEqual([
      ["closest", "feedback"],
      ["closest", "feedback"],
    ])
    expect(twice[1]!.exposureId).not.toBe(twice[0]!.exposureId)
    await p.context().close()
  })

  test("model-answer: once when a saved explanation shows it, not again while it is graded, and once more on a reload that shows it again", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("model"), "Orbits", p)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("The tilt of the axis.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    replies.push("fail", "succeed")
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "failed"
    )
    await x.locator("[data-explain=grade]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "graded"
    )
    const once = await exposed(p, seen, 1)
    expect(once).toEqual([
      {
        exposureId: expect.stringMatching(UUID),
        encounterId: encounterOf(seen),
        blockId: "seasons",
        kind: "model-answer",
      },
    ])
    expect(await x.locator("[data-explain=error]").count()).toBe(0)

    await open(main, lessonPath("model"), "Orbits", p)
    expect(await stateOf(explain(p, "seasons"))).toBe("graded")
    expect((await exposed(p, seen, 2)).map((e) => [e.blockId, e.kind])).toEqual(
      [
        ["seasons", "model-answer"],
        ["seasons", "model-answer"],
      ]
    )
    await p.context().close()
  })

  test("reference: once each time one of an explain block's sources is opened", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("source"), "Orbits", p)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("The tilt of the axis.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    expect((await exposed(p, seen, 1)).map((e) => e.kind)).toEqual([
      "model-answer",
    ])
    const source = x
      .locator("[data-explain=sources]")
      .getByRole("button", { name: "The tilt" })
    await source.click()
    await x
      .locator("[data-explain=sources]")
      .getByText("23.4 degrees")
      .waitFor()
    expect((await exposed(p, seen, 2)).map((e) => [e.blockId, e.kind])).toEqual(
      [
        ["seasons", "model-answer"],
        ["seasons", "reference"],
      ]
    )
    await source.click() // closing it shows nothing
    expect(await exposed(p, seen, 2)).toHaveLength(2)
    await p.context().close()
  })
})

describe("RFC 2 Figure 4 over the page: submit, reveal, revise (flyingrobots/school#51)", () => {
  test("the first explanation, the model answer it reveals, and the revision reach School in that order, in one encounter", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("trace"), "Orbits", p)
    const x = explain(p, "seasons")
    await x
      .locator("[data-explain=draft]")
      .fill("Because the Earth is closer to the Sun in summer.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    expect(await x.locator("[data-explain=model]").textContent()).toContain(
      "each hemisphere in turn"
    )
    await x.locator("[data-explain=revise]").click()
    expect(await x.locator("[data-explain=draft]").inputValue()).toBe(
      "Because the Earth is closer to the Sun in summer."
    )
    await x
      .locator("[data-explain=draft]")
      .fill(
        "The axis is tilted, so each hemisphere in turn leans towards the Sun."
      )
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    await exposed(p, seen, 2)

    const trace = seen.sent.map((s) =>
      s.path === "/api/exposure"
        ? `${s.path} ${s.body.kind}`
        : `${s.path} ${s.body.text}`
    )
    expect(trace).toEqual([
      "/api/explanation Because the Earth is closer to the Sun in summer.",
      "/api/exposure model-answer",
      "/api/explanation The axis is tilted, so each hemisphere in turn leans towards the Sun.",
      "/api/exposure model-answer", // the revision shows the model answer again
    ])
    expect(new Set(seen.sent.map((s) => s.body.encounterId))).toEqual(
      new Set([encounterOf(seen)])
    )
    // Two submissions, both stored: the lesson API shows a block's latest, the revision.
    const saves = seen.sent
      .filter((s) => s.path === "/api/explanation")
      .map((s) => s.body.submissionId)
    expect(new Set(saves).size).toBe(2)
    expect((await record(main, "trace")).explanations).toMatchObject([
      {
        blockId: "seasons",
        text: "The axis is tilted, so each hemisphere in turn leans towards the Sun.",
      },
    ])
    await p.context().close()
  })

  test("on School served from pglite:, the first explanation has no recorded aid and the revision is aided", async () => {
    const p = await newPage()
    const seen = posts(p)
    await open(main, lessonPath("figure4"), "Orbits", p)
    const x = explain(p, "seasons")
    await x
      .locator("[data-explain=draft]")
      .fill("Because the Earth is closer to the Sun in summer.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    await x.locator("[data-explain=revise]").click()
    await x
      .locator("[data-explain=draft]")
      .fill(
        "The axis is tilted, so each hemisphere in turn leans towards the Sun."
      )
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    const [a, b] = seen.sent
      .filter((s) => s.path === "/api/explanation")
      .map((s) => s.body.submissionId!)
    // The aid School derives from its own record, read past the page.
    const aid = async (id: string) =>
      (await (await fetch(`${main.school.url}/api/aid/${id}`)).json()) as {
        aid: string
      }
    expect((await aid(a!)).aid).toBe("no-recorded-aid")
    expect((await aid(b!)).aid).toBe("aided")
    await p.context().close()
  })
})

describe("an exposure that did not reach School (flyingrobots/school#51)", () => {
  // School on Postgres stores exposures, so 501 (a record that stores none) no longer happens; the
  // page still treats it, and a refusal, as final: not resent, never shown, never holding a save back.
  test.each([
    [501, "unsupported"],
    [400, "rejected"],
    [409, "conflict"],
  ])(
    "answered %i, it is final: not resent, not shown, and the next save goes ahead",
    async (status, reply) => {
      const p = await newPage()
      const seen = posts(p)
      await p.route("**/api/exposure", (route) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ status: reply }),
        })
      )
      await open(main, lessonPath(`final-${status}` as Name), "Orbits", p)
      const x = explain(p, "seasons")
      await x.locator("[data-explain=draft]").fill("Because of the distance.")
      await x.locator("[data-explain=save]").click()
      await p.waitForFunction(
        () =>
          document
            .querySelector("[data-explain-id=seasons]")
            ?.getAttribute("data-state") === "saved"
      )
      expect(await exposed(p, seen, 1)).toHaveLength(1)
      await x.locator("[data-explain=revise]").click()
      await x.locator("[data-explain=draft]").fill("Because of the tilt.")
      await x.locator("[data-explain=save]").click()
      await p.waitForFunction(
        () =>
          document
            .querySelector("[data-explain-id=seasons]")
            ?.getAttribute("data-state") === "saved"
      )
      expect(await x.locator("[data-explain=error]").count()).toBe(0)
      const ids = (await exposed(p, seen, 2)).map((e) => e.exposureId)
      expect(new Set(ids).size).toBe(ids.length) // two showings, each sent once
      expect(seen.sent.map((s) => s.path)).toEqual([
        "/api/explanation",
        "/api/exposure",
        "/api/explanation",
        "/api/exposure",
      ])
      await p.context().close()
    }
  )

  test("is resent with the same id before the block's next submission, and while it cannot be recorded, that submission is not sent", async () => {
    const p = await newPage()
    const seen = posts(p)
    let down = true
    await p.route("**/api/exposure", (route) =>
      down ? route.abort("connectionrefused") : route.fallback()
    )
    await open(main, lessonPath("resend"), "Orbits", p)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("Because of the distance.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    const [first] = await exposed(p, seen, 1)
    expect(first!.kind).toBe("model-answer")
    expect(await x.locator("[data-explain=error]").count()).toBe(0) // the learner is not told about bookkeeping

    // Still down: the revision is not sent, since School would not know it came after the model
    // answer. It waits behind the exposure in the outbox (flyingrobots/school#28), not sent yet.
    await x.locator("[data-explain=revise]").click()
    await x.locator("[data-explain=draft]").fill("Because of the tilt.")
    await x.locator("[data-explain=save]").click()
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "queued"
    )
    expect(await x.locator("[data-explain=draft]").inputValue()).toBe(
      "Because of the tilt."
    )
    expect(await x.locator("[data-explain=model]").count()).toBe(0)
    await p.waitForTimeout(1_500) // several resends of the exposure, none of the revision
    expect(seen.sent.filter((s) => s.path === "/api/explanation")).toHaveLength(
      1
    )

    // Back: the same exposure goes first, then the revision, with nothing asked of the learner.
    down = false
    await network(p.context(), true)
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-explain-id=seasons]")
          ?.getAttribute("data-state") === "saved"
    )
    const after = seen.sent.slice(
      seen.sent.findIndex(
        (s) =>
          s.path === "/api/explanation" &&
          s.body.text === "Because of the tilt."
      ) - 1
    )
    expect(
      after.slice(0, 2).map((s) => [s.path, s.body.exposureId ?? s.body.text])
    ).toEqual([
      ["/api/exposure", first!.exposureId],
      ["/api/explanation", "Because of the tilt."],
    ])
    // The revision shows the model answer again, a second showing; wait for it to be sent.
    const ids = () => new Set(seen.exposures().map((e) => e.exposureId))
    for (let t = Date.now(); ids().size < 2 && Date.now() - t < 5_000;)
      await p.waitForTimeout(25)
    await p.waitForTimeout(300)
    expect(ids().size).toBe(2) // the model answer's two showings, however many times each was sent
    await p.context().close()
  })
})

describe("previous and next", () => {
  test("next and previous links move between lessons, on the client", async () => {
    const p = await open(main, lessonPath("pager"))
    await p.evaluate(
      () => ((window as unknown as { marker: number }).marker = 1)
    )
    expect(await p.locator("a[rel=prev]").count()).toBe(0) // the first lesson has no previous
    await p.locator("a[rel=next]").first().click()
    await p
      .getByRole("heading", { level: 1, name: "Moons", exact: true })
      .waitFor()
    expect(await p.locator("a[rel=next]").count()).toBe(0) // the last has no next
    expect(await quiz(p, "moons-none").count()).toBe(1)
    await p.locator("a[rel=prev]").first().click()
    await p
      .getByRole("heading", { level: 1, name: "Orbits", exact: true })
      .waitFor()
    expect(
      await p.evaluate(() => (window as unknown as { marker?: number }).marker)
    ).toBe(1)
    await p.context().close()
  })
})

describe("links in lesson prose (flyingrobots/school#125)", () => {
  // The same-origin link names the page's own origin, which is known only once Vite listens, so
  // this course is written here: the fixture's orbits lesson, then a lesson whose prose links to
  // it relatively, by School's own origin, to a file in a source mount, and to another origin.
  let links: Stack
  beforeAll(async () => {
    const course = join(root, "links-course")
    mkdirSync(join(course, "lessons"), { recursive: true })
    copyFileSync(
      join(COURSE, "lessons", "0001-orbits.json"),
      join(course, "lessons", "0001-orbits.json")
    )
    const html =
      `<p>Read <a href="/courses/links/lessons/orbits">the relative link</a>, ` +
      `<a href="${base}/courses/links/lessons/orbits">the same-origin link</a>, ` +
      `<a href="/notes/README.md">the source link</a> and ` +
      `<a href="https://example.com/planets">the external link</a>.</p>`
    const lesson = {
      type: "page",
      id: "links",
      title: "Links",
      subtitle: "",
      children: [{ type: "prose", id: "links-prose", html }],
    }
    writeFileSync(
      join(course, "lessons", "0002-links.json"),
      JSON.stringify(lesson)
    )
    const notes = join(root, "links-notes")
    mkdirSync(notes, { recursive: true })
    writeFileSync(
      join(notes, "README.md"),
      "# Notes\n\nSource material the lesson cites.\n"
    )
    links = await stack(join(root, "links-state"), `links=${course}`, {
      SCHOOL_MOUNTS: `notes=${notes}`,
    })
  }, timeout(1))
  afterAll(() => stop(links))

  const link = (p: Page, name: string) =>
    p.locator("[data-lesson-block=prose] [data-streamdown=link]", {
      hasText: name,
    })
  const modal = (p: Page) => p.locator("[data-streamdown=link-safety-modal]")

  for (const name of ["the relative link", "the same-origin link"])
    test(`${name} opens the lesson in the same tab, with no confirmation`, async () => {
      const p = await open(links, "/courses/links/lessons/links", "Links")
      expect(await link(p, name).getAttribute("href")).toMatch(
        /\/courses\/links\/lessons\/orbits$/
      )
      await link(p, name).click()
      await p
        .getByRole("heading", { level: 1, name: "Orbits", exact: true })
        .waitFor()
      expect(new URL(p.url()).pathname).toBe("/courses/links/lessons/orbits")
      expect(await modal(p).count()).toBe(0)
      expect(p.context().pages()).toHaveLength(1) // no new tab
      await p.context().close()
    })

  // A source-mount file is not an app route: it must load as a document in the same tab, not go
  // through the client router (which would show School's not-found page).
  test("the source link opens the mounted file in the same tab, with no confirmation", async () => {
    const p = await open(links, "/courses/links/lessons/links", "Links")
    await p.context().route(/\/notes\//, async (route) => {
      const u = new URL(route.request().url())
      await route
        .fulfill({
          response: await route.fetch({ url: links.school.url + u.pathname }),
        })
        .catch(() => {})
    })
    expect(await link(p, "the source link").getAttribute("href")).toBe(
      "/notes/README.md"
    )
    await Promise.all([
      p.waitForURL(/\/notes\/README\.md$/),
      link(p, "the source link").click(),
    ])
    await p.waitForLoadState("domcontentloaded")
    expect(await p.locator("body").textContent()).toContain(
      "Source material the lesson cites."
    )
    expect(await modal(p).count()).toBe(0)
    expect(p.context().pages()).toHaveLength(1) // no new tab
    await p.context().close()
  })

  test("the external link still asks first, and nothing opens until it is confirmed", async () => {
    const p = await open(links, "/courses/links/lessons/links", "Links")
    await link(p, "the external link").click()
    await modal(p).waitFor()
    expect(await modal(p).textContent()).toContain("Open external link?")
    expect(await modal(p).textContent()).toContain(
      "https://example.com/planets"
    )
    expect(new URL(p.url()).pathname).toBe("/courses/links/lessons/links")
    expect(p.context().pages()).toHaveLength(1)
    await p.context().close()
  })
})

describe("keys (flyingrobots/school#84)", () => {
  test.each([
    ["↓", "ArrowDown"],
    ["j", "j"],
  ])(
    "%s steps through the lesson's sections and blocks in reading order, scrolling each into view",
    async (_, key) => {
      const p = await open(main, lessonPath("keys"))
      // From the breadcrumb's last link, the first focus stop above the lesson.
      await p
        .locator("[data-lesson=root] nav[aria-label=breadcrumb] a")
        .last()
        .focus()
      const seen: string[] = []
      const ys: number[] = []
      for (let i = 0; i < 10; i++) {
        await p.keyboard.press(key)
        const at = await p.evaluate(() => {
          const el = document.activeElement
          const stop =
            el?.getAttribute("data-lesson-block") ??
            (el?.closest("[data-lesson=section]") && el.matches("h2")
              ? `section: ${el.textContent}`
              : null)
          return { stop, y: window.scrollY }
        })
        seen.push(at.stop ?? "elsewhere")
        ys.push(at.y)
      }
      expect(seen).toEqual([
        "section: Where the planets are",
        "prose",
        "quiz",
        "card",
        "aside",
        "section: Why the seasons turn",
        "quote",
        "prose",
        "explain",
        "nest",
      ])
      // The page scrolls to follow, and never back up.
      expect(ys.at(-1)!).toBeGreaterThan(0)
      expect(ys).toEqual([...ys].sort((a, b) => a - b))
      await p.context().close()
    }
  )
})

describe("the server down", () => {
  // Before flyingrobots/school#28 the block said it was not saved and the learner tried again; now
  // the submission waits in the outbox and is sent by itself once School is back.
  test(
    "while answering, nothing is shown as saved: it waits as not sent yet, and once School is back it is sent and shown",
    async () => {
      const down = await stack(join(root, "down-state"))
      try {
        const p = await open(down, lessonPath("down"))
        down.school.proc.kill("SIGKILL")
        await down.school.proc.exited

        const q = quiz(p, "closest")
        await q.locator("[data-choice=mercury]").click()
        await p.waitForFunction(
          () =>
            document
              .querySelector("[data-quiz-id=closest]")
              ?.getAttribute("data-state") === "queued"
        )
        expect(await q.locator("[data-slot=badge]").textContent()).toBe(
          "Not sent yet"
        )
        expect(await q.locator("[data-verdict]").count()).toBe(0)
        expect(await q.locator("[data-quiz=why]").count()).toBe(0)

        const x = explain(p, "seasons")
        await x.locator("[data-explain=draft]").fill("The tilt.")
        await x.locator("[data-explain=save]").click()
        await p.waitForFunction(
          () =>
            document
              .querySelector("[data-explain-id=seasons]")
              ?.getAttribute("data-state") === "queued"
        )
        expect(await x.locator("[data-explain=draft]").inputValue()).toBe(
          "The tilt."
        ) // nothing typed is lost
        expect(await x.locator("[data-explain=model]").count()).toBe(0)

        // School comes back on the same state (on a new port, which the page's route follows); the
        // same page sends both, in order, without being asked again.
        down.school = await startSchool(down.env)
        await p.waitForFunction(
          () =>
            document
              .querySelector("[data-quiz-id=closest]")
              ?.getAttribute("data-state") === "right",
          null,
          { timeout: 15_000 }
        )
        await p.waitForFunction(
          () =>
            document
              .querySelector("[data-explain-id=seasons]")
              ?.getAttribute("data-state") === "saved",
          null,
          { timeout: 15_000 }
        )
        expect((await record(down, "down")).answers).toEqual([
          { blockId: "closest", choiceId: "mercury", correct: true },
        ])
        await p.context().close()
      } finally {
        await stop(down)
      }
    },
    timeout(2) + 15_000
  )

  test("when the lesson cannot load, the page says so and offers a retry", async () => {
    const p = await newPage()
    await p.route("**/api/courses/**", (route) => route.abort())
    await p.goto(base + lessonPath("golden"))
    await p
      .getByRole("heading", {
        level: 1,
        name: "The lesson did not load",
        exact: true,
      })
      .waitFor()
    await p.unroute("**/api/courses/**")
    await p.getByRole("button", { name: "Try again" }).click()
    await p
      .getByRole("heading", { level: 1, name: "Orbits", exact: true })
      .waitFor()
    await p.context().close()
  })
})

const until = (
  p: Page,
  kind: "quiz" | "explain",
  id: string,
  state: string,
  timeout = 10_000
) =>
  p.waitForFunction(
    ([k, i, st]) =>
      document
        .querySelector(`[data-${k}-id="${i}"]`)
        ?.getAttribute("data-state") === st,
    [kind, id, state] as const,
    { timeout }
  )

/** The outbox's items, read through the app's own module in the page. */
const outboxOf = (p: Page) =>
  p.evaluate(async () => {
    const url = "/src/lib/outbox.ts"
    const m = (await import(
      /* @vite-ignore */ url
    )) as typeof import("../src/lib/outbox.ts")
    return (await m.outbox().waiting()).map((w) => w.body.submissionId)
  })

/** Every answer School replied to, with its reply. */
function replies_(p: Page) {
  const got: {
    body: Record<string, string>
    reply: { status: string; correct?: boolean; firstTry?: boolean }
  }[] = []
  p.on("response", async (r) => {
    if (r.request().method() !== "POST" || !r.url().endsWith("/api/answer"))
      return
    got.push({
      body: r.request().postDataJSON(),
      reply: await r.json().catch(() => ({ status: `http ${r.status()}` })),
    })
  })
  return got
}

async function eventually(
  check: () => Promise<boolean> | boolean,
  ms = 10_000
) {
  for (
    const t = Date.now();
    Date.now() - t < ms;
    await new Promise((r) => setTimeout(r, 50))
  )
    if (await check()) return
  throw new Error("timed out")
}

describe("the outbox (flyingrobots/school#28)", () => {
  test("golden: an answer and an explanation made offline, the tab closed, then reopened online, are each stored exactly once", async () => {
    let p = await newPage()
    const before = posts(p)
    await open(main, lessonPath("ob-golden"), "Orbits", p)
    await network(p.context(), false)

    const q = quiz(p, "closest")
    await q.locator("[data-choice=mercury]").click()
    await until(p, "quiz", "closest", "queued")
    // Pending, and said so: a spinner on the choice, never a verdict or the explanation.
    expect(await q.locator("[data-slot=badge]").textContent()).toBe(
      "Not sent yet"
    )
    expect(
      await q.locator("[data-choice=mercury] [data-slot=spinner]").count()
    ).toBe(1)
    expect(await q.locator("[data-verdict]").count()).toBe(0)
    expect(await q.locator("[data-quiz=why]").count()).toBe(0)
    const x = explain(p, "seasons")
    await x.locator("[data-explain=draft]").fill("The tilt of the axis.")
    await x.locator("[data-explain=save]").click()
    await until(p, "explain", "seasons", "queued")
    expect(await x.locator("[data-slot=badge]").first().textContent()).toBe(
      "Not sent yet"
    )
    expect(await x.locator("[data-explain=model]").count()).toBe(0)
    expect(await record(main, "ob-golden")).toMatchObject({
      answers: [],
      explanations: [],
    })
    // Kept in the outbox under the ids they were made with; the answer was tried, and the explanation waits behind it.
    const ids = await outboxOf(p)
    expect(ids).toHaveLength(2)
    expect(
      before.sent
        .filter((s) => s.path === "/api/answer")
        .map((s) => s.body.submissionId)
    ).toContain(ids[0]!)

    p = await reopen(p)
    await network(p.context(), true)
    const after = posts(p)
    await open(main, lessonPath("ob-golden"), "Orbits", p)
    await eventually(
      async () => (await record(main, "ob-golden")).explanations.length === 1
    )
    expect((await record(main, "ob-golden")).answers).toEqual([
      { blockId: "closest", choiceId: "mercury", correct: true },
    ])
    expect((await record(main, "ob-golden")).explanations).toMatchObject([
      { blockId: "seasons", text: "The tilt of the axis." },
    ])
    // The new tab sent each under the id it was made with, once, in the order made.
    expect(
      after.sent
        .filter((s) => s.path !== "/api/exposure")
        .map((s) => s.body.submissionId)
    ).toEqual(ids)
    // The page shows what School holds; nothing is left waiting.
    await p.waitForFunction(() =>
      ["right", "settled"].includes(
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") ?? ""
      )
    )
    await until(p, "explain", "seasons", "saved")
    expect(await outboxOf(p)).toEqual([])
    await p.context().close()
  })

  test("a reply lost after School stored the answer: the resend is a duplicate, never a second row", async () => {
    const p = await newPage()
    const got = replies_(p)
    let lose = 1
    await p.route("**/api/answer", async (route) => {
      if (lose-- <= 0) return route.fallback()
      // School stores it; the reply never reaches the page.
      const u = new URL(route.request().url())
      await route.fetch({ url: main.school.url + u.pathname })
      await route.abort("connectionreset")
    })
    await open(main, lessonPath("ob-lost"), "Orbits", p)
    await quiz(p, "closest").locator("[data-choice=venus]").click()
    await until(p, "quiz", "closest", "wrong")
    // The page can show the verdict before replies_ has read the resend's body (it pushes after an
    // await), so wait for the reply itself, then assert on it.
    await eventually(() => got.length > 0)
    expect(got.map((g) => g.reply.status)).toEqual(["duplicate"])
    expect((await record(main, "ob-lost")).answers).toEqual([
      { blockId: "closest", choiceId: "venus", correct: false },
    ])
    await p.context().close()
  })

  test("without browser storage (private mode), an answer is send-or-fail: sent at once, and refused honestly when School cannot be reached", async () => {
    const p = await newPage(main, () => {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get() {
          throw new DOMException(
            "The user denied permission to access the database.",
            "SecurityError"
          )
        },
      })
    })
    await open(main, lessonPath("ob-private"), "Orbits", p)
    const q = quiz(p, "closest")
    await q.locator("[data-choice=venus]").click()
    await until(p, "quiz", "closest", "wrong")

    await network(p.context(), false)
    await q.locator("[data-choice=mercury]").click()
    await q.locator("[data-quiz=error]").waitFor()
    expect(await q.locator("[data-quiz=error]").textContent()).toContain(
      "this browser cannot keep your answer"
    )
    expect(await q.locator("[data-quiz=error]").textContent()).toContain(
      "It was not recorded"
    )
    expect(await stateOf(q)).toBe("wrong") // back where it was, never "not sent yet"

    await network(p.context(), true)
    await p.waitForTimeout(1_000) // nothing was kept, so nothing is sent by itself
    expect((await record(main, "ob-private")).answers).toEqual([
      { blockId: "closest", choiceId: "venus", correct: false },
    ])
    await q.locator("[data-choice=mercury]").click()
    await until(p, "quiz", "closest", "right")
    await p.context().close()
  })

  test.each([
    [409, "conflict"],
    [400, "rejected"],
  ] as const)(
    "a queued answer School answers %i (%s) is shown as refused and never sent again",
    async (status, reply) => {
      const name = `ob-${status}` as Name
      let p = await newPage()
      await open(main, lessonPath(name), "Orbits", p)
      await network(p.context(), false)
      await quiz(p, "closest").locator("[data-choice=mercury]").click()
      await until(p, "quiz", "closest", "queued")

      p = await reopen(p)
      let asked = 0
      await p.route("**/api/answer", (route) => {
        asked += 1
        return route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ status: reply }),
        })
      })
      await network(p.context(), true)
      await open(main, lessonPath(name), "Orbits", p)
      const q = quiz(p, "closest")
      await q.locator("[data-quiz=error]").waitFor()
      expect(await q.locator("[data-quiz=error]").textContent()).toContain(
        `School refused this answer (${reply})`
      )
      expect(await stateOf(q)).toBe("unanswered")
      await p.waitForTimeout(2_000) // past several backoff periods
      expect(asked).toBe(1)
      expect(await outboxOf(p)).toEqual([])
      await p.context().close()
    }
  )

  test("two answers to one block, queued from two tabs, are sent in the order they were made: the first stays the first try", async () => {
    const a = await newPage()
    await open(main, lessonPath("ob-order"), "Orbits", a)
    const b = await a.context().newPage()
    b.setDefaultTimeout(5_000)
    await open(main, lessonPath("ob-order"), "Orbits", b)
    await network(a.context(), false)
    await quiz(a, "closest").locator("[data-choice=venus]").click()
    await until(a, "quiz", "closest", "queued")
    await quiz(b, "closest").locator("[data-choice=mercury]").click()
    await until(b, "quiz", "closest", "queued")
    await b.close()

    const p = await reopen(a)
    const got = replies_(p)
    await network(p.context(), true)
    await open(main, lessonPath("ob-order"), "Orbits", p)
    await eventually(
      async () => (await record(main, "ob-order")).answers.length === 2
    )
    expect((await record(main, "ob-order")).answers).toEqual([
      { blockId: "closest", choiceId: "venus", correct: false },
      { blockId: "closest", choiceId: "mercury", correct: true },
    ])
    await eventually(
      () => got.filter((g) => g.reply.status === "stored").length === 2
    )
    expect(
      got
        .filter((g) => g.reply.status === "stored")
        .map((g) => [g.body.choiceId, g.reply.firstTry])
    ).toEqual([
      ["venus", true],
      ["mercury", false],
    ])
    await p.waitForFunction(() =>
      ["right", "settled"].includes(
        document
          .querySelector("[data-quiz-id=closest]")
          ?.getAttribute("data-state") ?? ""
      )
    )
    await p.context().close()
  })

  test("50 queued submissions are flushed at once: every one stored once, in the order made", async () => {
    let p = await newPage()
    await open(main, lessonPath("ob-50"), "Orbits", p)
    const { encounterId } = await record(main, "ob-50")
    await network(p.context(), false)
    const choices = Array.from(
      { length: 50 },
      (_, i) => ["venus", "mars", "mercury"][i % 3]!
    )
    const made = await p.evaluate(
      async ([encounterId, choices]) => {
        const url = "/src/lib/outbox.ts"
        const m = (await import(
          /* @vite-ignore */ url
        )) as typeof import("../src/lib/outbox.ts")
        const ids: string[] = []
        const queued: Promise<void>[] = []
        for (const [i, choiceId] of choices.entries()) {
          const submissionId = crypto.randomUUID()
          ids.push(submissionId)
          queued.push(
            new Promise<void>((queued) => {
              void m
                .outbox()
                .submit(
                  {
                    kind: "answer",
                    id: submissionId,
                    body: {
                      submissionId,
                      encounterId,
                      blockId: "closest",
                      choiceId,
                      ms: i,
                    },
                  },
                  { queued }
                )
                .catch(() => {})
            })
          )
        }
        await Promise.all(queued)
        return ids
      },
      [encounterId, choices] as const
    )
    expect(made).toHaveLength(50)

    p = await reopen(p)
    const seen = posts(p)
    await network(p.context(), true)
    await open(main, lessonPath("ob-50"), "Orbits", p)
    await eventually(
      async () => (await record(main, "ob-50")).answers.length >= 50,
      30_000
    )
    await eventually(async () => (await outboxOf(p)).length === 0)
    const answers = (await record(main, "ob-50")).answers
    expect(answers.map((a) => a.choiceId)).toEqual(choices)
    const sent = seen.sent
      .filter((s) => s.path === "/api/answer")
      .map((s) => s.body.submissionId)
    expect(sent).toEqual(made) // each once, in order, under the id it was made with
    await p.context().close()
  }, 60_000)
})

describe("delayed review (flyingrobots/school#32)", () => {
  test(
    "an item answered wrong first comes back at the top of the next lesson with its reason in words, and a reload shows the same",
    async () => {
      // Two days ago, in the record School is about to open: the closest planet, Venus then Mercury.
      const state = join(root, "review-state")
      mkdirSync(state, { recursive: true })
      const db = await openDatabase({
        driver: "pglite",
        dir: join(state, "record"),
      })
      const r = postgresRecord(db.sql)
      const orbits = loadLibrary(join(COURSE, "lessons")).pages.find(
        (p) => p.id === "orbits"
      )!
      const then = Date.now() - 2 * 24 * 3600 * 1000
      const e = await r.openEncounter({
        course: "review",
        lesson: "orbits",
        page: orbits,
        now: new Date(then).toISOString(),
        aidTracking: 1,
      })
      for (const [choiceId, ms] of [
        ["venus", 1000],
        ["mercury", 2000],
      ] as const) {
        await r.submit(
          {
            submissionId: crypto.randomUUID(),
            encounterId: e.id,
            blockId: "closest",
            choiceId,
            ms: 10,
          },
          new Date(then + ms).toISOString()
        )
      }
      await db.close()
      const s = await stack(state)
      try {
        const p = await open(s, lessonPath("review", "moons"), "Moons")
        // The Review section comes first, with the item in it, then the lesson's own quiz.
        await p
          .getByRole("heading", { level: 2, name: "Review", exact: true })
          .waitFor()
        const order = () =>
          p
            .locator("[data-quiz=root]")
            .evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-quiz-id"))
            )
        expect(await order()).toEqual(["closest", "moons-none"])
        const why = p.getByRole("alert").filter({ hasText: "Back for review" })
        expect(await why.count()).toBe(1)
        expect(await why.textContent()).toMatch(
          /Back because your first answer on \d{1,2} [A-Z][a-z]+ was wrong; you put it right on a later try\./
        )
        const reason = await why.textContent()

        // Answered in this lesson, right first try; a reload is the same encounter, with the same review.
        await quiz(p, "closest").locator("[data-choice=mercury]").click()
        await p.waitForFunction(
          () =>
            document
              .querySelector("[data-quiz-id=closest]")
              ?.getAttribute("data-state") === "right"
        )
        await open(s, lessonPath("review", "moons"), "Moons", p)
        await p
          .getByRole("heading", { level: 2, name: "Review", exact: true })
          .waitFor()
        expect(await order()).toEqual(["closest", "moons-none"])
        expect(await stateOf(quiz(p, "closest"))).toBe("settled")
        expect(
          await p
            .getByRole("alert")
            .filter({ hasText: "Back for review" })
            .textContent()
        ).toBe(reason)
        expect((await record(s, "review", "moons")).answers).toEqual([
          { blockId: "closest", choiceId: "mercury", correct: true },
        ])
        await p.context().close()
      } finally {
        await stop(s)
      }
    },
    timeout(1) + 15_000
  )
})

describe("the slides view (flyingrobots/school#43)", () => {
  const slidesPath = (course: Name, lesson = "orbits") =>
    `${lessonPath(course, lesson)}?view=slides`
  const slides = (p: Page) => p.locator("[data-slides=root]")
  const shown = (p: Page) =>
    p
      .locator("[data-slides=slide]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-slide-id")))
  const position = (p: Page) =>
    p.locator("[data-slides=position]").textContent()
  /** Opens a lesson's slides and waits for the first slide. */
  async function present(s: Stack, path: string, page?: Page) {
    const p = await open(s, path, "Orbits", page)
    await slides(p).waitFor()
    return p
  }

  test(
    "records nothing: no write request is sent, every request is a slides-view read without ?aid=, and the record holds no encounter",
    async () => {
      // A School of its own, so its record's latest activity can only come from this test.
      const state = join(root, "slides-state")
      mkdirSync(state, { recursive: true })
      let s = await stack(state)
      try {
        const p = await newPage(s)
        const writes: string[] = []
        const lessonReads: string[] = []
        p.on("request", (r) => {
          if (r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`)
          if (r.url().includes("/api/courses/slides-none/lessons/"))
            lessonReads.push(r.url())
        })
        await present(s, slidesPath("slides-none"), p)
        // Every slide, with its quiz and explain block shown to read only: nothing to choose or write.
        expect(await shown(p)).toEqual(["orbits-where"])
        const q = quiz(p, "closest")
        expect(await q.getAttribute("data-read-only")).toBe("true")
        expect(
          await q.locator("[data-quiz=choice]:not([disabled])").count()
        ).toBe(0)
        await q.locator("[data-choice=mercury]").click({ force: true })
        await p.keyboard.press("l")
        expect(await shown(p)).toEqual(["orbits-seasons"])
        const e = explain(p, "seasons")
        expect(await e.getAttribute("data-read-only")).toBe("true")
        expect(await e.locator("textarea, button").count()).toBe(0)
        expect(
          await p
            .locator(
              "[data-explain=model], [data-explain=sources], [data-quiz=why]"
            )
            .count()
        ).toBe(0)
        // Long enough for a write sent on a timer, or by the outbox on a later pass, to be seen.
        await p.waitForTimeout(1_000)
        expect(writes).toEqual([])
        expect(lessonReads.length).toBeGreaterThan(0)
        expect(
          lessonReads.map((u) => [
            new URL(u).searchParams.get("view"),
            new URL(u).searchParams.getAll("aid"),
          ])
        ).toEqual(lessonReads.map(() => ["slides", []]))
        await p.context().close()

        // Through the API: where the learner left off is still nothing at all.
        expect(
          (
            (await (await fetch(`${s.school.url}/api/resume`)).json()) as {
              lastStudied: string | null
            }
          ).lastStudied
        ).toBeNull()
        // And in the record itself, read with School stopped: no encounter opened, nothing stored, no view.
        await stop(s)
        const db = await openDatabase({
          driver: "pglite",
          dir: join(state, "record"),
        })
        try {
          expect(await postgresRecord(db.sql).lastStudied()).toBeNull()
        } finally {
          await db.close()
        }
        // The oracle can see an encounter: the web view of the same lesson opens one.
        s = await stack(state)
        await open(s, lessonPath("slides-none")).then((w) =>
          w.context().close()
        )
        expect(
          (
            (await (await fetch(`${s.school.url}/api/resume`)).json()) as {
              lastStudied: string | null
            }
          ).lastStudied
        ).not.toBeNull()
      } finally {
        await stop(s)
      }
    },
    timeout(2) + 20_000
  )

  test.each([
    ["→ and ←", "ArrowRight", "ArrowLeft"],
    ["l and h", "l", "h"],
    ["↓ and ↑", "ArrowDown", "ArrowUp"],
    ["j and k", "j", "k"],
    ["PageDown and PageUp", "PageDown", "PageUp"],
  ])(
    "%s move between slides, saying where they are in words, and Home and End go to the ends",
    async (_, on, back) => {
      const p = await present(main, slidesPath("slides-keys"))
      expect(await position(p)).toBe("Slide 1 of 2")
      await p.keyboard.press(on)
      expect(await shown(p)).toEqual(["orbits-seasons"])
      expect(await position(p)).toBe("Slide 2 of 2")
      await p.keyboard.press(on) // nothing after the last
      expect(await shown(p)).toEqual(["orbits-seasons"])
      await p.keyboard.press(back)
      expect(await shown(p)).toEqual(["orbits-where"])
      expect(await position(p)).toBe("Slide 1 of 2")
      await p.keyboard.press("End")
      expect(await shown(p)).toEqual(["orbits-seasons"])
      await p.keyboard.press("Home")
      expect(await shown(p)).toEqual(["orbits-where"])
      // The keys' hints are on screen, and the page never scrolled away from the slides.
      for (const hint of ["←", "→", "h", "l", "Home", "End", "Esc"])
        expect(
          await p
            .locator("[data-slides=keys] [data-slot=kbd]", { hasText: hint })
            .count()
        ).toBeGreaterThan(0)
      await p.context().close()
    }
  )

  /** Moves on one slide and reads the new slide's opacity in the first frame after the key. */
  const firstFrame = (p: Page) =>
    p.evaluate(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      )
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r))
      )
      const slide = document.querySelector("[data-slides=slide]")!
      return {
        id: slide.getAttribute("data-slide-id"),
        opacity: Number(getComputedStyle(slide).opacity),
      }
    })

  test("a slide comes in with a GSAP timeline, and with reduced motion it is simply there", async () => {
    const moving = await present(main, slidesPath("slides-motion"))
    const animated = await firstFrame(moving)
    expect(animated.id).toBe("orbits-seasons")
    expect(animated.opacity).toBeLessThan(1)
    await moving.context().close()

    const still = await present(
      main,
      slidesPath("slides-motion"),
      await newPage(main, undefined, { reducedMotion: "reduce" })
    )
    expect(
      await still.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches
      )
    ).toBe(true)
    const plain = await firstFrame(still)
    expect(plain.id).toBe("orbits-seasons")
    expect(plain.opacity).toBe(1)
    expect(
      await still
        .locator("[data-slides=slide]")
        .evaluate((el) => getComputedStyle(el).transform)
    ).toBe("none")
    await still.context().close()
  })

  test("the web view's Slides link goes to the slides, and Esc or Web view comes back, on the client", async () => {
    const p = await open(main, lessonPath("slides-trip"))
    await p.evaluate(
      () => ((window as unknown as { marker: number }).marker = 1)
    )
    const toSlides = p.locator("[data-lesson=actions] a", { hasText: "Slides" })
    expect(await toSlides.locator("[data-slot=kbd]").textContent()).toBe("P")
    await toSlides.click()
    await slides(p).waitFor()
    expect(new URL(p.url()).search).toBe("?view=slides")
    expect(await position(p)).toBe("Slide 1 of 2")

    await p.keyboard.press("Escape")
    await p.locator("[data-lesson=root]").waitFor()
    expect(new URL(p.url()).search).toBe("")
    expect(await slides(p).count()).toBe(0)

    await p.keyboard.press("p")
    await slides(p).waitFor()
    expect(new URL(p.url()).search).toBe("?view=slides")
    await p.locator("[data-slides=exit]").click()
    await p.locator("[data-lesson=root]").waitFor()
    expect(new URL(p.url()).pathname + new URL(p.url()).search).toBe(
      lessonPath("slides-trip")
    )
    expect(
      await p.evaluate(() => (window as unknown as { marker?: number }).marker)
    ).toBe(1)
    await p.context().close()
  })
})
