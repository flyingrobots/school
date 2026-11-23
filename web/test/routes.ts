// Closing a browser test's context only once its route handlers have finished
// (flyingrobots/school#121). The browser tests answer a page's /api requests with route handlers
// that fetch from School and fulfil with the reply. A context closed while one of them is still
// running disposes the fetch under it, and the handler throws "Request context disposed" (or, if
// the fetch had finished, "Fetch response has been disposed" from the fulfil) into the test run.
// On a quiet machine the page's last requests (the sidebar's course list, the lesson a link has
// just opened) are answered before the test's last step; on a loaded one they are not.
import type { BrowserContext } from "playwright-core"

/**
 * Closes `c` once every route handler it and its pages are running has finished. Requests made
 * after that are no longer routed; nothing waits for their replies.
 */
export async function close(c: BrowserContext): Promise<void> {
  for (const p of c.pages()) await p.unrouteAll({ behavior: "wait" })
  await c.unrouteAll({ behavior: "wait" })
  await c.close()
}
