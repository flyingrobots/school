// No page but School's own can open a lesson encounter, on any origin School is reached by
// (flyingrobots/school#321). Opening a lesson in the web view writes an encounter to the learner's
// record, so it is a JSON POST; the lesson's GET only reads. A reference document of an untrusted
// course is sandboxed and runs no script, but it can still ask School for an image at any address,
// such as the lesson's. Over plain HTTP on a name other than localhost, as the phone reaches School
// by its tailnet name, Chrome sends that image no fetch metadata (Fetch Metadata Request Headers
// are sent to potentially trustworthy origins only), so nothing about the request can tell School
// it came from another page (flyingrobots/school#306). The name here is `school.test`, mapped to
// School's loopback address inside Chrome by `--host-resolver-rules`: the same request Chrome makes
// for a hosts-file entry, with no change to the machine's own hosts file. School's own POST from a
// page on its origin still opens one: the positive control showing that the empty record means the
// request opened nothing, not that this harness cannot open a lesson.
// Oracle: the issue's acceptance items, read in the record, with Chrome sending its own request
// metadata, so no header here is written by the test.
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
/** A name that is not localhost, reached over plain HTTP: not a potentially trustworthy origin. */
const NAME = "school.test"

/** The reviewer's probe: images whose addresses name a lesson, in the web view by name and by default, and the slides view. */
const PROBE = `<!doctype html><title>Probe</title>
<p>Nothing to see here. <a id="leave" href="/api/courses">Courses</a></p>
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
    SCHOOL_ALLOWED_HOSTS: NAME,
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

type Asked = { address: string; method: string; site: string | null }

/** Each lesson address School was asked for through `front`, with the `Sec-Fetch-Site` Chrome sent. */
let asked: Asked[] = []

/**
 * School's front door for Chrome: it notes each lesson request as it arrived, then passes it on
 * unchanged to School wherever it is listening now (it moves when the record is read). Playwright
 * does not report every header Chrome sends, so the requests are read here.
 */
const front = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname.startsWith(LESSON_API))
      asked.push({
        address: u.pathname + u.search,
        method: req.method,
        site: req.headers.get("sec-fetch-site"),
      })
    return fetch(school!.url + u.pathname + u.search, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" ? null : await req.arrayBuffer(),
      redirect: "manual",
    })
  },
})

/** The origins School is reached by: loopback, which is trustworthy, and a plain-HTTP name, which is not. */
const ORIGINS = {
  loopback: () => `http://127.0.0.1:${front.port}`,
  [NAME]: () => `http://${NAME}:${front.port}`,
} as const
type Origin = keyof typeof ORIGINS

beforeAll(
  async () => {
    root = mkdtempSync(join(tmpdir(), "school-lesson-open-"))
    record = join(root, "record")
    mkdirSync(join(root, "guest", "lessons"), { recursive: true })
    mkdirSync(join(root, "guest", "reference"), { recursive: true })
    const ids = ["probed", "own", "read"]
    ids.forEach((id, i) =>
      writeFileSync(
        join(root, "guest", "lessons", `000${i + 1}.json`),
        lesson(id)
      )
    )
    writeFileSync(join(root, "guest", "reference", "probe.html"), PROBE)
    await start()
    browser = await chromium.launch({
      channel: "chrome",
      // The hosts-file entry, inside Chrome only. A missing Chrome fails here, loudly; it is never a skip.
      args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1`],
    })
  },
  timeout(1) + 20_000
)

afterAll(async () => {
  front.stop(true)
  await browser?.close()
  await stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Opens `path` on `origin` in a fresh context, with no lesson request noted yet. */
async function open(origin: Origin, path: string): Promise<Page> {
  const p = await (await browser.newContext()).newPage()
  p.setDefaultTimeout(5_000)
  asked = []
  await p.goto(ORIGINS[origin]() + path, { waitUntil: "load" })
  return p
}

/** What Chrome tells School of a sandboxed page's request: cross-site on loopback, nothing on the plain-HTTP name. */
const SITE: Record<Origin, string | null> = {
  loopback: "cross-site",
  [NAME]: null,
}

describe.each(Object.keys(ORIGINS) as Origin[])(
  "an untrusted course's reference page in Chrome, over %s",
  (origin) => {
    test("whose images address a lesson leaves no new encounter in the record", async () => {
      // Chrome's opaque response blocking hides each reply from the page (a JSON body is not an
      // image), so the record, not the reply, says whether a request opened an encounter.
      const p = await open(origin, "/courses/guest/reference/probe.html")
      // The page is the sandboxed one the issue is about, and Chrome did ask School for each image,
      // with the metadata (or none) the origin gets.
      expect(await p.evaluate(() => window.origin)).toBe("null")
      const site = SITE[origin]
      expect(asked.sort((a, b) => a.address.localeCompare(b.address))).toEqual([
        { address: `${LESSON_API}/probed`, method: "GET", site },
        { address: `${LESSON_API}/probed?view=slides`, method: "GET", site },
        { address: `${LESSON_API}/probed?view=web&aid=1`, method: "GET", site },
      ])
      await p.context().close()
      expect(await encounters("probed")).toBe(0)
    })

    // The architecture doc's trust section says a followed link opens School's page outside the
    // sandbox, where it acts as School: the sandbox belongs to the document, not the tab.
    test("a link the learner follows from it opens School's page on School's own origin", async () => {
      const p = await open(origin, "/courses/guest/reference/probe.html")
      const own = ORIGINS[origin]()
      await Promise.all([p.waitForURL(`${own}/api/courses`), p.click("#leave")])
      expect(await p.evaluate(() => window.origin)).toBe(own)
      await p.context().close()
    })
  }
)

describe(`School's own page in Chrome, over ${NAME}`, () => {
  test("opens the encounter with the POST the web app's lesson page makes", async () => {
    const p = await open(NAME, "/api/courses")
    // The same request web/src/lib/school-api.ts openLesson makes, from a page on School's origin.
    const reply = await p.evaluate(async (url) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: "{}",
      })
      const body = (res.ok ? await res.json() : {}) as { encounterId?: unknown }
      return { status: res.status, encounter: typeof body.encounterId }
    }, `${LESSON_API}/own?aid=1`)
    expect(reply).toEqual({ status: 200, encounter: "string" })
    await p.context().close()
    expect(await encounters("own")).toBe(1)
  })

  test("reads the lesson with a GET, which opens none", async () => {
    const p = await open(NAME, "/api/courses")
    const reply = await p.evaluate(async (url) => {
      const res = await fetch(url, { headers: { accept: "application/json" } })
      const body = (await res.json()) as {
        view?: unknown
        encounterId?: unknown
      }
      return {
        status: res.status,
        view: body.view,
        encounter: "encounterId" in body,
      }
    }, `${LESSON_API}/read?view=web&aid=1`)
    expect(reply).toEqual({ status: 200, view: "web", encounter: false })
    await p.context().close()
    expect(await encounters("read")).toBe(0)
  })
})
