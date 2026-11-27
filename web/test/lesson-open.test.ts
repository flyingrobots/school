// An untrusted course page cannot open a lesson encounter (flyingrobots/school#306). Opening a lesson
// in the web view writes an encounter to the learner's record. A reference document of an untrusted
// course is sandboxed and runs no script, but it can still ask School for an image, and School is
// asked for `/api/courses/c/lessons/l?view=web` like any other URL. That request must leave no
// encounter behind, while School's own fetch of the same lesson, from a page on School's origin,
// still opens one: the positive control showing that the empty record means the request was
// refused, not that this harness cannot open a lesson.
// Oracle: the issue's acceptance items, read in the record, with Chrome sending its own request
// metadata (Fetch Metadata Request Headers), so no header here is written by the test.
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

import {
  startSchool,
  timeout,
  type Started,
} from "../../server/testing/processes.ts"
import { ownerQuery } from "../../server/testing/record.ts"

setDefaultTimeout(30_000)

let school: Started | null = null
let browser: Browser
let root = ""
let record = ""

const LESSON_API = "/api/courses/guest/lessons"

/** The reviewer's probe: images whose addresses open a lesson, in the web view by name and by default, and the slides view. */
const PROBE = `<!doctype html><title>Probe</title>
<p>Nothing to see here.</p>
<img id="web" src="${LESSON_API}/probed?view=web&aid=1" alt="">
<img id="default" src="${LESSON_API}/probed" alt="">
<img id="slides" src="${LESSON_API}/probed?view=slides" alt="">`

const lesson = (id: string) =>
  JSON.stringify({
    type: "page",
    id,
    title: id,
    subtitle: "",
    children: [
      {
        type: "quiz",
        id: `${id}-q`,
        q: "Which?",
        why: "Because.",
        choices: [
          { id: "a", text: "A", correct: true },
          { id: "b", text: "B", correct: false },
        ],
      },
    ],
  })

async function start(): Promise<void> {
  school = await startSchool({
    ...process.env,
    SCHOOL_UNTRUSTED_COURSES: `guest=${join(root, "guest")}`,
    SCHOOL_STATE: join(root, "state"),
    SCHOOL_DATABASE_URL: `pglite:${record}`,
    SCHOOL_WEB: join(root, "no-web"),
    HOST: "127.0.0.1",
  })
}
async function stop(): Promise<void> {
  school?.proc.kill()
  await school?.proc.exited
  school = null
}

/** How many encounters the record holds for `id`, read as its owner with School stopped (PGlite is one process's). */
async function encounters(id: string): Promise<number> {
  await stop()
  try {
    const rows = await ownerQuery<{ n: number }>(
      record,
      "SELECT count(*)::int AS n FROM school.encounters WHERE course = 'guest' AND lesson = $1",
      [id]
    )
    return rows[0]!.n
  } finally {
    await start()
  }
}

beforeAll(
  async () => {
    root = mkdtempSync(join(tmpdir(), "school-lesson-open-"))
    record = join(root, "record")
    mkdirSync(join(root, "guest", "lessons"), { recursive: true })
    mkdirSync(join(root, "guest", "reference"), { recursive: true })
    writeFileSync(join(root, "guest", "lessons", "0001.json"), lesson("probed"))
    writeFileSync(join(root, "guest", "lessons", "0002.json"), lesson("own"))
    writeFileSync(join(root, "guest", "reference", "probe.html"), PROBE)
    await start()
    browser = await chromium.launch({ channel: "chrome" })
  },
  timeout(1) + 20_000
)

afterAll(async () => {
  await browser?.close()
  await stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * Opens `path` straight from School in a fresh context, noting every lesson address it asks for.
 * Chrome's opaque response blocking hides each reply from the page (a JSON body is not an image),
 * so the record, not the reply, says whether a request opened an encounter.
 */
async function open(path: string): Promise<{ p: Page; asked: string[] }> {
  const p = await (await browser.newContext()).newPage()
  p.setDefaultTimeout(5_000)
  const asked: string[] = []
  p.on("request", (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith(LESSON_API)) asked.push(u.pathname + u.search)
  })
  await p.goto(school!.url + path, { waitUntil: "load" })
  return { p, asked }
}

describe("an untrusted course's reference page in Chrome", () => {
  test("whose images address a lesson leaves no new encounter in the record", async () => {
    const { p, asked } = await open("/courses/guest/reference/probe.html")
    // The page is the sandboxed one the issue is about, and Chrome did ask School for each image.
    expect(await p.evaluate(() => window.origin)).toBe("null")
    expect(asked.sort()).toEqual([
      `${LESSON_API}/probed`,
      `${LESSON_API}/probed?view=slides`,
      `${LESSON_API}/probed?view=web&aid=1`,
    ])
    await p.context().close()
    expect(await encounters("probed")).toBe(0)
  })
})

describe("School's own fetch of a lesson in Chrome", () => {
  test("still opens the encounter, as the web app's lesson page does", async () => {
    const { p } = await open("/api/courses")
    // The same request web/src/lib/school-api.ts openLesson makes, from a page on School's origin.
    const reply = await p.evaluate(async (url) => {
      const res = await fetch(url, { headers: { accept: "application/json" } })
      const body = (await res.json()) as { encounterId?: unknown }
      return { status: res.status, encounter: typeof body.encounterId }
    }, `${LESSON_API}/own?aid=1`)
    expect(reply).toEqual({ status: 200, encounter: "string" })
    await p.context().close()
    expect(await encounters("own")).toBe(1)
  })
})
