// The settings page (flyingrobots/school#44), driven in Chrome against the Vite dev server, with
// every /api request forwarded to a real School server and a real bridge, each started by the port
// helper (server/testing/processes.ts). The only fake is the agent CLI.
// Oracles: the issue's acceptance items (the token is never shown after saving; environment-locked
// fields say why; testing an agent shows its attempts), the API's own contract as
// server/settings.test.ts pins it, and the bridge's file on the host, read back from disk.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import {
  startBridge,
  startSchool,
  timeout,
  type Started,
} from "../../server/testing/processes.ts"
import { heldIntro, opacities, pressJ, stops } from "./intro.ts"
import { close } from "./routes.ts"
import { warm } from "./vite.ts"

setDefaultTimeout(timeout(2) + 15_000)

const web = join(import.meta.dir, "..")
const TOKEN = "settings-page-token-NEVER-SHOWN"

let vite: ViteDevServer
let browser: Browser
let base: string

beforeAll(async () => {
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
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
})

const procs: Started[] = []
const roots: string[] = []
afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.proc.kill()
    await p.proc.exited
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

type World = {
  root: string
  school: string
  bridge: string
  bridgeFile: string
  declare: () => void
}

/** A bridge with TOKEN and no file yet, and a School with nothing configured unless `env` says so. */
async function world(
  env: (bridge: string) => Record<string, string> = () => ({})
): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "school-settings-page-"))
  roots.push(root)
  const verdict = { insufficient_evidence: false, summary: "Good." }
  writeFileSync(join(root, "verdict.json"), JSON.stringify(verdict))
  writeFileSync(join(root, "agent"), `#!/bin/sh\ncat "${root}/verdict.json"\n`)
  chmodSync(join(root, "agent"), 0o755)
  mkdirSync(join(root, "course", "lessons"), { recursive: true })
  const bridgeFile = join(root, "bridge", "bridge.json")
  const bridge = await startBridge({
    ...process.env,
    SCHOOL_BRIDGE_TOKEN: TOKEN,
    SCHOOL_BRIDGE_CONFIG: bridgeFile,
  })
  procs.push(bridge)
  const schoolEnv: Record<string, string | undefined> = {
    ...process.env,
    SCHOOL_COURSES: `c=${join(root, "course")}`,
    SCHOOL_STATE: join(root, "state"),
    SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
    HOST: "127.0.0.1",
  }
  delete schoolEnv.SCHOOL_BRIDGE_URL
  delete schoolEnv.SCHOOL_BRIDGE_TOKEN
  const school = await startSchool({ ...schoolEnv, ...env(bridge.url) })
  procs.push(school)
  const declare = () => {
    mkdirSync(join(root, "bridge"), { recursive: true })
    writeFileSync(
      bridgeFile,
      JSON.stringify({
        timeout_seconds: 10,
        agents: [
          {
            name: "missing",
            command: "no-such-agent-cli {prompt}",
            output: "text",
          },
          {
            name: "fake",
            command: `${join(root, "agent")} -p {prompt}`,
            output: "text",
          },
        ],
      })
    )
  }
  return { root, school: school.url, bridge: bridge.url, bridgeFile, declare }
}

/** The settings page, with its /api requests answered by `w`'s School. */
/** The settings page, with its /api requests answered by `w`'s School, except any path in `replace`. */
async function open(
  w: World,
  hold?: Promise<void>,
  replace: Record<string, unknown> = {}
): Promise<Page> {
  const p = await (await browser.newContext()).newPage()
  p.setDefaultTimeout(8_000)
  await p.route("**/api/**", async (route) => {
    const u = new URL(route.request().url())
    if (hold && u.pathname === "/api/settings/status") await hold
    if (u.pathname in replace)
      return route.fulfill({ json: replace[u.pathname] })
    const response = await route.fetch({
      url: w.school + u.pathname + u.search,
    })
    await route.fulfill({ response })
  })
  await p.goto(base + "/settings")
  await p.getByRole("heading", { level: 1, name: "Settings" }).waitFor()
  return p
}

