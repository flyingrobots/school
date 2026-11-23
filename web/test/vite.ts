// Warming the Vite dev server before a browser test file's first test (flyingrobots/school#121).
// Vite transforms the app's modules on the first request for them, so the first page a file opens
// waits for the whole module graph to be transformed: about twice as long as every later page on a
// quiet machine (4.6 s against 2 s), and past a test's 5 s page timeout on a loaded one, which then
// failed whichever test the shuffle put first. Loading the app once in beforeAll, until its load
// event (every module script fetched), takes that cost outside every test.
import type { Browser } from "playwright-core"

import { close } from "./routes.ts"

/** Loads the app from `base` once and waits for its load event; its /api requests are refused. */
export async function warm(browser: Browser, base: string): Promise<void> {
  const c = await browser.newContext()
  await c.route(/\/api\//, (route) => route.abort("connectionrefused"))
  const p = await c.newPage()
  await p.goto(base + "/", { waitUntil: "load", timeout: 30_000 })
  await close(c)
}
