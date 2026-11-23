// Holding a page's GSAP intro still, for the browser tests that press keys during it
// (flyingrobots/school#114). GSAP's autoAlpha sets visibility: hidden on an element not yet faded
// in, and a hidden element cannot take focus, so j pressed during the intro skipped it. Pausing the
// page's clock before it loads holds the intro at its start for as long as the keys take, on any
// machine, instead of racing it.
import type { BrowserContext, Page } from "playwright-core"

/** Opens `url` with the page's clock paused; `ready` waits for what the intro brings in. */
export async function heldIntro(c: BrowserContext, url: string, ready: (p: Page) => Promise<unknown>): Promise<Page> {
  const p = await c.newPage()
  p.setDefaultTimeout(8_000)
  await p.clock.install()
  await p.clock.pauseAt(Date.now() + 1_000)
  await p.goto(url)
  await ready(p)
  // One frame: GSAP renders a timeline's first frame on its next tick, not when it is built.
  await p.clock.runFor(20)
  return p
}

/** The main region's focus stops, in order, each named by its link, or else its label, id or text. */
export const stops = (p: Page) =>
  p.locator("[data-nav-region=main] [data-nav]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("href") ?? e.getAttribute("aria-label") ?? (e.id || e.textContent?.trim()) ?? "")
  )

/** Presses j `n` times, returning the focus stop reached after each press, named as `stops` names it. */
export async function pressJ(p: Page, n: number): Promise<string[]> {
  const reached: string[] = []
  for (let i = 0; i < n; i++) {
    await p.keyboard.press("j")
    reached.push(
      await p.evaluate(() => {
        const e = document.activeElement
        if (!e?.matches("[data-nav-region=main] [data-nav]")) return `not a focus stop in the main region: ${e?.tagName}`
        return e.getAttribute("href") ?? e.getAttribute("aria-label") ?? (e.id || e.textContent?.trim()) ?? ""
      })
    )
  }
  return reached
}

/** The computed opacity of each element `selector` matches. */
export const opacities = (p: Page, selector: string) =>
  p.locator(selector).evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity))
