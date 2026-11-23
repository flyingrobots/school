// The browser tests' context close (test/routes.ts, flyingrobots/school#121). Their pages' /api
// requests are answered by route handlers that fetch from School and fulfil with the reply; a
// context closed while one of them is still running disposes the fetch under it, and the handler
// throws "Request context disposed" (or "Fetch response has been disposed") into the test run.
// Oracle: a handler still running when the test closes its context finishes, and fulfils the
// request with School's reply.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"

import { close } from "./routes.ts"

let browser: Browser
let school: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  school = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ from: "school" }) })
  browser = await chromium.launch({ channel: "chrome" })
})

afterAll(async () => {
  await browser?.close()
  school?.stop(true)
})

test("a route handler still fetching when the context is closed finishes, and fulfils the request", async () => {
  const c = await browser.newContext()
  let running!: () => void
  const handling = new Promise<void>((r) => (running = r))
  // The handler is held mid-flight until the close has begun: until the context closes, or until
  // close() starts waiting for the context's handlers, whichever close() does first.
  let begin!: () => void
  const closing = new Promise<void>((r) => (begin = r))
  c.once("close", () => begin())
  const unrouteAll = c.unrouteAll.bind(c)
  c.unrouteAll = (options) => (begin(), unrouteAll(options))
  let outcome = "not handled"
  let settled!: () => void
  const handled = new Promise<void>((r) => (settled = r))
  await c.route(/\/api\//, async (route) => {
    running()
    await closing
    try {
      const response = await route.fetch({ url: school.url.origin + "/api/thing" })
      await route.fulfill({ response })
      outcome = `fulfilled with ${await response.text()}`
    } catch (e) {
      outcome = (e as Error).message.split("\n")[0]!
    } finally {
      settled()
    }
  })
  const p = await c.newPage()
  await p.route("http://page.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<script>fetch('/api/thing')</script>" }))
  await p.goto("http://page.test/")
  await handling
  await close(c)
  // The handler runs on after a close that did not wait for it; its outcome is read once it ends.
  await handled
  expect(outcome).toBe('fulfilled with {"from":"school"}')
})
