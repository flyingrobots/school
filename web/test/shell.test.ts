// The app shell (flyingrobots/school#35), driven in a real browser: Chrome through playwright-core,
// against the Vite dev server. Oracles are the acceptance items of the issue and RFC 2 §6:
// the palette opens on ⌘K (Ctrl+K off Apple) or Space Space and never on Esc; hjkl and the arrows
// move focus only outside text fields; the theme switch offers light, dark and system and persists
// per viewer; every key that acts shows its Kbd hint.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

import { warm } from "./vite.ts"

setDefaultTimeout(30_000)

const web = join(import.meta.dir, "..")
const apple = process.platform === "darwin" // the browser runs on this host, so it reports the same platform
const mod = apple ? "⌘" : "Ctrl"

let server: ViteDevServer
let browser: Browser
let base: string

beforeAll(async () => {
  server = await createServer({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "")
  // A missing Chrome fails here, loudly; it is never a skip.
  browser = await chromium.launch({ channel: "chrome" })
  await warm(browser, base)
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(path = "/", page?: Page): Promise<Page> {
  const p = page ?? (await (await browser.newContext()).newPage())
  p.setDefaultTimeout(5_000)
  await p.goto(base + path)
  await p.locator("[data-slot=sidebar]").first().waitFor({ state: "attached" })
  await p.getByRole("heading", { level: 1 }).waitFor()
  return p
}

const palette = (p: Page) => p.getByRole("dialog", { name: "Commands" })
const paletteOpen = async (p: Page) =>
  (await palette(p).count()) > 0 && (await palette(p).isVisible())

/** Where focus is: the nav region and the index of the focused item within it. */
const focused = (p: Page) =>
  p.evaluate(() => {
    const el = document.activeElement
    const region = el?.closest("[data-nav-region]")
    if (!el || !region || !el.matches("[data-nav]"))
      return { region: null, index: -1 }
    return {
      region: region.getAttribute("data-nav-region"),
      index: [...region.querySelectorAll("[data-nav]")].indexOf(el),
    }
  })

/** Adds a text field to the main region, as a page's content would, and focuses it. */
async function field(p: Page, tag: "input" | "textarea") {
  await p.evaluate((tag) => {
    const el = document.createElement(tag)
    el.id = "probe"
    document.querySelector("[data-nav-region=main]")!.append(el)
    el.focus()
  }, tag)
  return p.locator("#probe")
}

describe("routing", () => {
  test.each([
    ["/", "Home"],
    ["/courses/aion", "aion"],
    ["/courses/aion/reference", "Reference"],
    // No School runs behind this dev server, so the lesson page shows that its lesson did not load;
    // the lesson page itself is web/test/lesson.test.ts.
    ["/courses/aion/lessons/2", "The lesson did not load"],
    ["/settings", "Settings"],
    ["/no/such/page", "Not found"],
  ])("%s renders inside the shell", async (path, heading) => {
    const p = await open(path)
    // A page may show a screen-reader-only heading while it loads (the lesson page's "Loading the
    // lesson"); wait for the page's settled heading before reading it.
    const h1 = p
      .getByRole("heading", { level: 1 })
      .filter({ hasText: heading })
      .first()
    await h1.waitFor()
    expect(await h1.textContent()).toContain(heading)
    expect(await p.locator("[data-nav-region=sidebar]").count()).toBe(1)
    await p.context().close()
  })

  test("/demo stays the theme sandbox, outside the shell", async () => {
    const p = await (await browser.newContext()).newPage()
    p.setDefaultTimeout(5_000)
    await p.goto(base + "/demo")
    await p.getByText("School UI").waitFor()
    expect(await p.locator("[data-nav-region]").count()).toBe(0)
    await p.context().close()
  })

  test("a sidebar link routes on the client, without a page load", async () => {
    const p = await open("/")
    await p.evaluate(
      () => ((window as unknown as { marker: number }).marker = 1)
    )
    await p
      .locator("[data-nav-region=sidebar]")
      .getByRole("link", { name: /Settings/ })
      .click()
    await p.getByRole("heading", { level: 1, name: "Settings" }).waitFor()
    expect(
      await p.evaluate(() => (window as unknown as { marker?: number }).marker)
    ).toBe(1)
    await p.context().close()
  })
})

describe("command palette", () => {
  test("⌘K opens it and Esc closes it", async () => {
    const p = await open()
    await p.keyboard.press("ControlOrMeta+k")
    await palette(p).waitFor()
    await p.keyboard.press("Escape")
    await palette(p).waitFor({ state: "hidden" })
    await p.context().close()
  })

  test("Space Space opens it", async () => {
    const p = await open()
    await p.keyboard.press(" ")
    await p.keyboard.press(" ")
    await palette(p).waitFor()
    await p.context().close()
  })

  test("Space Space opens it even while a button has focus", async () => {
    const p = await open()
    await p.getByRole("button", { name: /Theme/ }).focus()
    await p.keyboard.press(" ")
    await p.keyboard.press(" ")
    await palette(p).waitFor()
    expect(await p.getByRole("menu").count()).toBe(0) // Space did not also press the theme button
    await p.context().close()
  })

  test("Space Space on a focused button opens the palette and does not press the button", async () => {
    const p = await open()
    await p.getByRole("button", { name: "Toggle Sidebar" }).first().focus()
    await p.keyboard.press(" ")
    await p.keyboard.press(" ")
    await palette(p).waitFor()
    expect(
      await p
        .locator("[data-slot=sidebar][data-state]")
        .first()
        .getAttribute("data-state")
    ).toBe("expanded")
    await p.context().close()
  })

  test("Esc never opens it", async () => {
    const p = await open()
    await p.keyboard.press("Escape")
    await p.keyboard.press("Escape")
    await p.waitForTimeout(300)
    expect(await paletteOpen(p)).toBe(false)
    await p.context().close()
  })

  test("a single Space, then another key, does not open it", async () => {
    const p = await open()
    await p.keyboard.press(" ")
    await p.keyboard.press("x")
    await p.keyboard.press(" ")
    await p.waitForTimeout(300)
    expect(await paletteOpen(p)).toBe(false)
    await p.context().close()
  })

  test("running a command navigates and closes it", async () => {
    const p = await open()
    await p.keyboard.press("ControlOrMeta+k")
    await palette(p).waitFor()
    await p.keyboard.type("settings")
    await p.keyboard.press("Enter")
    await p.getByRole("heading", { level: 1, name: "Settings" }).waitFor()
    expect(await paletteOpen(p)).toBe(false)
    await p.context().close()
  })

  test("typing j and Space in its input types them", async () => {
    const p = await open()
    await p.keyboard.press("ControlOrMeta+k")
    await palette(p).waitFor()
    await p.keyboard.type("j k")
    expect(await palette(p).getByRole("combobox").inputValue()).toBe("j k")
    await p.context().close()
  })
})

describe("leader keys", () => {
  test("Space s opens settings and Space h opens home", async () => {
    const p = await open("/courses/aion")
    await p.keyboard.press(" ")
    await p.keyboard.press("s")
    await p.getByRole("heading", { level: 1, name: "Settings" }).waitFor()
    await p.keyboard.press(" ")
    await p.keyboard.press("h")
    await p.getByRole("heading", { level: 1, name: "Home" }).waitFor()
    await p.context().close()
  })

  test("Space t opens the theme menu", async () => {
    const p = await open()
    await p.keyboard.press(" ")
    await p.keyboard.press("t")
    await p.getByRole("menuitemradio", { name: "Dark" }).waitFor()
    await p.context().close()
  })

  test("⌘B toggles the sidebar", async () => {
    const p = await open()
    const state = () =>
      p
        .locator("[data-slot=sidebar][data-state]")
        .first()
        .getAttribute("data-state")
    expect(await state()).toBe("expanded")
    await p.keyboard.press("ControlOrMeta+b")
    await p.waitForFunction(
      () =>
        document
          .querySelector("[data-slot=sidebar][data-state]")
          ?.getAttribute("data-state") === "collapsed"
    )
    await p.context().close()
  })
})

describe("focus movement", () => {
  test.each([
    ["hjkl", { down: "j", up: "k", left: "h", right: "l" }],
    [
      "arrows",
      {
        down: "ArrowDown",
        up: "ArrowUp",
        left: "ArrowLeft",
        right: "ArrowRight",
      },
    ],
  ])("%s move focus through the regions and their items", async (_, key) => {
    const p = await open()
    await p.keyboard.press(key.down) // nothing focused yet: the first item of the main region
    expect(await focused(p)).toEqual({ region: "main", index: 0 })
    await p.keyboard.press(key.down)
    expect(await focused(p)).toEqual({ region: "main", index: 1 })
    await p.keyboard.press(key.up)
    expect(await focused(p)).toEqual({ region: "main", index: 0 })
    await p.keyboard.press(key.up) // the top stays the top
    expect(await focused(p)).toEqual({ region: "main", index: 0 })
    await p.keyboard.press(key.left)
    expect(await focused(p)).toEqual({ region: "sidebar", index: 0 })
    await p.keyboard.press(key.down)
    expect(await focused(p)).toEqual({ region: "sidebar", index: 1 })
    await p.keyboard.press(key.right) // back where main was left
    expect(await focused(p)).toEqual({ region: "main", index: 0 })
    await p.keyboard.press(key.left) // and back where the sidebar was left
    expect(await focused(p)).toEqual({ region: "sidebar", index: 1 })
    await p.context().close()
  })

  test.each(["input", "textarea"] as const)(
    "typing hjkl, j and Space in an %s types them and moves nothing",
    async (tag) => {
      const p = await open()
      const probe = await field(p, tag)
      await p.keyboard.type("hjkl j  ")
      await p.keyboard.press("ArrowLeft")
      expect(await probe.inputValue()).toBe("hjkl j  ")
      expect(await p.evaluate(() => document.activeElement?.id)).toBe("probe")
      expect(await paletteOpen(p)).toBe(false)
      await p.context().close()
    }
  )

  test("⌘K still opens the palette from a text field", async () => {
    const p = await open()
    await field(p, "input")
    await p.keyboard.press("ControlOrMeta+k")
    await palette(p).waitFor()
    await p.context().close()
  })

  test("j does not move focus while the theme menu is open", async () => {
    const p = await open()
    await p.getByRole("button", { name: /Theme/ }).click()
    await p.getByRole("menuitemradio", { name: "Dark" }).waitFor()
    await p.keyboard.press("j")
    expect(
      await p.evaluate(
        () => document.activeElement?.closest("[role=menu]") !== null
      )
    ).toBe(true)
    await p.context().close()
  })
})

describe("theme switch", () => {
  const mode = (p: Page) =>
    p.evaluate(() =>
      document.documentElement.classList.contains("dark")
        ? "dark"
        : document.documentElement.classList.contains("light")
          ? "light"
          : null
    )

  async function choose(p: Page, name: "Light" | "Dark" | "System") {
    await p.getByRole("button", { name: /Theme/ }).click()
    await p.getByRole("menuitemradio", { name }).click()
  }

  test("offers light, dark and system, and shows which is chosen", async () => {
    const p = await open()
    await p.getByRole("button", { name: /Theme/ }).click()
    const items = p.getByRole("menuitemradio")
    expect(await items.allTextContents()).toEqual(["Light", "Dark", "System"])
    expect(
      await p
        .getByRole("menuitemradio", { name: "System" })
        .getAttribute("aria-checked")
    ).toBe("true")
    await p.context().close()
  })

  test("a choice persists for this viewer across reloads, and not for another viewer", async () => {
    const p = await open()
    await choose(p, "Dark")
    expect(await mode(p)).toBe("dark")
    await open("/", p) // reload
    expect(await mode(p)).toBe("dark")
    await choose(p, "Light")
    await open("/settings", p)
    expect(await mode(p)).toBe("light")

    const other = await (
      await browser.newContext({ colorScheme: "dark" })
    ).newPage()
    await open("/", other)
    expect(await mode(other)).toBe("dark") // system, from this viewer's own setting
    await other.context().close()
    await p.context().close()
  })

  test("system follows the device, live", async () => {
    const p = await open()
    await choose(p, "System")
    await p.emulateMedia({ colorScheme: "dark" })
    await p.waitForFunction(() =>
      document.documentElement.classList.contains("dark")
    )
    await p.emulateMedia({ colorScheme: "light" })
    await p.waitForFunction(() =>
      document.documentElement.classList.contains("light")
    )
    await p.context().close()
  })

  test("blocked browser storage still renders the app and switches the theme for the visit", async () => {
    const context = await browser.newContext()
    await context.addInitScript(() => {
      for (const name of ["getItem", "setItem", "removeItem"] as const)
        Storage.prototype[name] = () => {
          throw new DOMException("blocked", "SecurityError")
        }
    })
    const p = await open("/", await context.newPage())
    await choose(p, "Dark")
    expect(await mode(p)).toBe("dark")
    await context.close()
  })
})

describe("Kbd hints", () => {
  /** Every hint inside a scope: a KbdGroup as its keys joined by spaces, or a lone Kbd's text. */
  const hints = (p: Page, scope: string) =>
    p
      .locator(
        `${scope} [data-slot=kbd-group], ${scope} [data-slot=kbd]:not([data-slot=kbd-group] [data-slot=kbd])`
      )
      .evaluateAll((els) =>
        els.map((e) => {
          const keys = e.matches("[data-slot=kbd-group]")
            ? [...e.querySelectorAll("[data-slot=kbd]")]
            : [e]
          return keys.map((k) => (k.textContent ?? "").trim()).join(" ")
        })
      )

  test("the keys list shows every key that acts", async () => {
    const p = await open()
    const shown = await hints(p, "[data-keys]")
    for (const hint of [
      `${mod} K`,
      "Space Space",
      "h j k l",
      "← ↓ ↑ →",
      "Space h",
      "Space s",
      "Space t",
      `${mod} B`,
      "Esc",
    ])
      expect(shown).toContain(hint)
    await p.context().close()
  })

  test("each sidebar link and the palette button show their keys", async () => {
    const p = await open()
    expect(
      await p
        .locator("[data-nav-region=sidebar]")
        .getByRole("link", { name: /Home/ })
        .locator("..")
        .textContent()
    ).toContain("Space")
    expect(
      await hints(p, "[data-nav-region=sidebar] li:has(a[href='/'])")
    ).toEqual(["Space h"])
    expect(
      await hints(p, "[data-nav-region=sidebar] li:has(a[href='/settings'])")
    ).toEqual(["Space s"])
    expect(await hints(p, "header button[aria-keyshortcuts]")).toContain(
      `${mod} K`
    )
    await p.context().close()
  })

  test("the palette shows the keys of its commands and its own keys", async () => {
    const p = await open()
    await p.keyboard.press("ControlOrMeta+k")
    await palette(p).waitFor()
    const shown = await hints(p, "[role=dialog]")
    for (const hint of ["Space h", "Space s", `${mod} B`, "↑ ↓", "↵", "Esc"])
      expect(shown).toContain(hint)
    await p.context().close()
  })
})
