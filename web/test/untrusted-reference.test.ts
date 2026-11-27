// An untrusted course's reference documents in Chrome (flyingrobots/school#271). School serves them
// with a policy that runs no script and loads nothing from another site, so a page cannot tell
// another site when the learner opens it, while it still renders: its text, its own stylesheet,
// inline styles, and images from its own folder or data: URLs. The example course the school skill
// ships is served untrusted, as written. A trusted course's copy of the same page is served
// without the policy, and its cross-site image does load: the positive control showing that the
// untrusted page's zero requests mean the policy blocked them, not that the beacon never worked.
// Oracle: the issue's acceptance items, and CSP Level 3's fetch directives as Chrome enforces them.
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

setDefaultTimeout(30_000)

/** The example course the school skill ships, served as an untrusted course. */
const EXAMPLE = join(
  import.meta.dir,
  "..",
  "..",
  ".agents",
  "skills",
  "school",
  "example"
)
/** Another site's name, which Chrome is told resolves to the beacon below. */
const TRACKER = "tracker.example"
const DOT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="rgb(9, 9, 9)"/></svg>'

let school: Started
let beacon: ReturnType<typeof Bun.serve>
let browser: Browser
let root = ""
/** Every path another site was asked for, in order. */
const hits: string[] = []

/** A reference page that uses everything a realistic one might, including another site's files. */
function richPage(port: number): string {
  const remote = `http://${TRACKER}:${port}`
  return `<!doctype html><title>Rich</title>
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="${remote}/beacon.css">
<style>h1 { letter-spacing: 3px }</style>
<h1 style="text-transform: uppercase">Orbits</h1>
<p id="own-style">Styled by the course's own stylesheet.</p>
<img id="own" src="dot.svg" alt="">
<img id="inline" src="data:image/svg+xml,${encodeURIComponent(DOT)}" alt="">
<img id="remote" src="${remote}/beacon.svg" alt="">
<p>The end.</p>`
}

function course(name: string, port: number): string {
  const dir = join(root, name)
  mkdirSync(join(dir, "lessons"), { recursive: true })
  mkdirSync(join(dir, "reference"), { recursive: true })
  writeFileSync(
    join(dir, "lessons", "0001.json"),
    JSON.stringify({
      type: "page",
      id: `${name}-1`,
      title: "One",
      subtitle: "",
      children: [],
    })
  )
  writeFileSync(join(dir, "reference", "rich.html"), richPage(port))
  writeFileSync(
    join(dir, "reference", "style.css"),
    "#own-style { color: rgb(1, 2, 3) }"
  )
  writeFileSync(join(dir, "reference", "dot.svg"), DOT)
  return dir
}

beforeAll(
  async () => {
    root = mkdtempSync(join(tmpdir(), "school-untrusted-reference-"))
    beacon = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        hits.push(path)
        return path.endsWith(".css")
          ? new Response("body { color: rgb(200, 0, 0) }", {
              headers: { "content-type": "text/css" },
            })
          : new Response(DOT, { headers: { "content-type": "image/svg+xml" } })
      },
    })
    const port = beacon.port
    school = await startSchool({
      ...process.env,
      SCHOOL_COURSES: `own=${course("own", port)}`,
      SCHOOL_UNTRUSTED_COURSES: `guest=${course("guest", port)},example=${EXAMPLE}`,
      SCHOOL_STATE: join(root, "state"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
      SCHOOL_WEB: join(root, "no-web"),
      HOST: "127.0.0.1",
    })
    browser = await chromium.launch({
      channel: "chrome",
      args: [`--host-resolver-rules=MAP ${TRACKER} 127.0.0.1`],
    })
  },
  timeout(1) + 20_000
)

afterAll(async () => {
  await browser?.close()
  await beacon?.stop(true)
  school?.proc.kill()
  await school?.proc.exited
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Opens a reference document straight from School, as the reference page's link does. */
async function open(course: string, file: string): Promise<Page> {
  const p = await (await browser.newContext()).newPage()
  p.setDefaultTimeout(5_000)
  await p.goto(`${school.url}/courses/${course}/reference/${file}`, {
    waitUntil: "load",
  })
  return p
}

/** What the rich page drew, read after its load event. */
async function drawn(p: Page) {
  return p.evaluate(() => {
    const img = (id: string) => {
      const el = document.getElementById(id)
      return el instanceof HTMLImageElement && el.complete
        ? el.naturalWidth
        : -1
    }
    const style = (sel: string, prop: string) => {
      const el = document.querySelector(sel)
      return el === null ? null : getComputedStyle(el).getPropertyValue(prop)
    }
    return {
      heading: document.querySelector("h1")?.innerText ?? null,
      ownSheet: style("#own-style", "color"),
      inlineStyle: style("h1", "letter-spacing"),
      ownImage: img("own"),
      dataImage: img("inline"),
      remoteImage: img("remote"),
      bodyColor: style("body", "color"),
    }
  })
}

describe("an untrusted course's reference page in Chrome", () => {
  test("renders its text, own stylesheet, inline styles, own images and data: images", async () => {
    const p = await open("guest", "rich.html")
    const { heading, ownSheet, inlineStyle, ownImage, dataImage } =
      await drawn(p)
    expect({ heading, ownSheet, inlineStyle, ownImage, dataImage }).toEqual({
      heading: "ORBITS",
      ownSheet: "rgb(1, 2, 3)",
      inlineStyle: "3px",
      ownImage: 8,
      dataImage: 8,
    })
    await p.context().close()
  })

  test("loads nothing from another site: no image, no stylesheet, no request at all", async () => {
    hits.length = 0
    const p = await open("guest", "rich.html")
    const seen = await drawn(p)
    expect({
      hits,
      remoteImage: seen.remoteImage,
      bodyColor: seen.bodyColor,
    }).toEqual({ hits: [], remoteImage: 0, bodyColor: "rgb(0, 0, 0)" })
    await p.context().close()
  })

  test("the example course's glossary renders as written", async () => {
    const p = await open("example", "glossary.html")
    expect(
      await p.evaluate(() => ({
        heading: document.querySelector("h1")?.textContent ?? null,
        terms: [...document.querySelectorAll("dt")].map((d) => d.textContent),
      }))
    ).toEqual({ heading: "Glossary", terms: ["Bit", "Place value", "Carry"] })
    await p.context().close()
  })
})

describe("a trusted course's reference page in Chrome", () => {
  test("is unchanged: the same page loads another site's image and stylesheet", async () => {
    hits.length = 0
    const p = await open("own", "rich.html")
    const seen = await drawn(p)
    expect({
      hits: [...hits].sort(),
      remoteImage: seen.remoteImage,
      bodyColor: seen.bodyColor,
      ownImage: seen.ownImage,
    }).toEqual({
      hits: ["/beacon.css", "/beacon.svg"],
      remoteImage: 8,
      bodyColor: "rgb(200, 0, 0)",
      ownImage: 8,
    })
    await p.context().close()
  })
})