const address = (p: Page) => p.getByLabel("Bridge address")
const token = (p: Page) => p.getByLabel("Token", { exact: true })
const status = (p: Page) => p.locator("[data-settings=status]")

async function connect(p: Page, url: string, t = TOKEN) {
  await address(p).fill(url)
  await token(p).fill(t)
  await p.getByRole("button", { name: "Save", exact: true }).click()
}

const order = (w: World) =>
  (
    JSON.parse(readFileSync(w.bridgeFile, "utf8")).agents as {
      name: string
      enabled?: boolean
    }[]
  ).map((a) => [a.name, a.enabled ?? true])

async function until(check: () => boolean, what: string, ms = 5_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("connecting the bridge", () => {
  test("with nothing configured, the page says no bridge is connected", async () => {
    const w = await world()
    const p = await open(w)
    await status(p)
      .getByText(/No bridge is connected/)
      .waitFor()
    expect(await address(p).inputValue()).toBe("")
    expect(await address(p).isEditable()).toBe(true)
    expect(await p.getByRole("list", { name: "Agents" }).count()).toBe(0)
    await close(p.context())
  })

  test("the browser title is Settings · School", async () => {
    const w = await world()
    const p = await open(w)
    expect(await p.title()).toBe("Settings · School")
    await p.context().close()
  })

  test("while the status loads, the page shows skeletons", async () => {
    const w = await world()
    let release!: () => void
    const p = await open(w, new Promise<void>((r) => (release = r)))
    await status(p).locator("[data-slot=skeleton]").first().waitFor()
    release()
    await status(p)
      .getByText(/No bridge is connected/)
      .waitFor()
    expect(await status(p).locator("[data-slot=skeleton]").count()).toBe(0)
    await close(p.context())
  })

  test("saving connects the bridge; the token field is cleared and the token never appears in the page", async () => {
    const w = await world()
    const p = await open(w)
    await connect(p, w.bridge)
    await status(p)
      .getByText(/has no agents yet/)
      .waitFor()
    expect(await status(p).textContent()).toContain(w.bridgeFile)
    expect(await token(p).inputValue()).toBe("")
    expect(await token(p).getAttribute("placeholder")).toMatch(/saved/i)
    expect(await p.content()).not.toContain(TOKEN)
    await p.reload()
    await status(p)
      .getByText(/has no agents yet/)
      .waitFor()
    expect(await address(p).inputValue()).toBe(w.bridge)
    expect(await p.content()).not.toContain(TOKEN)
    await close(p.context())
  })

  test("a wrong token says the bridge refused it", async () => {
    const w = await world()
    const p = await open(w)
    await connect(p, w.bridge, "a-wrong-token-long-enough")
    await status(p)
      .getByText(/refused the token/)
      .waitFor()
    await close(p.context())
  })

  test("an unreachable bridge says School could not reach it", async () => {
    const w = await world()
    const p = await open(w)
    await connect(p, "http://127.0.0.1:9")
    await status(p)
      .getByText(/could not reach/i)
      .waitFor()
    await close(p.context())
  })

  // Each reply is parsed with Zod (web/src/lib/settings-api.ts): a reply of the wrong shape is the
  // page's error state, never a status or an agent list.
  test.each([
    ["/api/settings/status", { connection: "sideways", agents: [] }],
    [
      "/api/settings/status",
      {
        connection: "ok",
        agents: [{ name: "fake", enabled: "yes", found: true }],
      },
    ],
    [
      "/api/settings/bridge",
      { url: 7, urlFrom: "settings", tokenSet: true, tokenFrom: "settings" },
    ],
  ])(
    "a malformed reply from %s is shown as an error, not as a state",
    async (path, body) => {
      const w = await world()
      const p = await open(w, undefined, { [path]: body })
      const error = p.locator("[data-settings=error]")
      await error.getByText(/not what the page expects/).waitFor()
      expect(await error.textContent()).toContain(path)
      if (path === "/api/settings/status") {
        expect(await status(p).textContent()).not.toMatch(
          /Connected|No bridge is connected/
        )
        expect(await p.getByRole("list", { name: "Agents" }).count()).toBe(0)
      } else {
        expect(await address(p).count()).toBe(0) // no form built from a reply it could not read
      }
      await close(p.context())
    }
  )

  test("a refused setting shows why", async () => {
    const w = await world()
    const p = await open(w)
    await connect(p, w.bridge, "short")
    await p.getByText(/at least 16 characters/).waitFor()
    await close(p.context())
  })

  test("a generated token is shown once, to start the bridge with, and never again", async () => {
    const w = await world()
    const p = await open(w)
    await address(p).fill(w.bridge)
    await p.getByRole("button", { name: "Save", exact: true }).click()
    await status(p)
      .getByText(/No bridge is connected/)
      .waitFor()
    await p.getByRole("button", { name: "Generate a token" }).click()
    const shown = p.locator("[data-settings=generated]")
    await shown.waitFor()
    const generated = await shown.getByLabel("New token").inputValue()
    expect(generated.length).toBeGreaterThanOrEqual(32)
    expect(
      JSON.parse(readFileSync(join(w.root, "state", "settings.json"), "utf8"))
        .bridge.token
    ).toBe(generated)
    await shown.getByRole("button", { name: /stored it/ }).click()
    await shown.waitFor({ state: "detached" })
    expect(await p.content()).not.toContain(generated)
    await p.reload()
    await p.getByRole("heading", { level: 1, name: "Settings" }).waitFor()
    await status(p)
      .getByText(/refused the token/)
      .waitFor()
    expect(await p.content()).not.toContain(generated)
    await close(p.context())
  })

  test("saving a new address says the token must be entered again", async () => {
    const w = await world()
    const p = await open(w)
    await connect(p, w.bridge)
    await status(p)
      .getByText(/has no agents yet/)
      .waitFor()
    await address(p).fill("http://127.0.0.1:9")
    await p.getByRole("button", { name: "Save", exact: true }).click()
    await p
      .locator("[data-settings=token-cleared]")
      .getByText(/enter the token again/i)
      .waitFor()
    expect(await token(p).getAttribute("placeholder")).not.toMatch(/saved/i)
    await status(p)
      .getByText(/No bridge is connected/)
      .waitFor()
    await close(p.context())
  })

  test("fields set in the environment are locked and say why", async () => {
    const w = await world((bridge) => ({
      SCHOOL_BRIDGE_URL: bridge,
      SCHOOL_BRIDGE_TOKEN: TOKEN,
    }))
    const p = await open(w)
    await status(p)
      .getByText(/has no agents yet/)
      .waitFor()
    expect(await address(p).isDisabled()).toBe(true)
    expect(await token(p).isDisabled()).toBe(true)
    expect(await address(p).inputValue()).toBe(w.bridge)
    expect(
      await p.getByRole("button", { name: "Generate a token" }).isDisabled()
    ).toBe(true)
    const said = await p.locator("[data-settings=bridge]").textContent()
    expect(said).toContain("SCHOOL_BRIDGE_URL")
    expect(said).toContain("SCHOOL_BRIDGE_TOKEN")
    expect(said).toMatch(/environment/)
    expect(await p.content()).not.toContain(TOKEN)
    await close(p.context())
  })
})

describe("the bridge's agents", () => {
  async function connected() {
    const w = await world()
    w.declare()
    const p = await open(w)
    await connect(p, w.bridge)
    await p.getByRole("list", { name: "Agents" }).waitFor()
    return { w, p }
  }
  const agent = (p: Page, name: string) =>
    p
      .getByRole("list", { name: "Agents" })
      .getByRole("listitem")
      .filter({ hasText: name })

  test("each agent shows whether its program was found, and the page says commands are edited on the host", async () => {
    const { w, p } = await connected()
    expect(
      await p
        .getByRole("list", { name: "Agents" })
        .getByRole("listitem")
        .allTextContents()
    ).toEqual([
      expect.stringContaining("missing"),
      expect.stringContaining("fake"),
    ])
    expect(await agent(p, "missing").textContent()).toMatch(/not found/i)
    expect(await agent(p, "fake").textContent()).toMatch(/found/i)
    expect(await agent(p, "fake").textContent()).not.toMatch(/not found/i)
    const note = (await p.locator("[data-settings=commands]").textContent())!
    expect(note).toContain(w.bridgeFile)
    expect(note).toMatch(/commands/i)
    expect(await p.getByRole("textbox", { name: /command/i }).count()).toBe(0)
    await close(p.context())
  })

  test("the keyboard reorders the agents, with its keys shown, and the bridge's file keeps the order", async () => {
    const { w, p } = await connected()
    const hints = await p
      .locator("[data-slot=sortable-list-keys] [data-slot=kbd]")
      .allTextContents()
    for (const k of ["↵", "↑", "↓", "j", "k", "Esc"]) expect(hints).toContain(k)
    await p.getByRole("button", { name: "Move fake" }).focus()
    await p.keyboard.press("Enter")
    await p.keyboard.press("ArrowUp")
    await p.keyboard.press("Enter")
    await until(() => order(w)[0]![0] === "fake", "fake to move first")
    expect(order(w)).toEqual([
      ["fake", true],
      ["missing", true],
    ])
    expect(
      await p.evaluate(() => document.activeElement?.getAttribute("aria-label"))
    ).toBe("Move fake")
    await p.keyboard.press("Enter")
    await p.keyboard.press("j")
    await p.keyboard.press("Enter")
    await until(() => order(w)[0]![0] === "missing", "fake to move back with j")
    expect(
      await p
        .getByRole("list", { name: "Agents" })
        .getByRole("listitem")
        .allTextContents()
    ).toEqual([
      expect.stringContaining("missing"),
      expect.stringContaining("fake"),
    ])
    await close(p.context())
  })

  test("Esc puts a picked-up agent back", async () => {
    const { w, p } = await connected()
    await p.getByRole("button", { name: "Move fake" }).focus()
    await p.keyboard.press("Enter")
    await p.keyboard.press("ArrowUp")
    await p.keyboard.press("Escape")
    await Bun.sleep(300)
    expect(order(w)[0]![0]).toBe("missing")
    await close(p.context())
  })

  test("switching an agent off saves it in the bridge's file", async () => {
    const { w, p } = await connected()
    const use = p.getByRole("switch", { name: "Use missing" })
    expect(await use.getAttribute("aria-checked")).toBe("true")
    await use.click()
    await until(() => order(w)[0]![1] === false, "missing to be switched off")
    expect(await use.getAttribute("aria-checked")).toBe("false")
    await close(p.context())
  })

  test("testing an agent is labelled as AI and shows its attempts", async () => {
    const { p } = await connected()
    const button = p.getByRole("button", { name: "Test fake" })
    expect(await button.locator("svg.lucide-bot").count()).toBe(1)
    await button.click()
    const result = p.locator("[data-settings=test-result]")
    await result
      .getByText(/failed/i)
      .first()
      .waitFor({ timeout: 15_000 })
    expect(await result.locator("svg.lucide-bot").count()).toBeGreaterThan(0)
    const attempts = result
      .getByRole("list", { name: "Attempts" })
      .getByRole("listitem")
    expect(await attempts.count()).toBe(1)
    expect(await attempts.first().textContent()).toContain("fake")
    expect(await attempts.first().textContent()).toMatch(/schema/)
    await close(p.context())
  })
})

// flyingrobots/school#114: the intro must not swallow keys. The page's clock is paused before it
// loads (test/intro.ts), so the cards are held before they start to fade in.
describe("time zone", () => {
  test("automatic shows the browser's zone; a chosen zone is kept by School, and automatic restores the browser's", async () => {
    const w = await world()
    const c = await browser.newContext({ timezoneId: "America/Los_Angeles" })
    const p = await c.newPage()
    p.setDefaultTimeout(8_000)
    await p.route("**/api/**", async (route) => {
      const u = new URL(route.request().url())
      await route.fulfill({
        response: await route.fetch({ url: w.school + u.pathname + u.search }),
      })
    })
    await p.goto(base + "/settings")
    const card = p.locator("[data-settings=time-zone]")
    await card
      .getByText("Automatic: America/Los_Angeles, from this browser")
      .waitFor()
    const zone = async () =>
      (await (await fetch(w.school + "/api/settings/time-zone")).json()).zone
    expect(await zone()).toBeNull()
    const input = card.getByRole("combobox", { name: "Time zone" })
    await input.fill("Kiritimati")
    await p.getByRole("option", { name: "Pacific/Kiritimati" }).click()
    await card
      .getByText("Saved: School names days in Pacific/Kiritimati")
      .waitFor()
    expect(await zone()).toBe("Pacific/Kiritimati")
    await p.reload()
    expect(
      await p
        .locator("[data-settings=time-zone]")
        .getByRole("combobox", { name: "Time zone" })
        .inputValue()
    ).toBe("Pacific/Kiritimati")
    const again = p
      .locator("[data-settings=time-zone]")
      .getByRole("combobox", { name: "Time zone" })
    await again.fill("Automatic")
    await p.getByRole("option", { name: "Automatic" }).click()
    await p
      .locator("[data-settings=time-zone]")
      .getByText("Automatic: America/Los_Angeles, from this browser")
      .waitFor()
    expect(await zone()).toBeNull()
    await c.close()
  })
})

describe("the intro", () => {
  test("j pressed during the intro reaches each focus stop in order, and every stop can take focus", async () => {
    const w = await world()
    w.declare()
    const saved = await fetch(`${w.school}/api/settings/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: w.bridge, token: TOKEN }),
    })
    expect(saved.status).toBe(200)
    const c = await browser.newContext()
    await c.route("**/api/**", async (route) => {
      const u = new URL(route.request().url())
      await route.fulfill({
        response: await route.fetch({ url: w.school + u.pathname + u.search }),
      })
    })
    const p = await heldIntro(c, base + "/settings", (p) =>
      p
        .getByRole("button", { name: "Test fake" })
        .waitFor({ state: "attached" })
    )
    expect(await opacities(p, "[data-animate=card]")).toEqual([
      "0",
      "0",
      "0",
      "0",
    ])
    // j moves through the stops up to the first text field, where it is typed instead.
    const all = await stops(p)
    const field = all.indexOf("bridge-address")
    expect(field).toBeGreaterThan(0)
    expect(await pressJ(p, field + 1)).toEqual(all.slice(0, field + 1))
    // Every stop past it, in the cards still to fade in, can take focus too.
    const refused = await p
      .locator("[data-nav-region=main] [data-nav]:not(:disabled)")
      .evaluateAll((els) =>
        (els as HTMLElement[])
          .filter((e) => (e.focus(), document.activeElement !== e))
          .map((e) => e.getAttribute("aria-label") ?? e.id ?? e.textContent)
      )
    expect(refused).toEqual([])
    expect(
      await p
        .locator("[data-nav-region=main] [data-nav]:not(:disabled)")
        .count()
    ).toBeGreaterThan(field + 6)
    expect(await opacities(p, "[data-animate=card]")).toEqual([
      "0",
      "0",
      "0",
      "0",
    ])
    await p.clock.resume()
    await p.waitForFunction(() =>
      [...document.querySelectorAll("[data-animate=card]")].every(
        (e) => getComputedStyle(e).opacity === "1"
      )
    )
    await close(p.context())
  })
})
