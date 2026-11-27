// Hostile lesson HTML renders inert (flyingrobots/school#210). A lesson's prose, card, quote and
// aside blocks are course-authored HTML, rendered through the markdown item (Streamdown, which
// sanitises with rehype-sanitize and rehype-harden), and a hook's SVG figure through safeFigure
// (web/src/lib/figure.ts). An untrusted course keeps exactly that path, so this proves it holds
// against known cross-site scripting payloads.
// Oracle: deny by default. Every element and attribute the render produces is walked; none may be
// an element that runs or loads a document, an `on*` handler, `srcdoc`, or a URL whose scheme
// runs script (javascript:, vbscript:, data:text/html), and no payload's callback may fire. The
// corpus is the issue's three cases (a <script>, an onerror=, a javascript: link) plus classic
// variants from the OWASP XSS Filter Evasion Cheat Sheet.
import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

// happy-dom stands in for the browser for this file only, then gives the globals back.
GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { LessonAside, LessonCard, LessonProse, LessonQuote } =
  await import("@/components/lesson")
const { safeFigure } = await import("@/lib/figure")
const { CORPUS } = await import("./xss-corpus")

// Every payload calls this; a call means script ran.
let fired = 0
;(globalThis as { pwn?: () => void }).pwn = () => {
  fired++
}

const BLOCKS = [
  ["prose", LessonProse],
  ["card", LessonCard],
  ["quote", LessonQuote],
  ["aside", LessonAside],
] as const

let unmount: (() => void) | undefined
afterEach(() => {
  act(() => unmount?.())
  unmount = undefined
  document.body.innerHTML = ""
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  unmount = () => root.unmount()
  return host
}

const RUNS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "applet",
  "portal",
])
const URL_ATTRS = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "codebase",
  "cite",
])

/** Every way `el` and its descendants could run script, as readable findings. Empty means inert. */
function hazards(el: Element): string[] {
  const found: string[] = []
  for (const e of [el, ...el.querySelectorAll("*")]) {
    const tag = e.localName.toLowerCase()
    if (RUNS.has(tag)) found.push(`<${tag}>`)
    for (const a of [...e.attributes]) {
      const name = a.name.toLowerCase()
      if (name.startsWith("on")) found.push(`<${tag} ${name}>`)
      if (name === "srcdoc") found.push(`<${tag} srcdoc>`)
      if (URL_ATTRS.has(name)) {
        // Browsers ignore ASCII whitespace and controls inside a scheme.
        const url = [...a.value]
          .filter((ch) => ch.charCodeAt(0) > 0x20)
          .join("")
          .toLowerCase()
        if (/^(javascript|vbscript|data:text\/html)/.test(url))
          found.push(`<${tag} ${name}="${a.value}">`)
      }
    }
  }
  return found
}

test.each(
  BLOCKS.flatMap(([kind, Block]) =>
    CORPUS.map((payload) => [kind, payload, Block] as const)
  )
)("a %s block renders %s inert", async (_kind, payload, Block) => {
  fired = 0
  const host = await render(<Block id="b" html={payload} />)
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  expect({ hazards: hazards(host), fired }).toEqual({ hazards: [], fired: 0 })
})

// The positive control: a sanitiser that dropped everything would pass every case above.
test("a block keeps the formatting the sanitiser allows", async () => {
  const host = await render(
    <LessonProse
      id="b"
      html="<p><b>bold</b> <em>em</em></p><ul><li>item</li></ul>"
    />
  )
  expect([
    host.querySelector("b")?.textContent,
    host.querySelector("em")?.textContent,
    host.querySelector("li")?.textContent,
  ]).toEqual(["bold", "em", "item"])
})

// A hook's figure: SVG with script and handlers keeps only its drawing.
test.each([
  '<svg xmlns="http://www.w3.org/2000/svg" onload="pwn()"><script>pwn()</script><circle r="4"/></svg>',
  '<svg><foreignObject><img src=x onerror="pwn()"></foreignObject><path d="M0 0"/></svg>',
  '<svg><a href="javascript:pwn()"><text>x</text></a><line x2="1"/></svg>',
  '<svg><set attributeName="onmouseover" to="pwn()"/><animate attributeName="href" values="javascript:pwn()"/><rect width="1"/></svg>',
  '<svg><use href="data:image/svg+xml,<svg onload=pwn()>"/><g/></svg>',
  '<svg><image href="x" onerror="pwn()"/><g/></svg>',
])("a figure keeps only its drawing from %s", (svg) => {
  const safe = safeFigure(svg)
  const box = document.createElement("div")
  box.innerHTML = safe ?? ""
  expect({
    svg: box.firstElementChild?.localName,
    hazards: hazards(box),
    dropped: [
      ...box.querySelectorAll("script,foreignObject,a,set,animate,use,image"),
    ].length,
  }).toEqual({ svg: "svg", hazards: [], dropped: 0 })
})

// Mutation XSS (flyingrobots/school#210, #273). safeFigure parses with scripting off and the page
// reparses with scripting on, where <noscript>, <noembed>, <noframes>, <xmp> and <style> hold raw
// text. A serialiser that leaves < and > unescaped in attributes (happy-dom's, Chrome's before
// 2025) then turns an attribute into live markup. Oracle: the figure that comes back, inserted the
// way the page inserts it, holds no element whose content the HTML parser reads as raw text or
// differently with scripting on (HTML, "parsing HTML fragments" and "the rules for parsing tokens
// in HTML content"), and no hazard. That no raw-text element survives is the evidence: happy-dom
// never runs an <img onerror>, so `fired` staying 0 proves nothing here (Chrome was checked by
// hand). happy-dom's parser puts every element of an <svg> in the SVG namespace, so the check is
// by name, not namespace.
const RAW_TEXT = new Set([
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "style",
  "iframe",
  "plaintext",
  "textarea",
  "script",
])
const MUTATIONS = [
  ["noscript", "title"],
  ["noscript", "desc"],
  ["noembed", "title"],
  ["noframes", "title"],
  ["xmp", "title"],
  ["style", "title"],
].map(
  ([raw, point]) =>
    `<svg><${point}><${raw}><p title="</${raw}><img src=x onerror=pwn()>"></p></${raw}></${point}><circle r="1"/></svg>`
)

test.each(MUTATIONS)(
  "a figure cannot mutate into script through %s",
  async (svg) => {
    fired = 0
    const box = document.createElement("div")
    document.body.appendChild(box)
    box.innerHTML = safeFigure(svg) ?? ""
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect({
      svg: box.firstElementChild?.localName,
      rawText: [...box.querySelectorAll("*")]
        .map((e) => e.localName)
        .filter((n) => RAW_TEXT.has(n)),
      hazards: hazards(box),
      fired,
    }).toEqual({ svg: "svg", rawText: [], hazards: [], fired: 0 })
  }
)

// UI redress: a figure styled to cover the page could pose as School. No style or class survives,
// on the root or any shape; School's own figures colour themselves with presentation attributes.
test("a figure keeps no style or class that could lay it over the page", () => {
  const box = document.createElement("div")
  box.innerHTML =
    safeFigure(
      '<svg xmlns="http://www.w3.org/2000/svg" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:99999" class="fixed inset-0 z-50"><rect style="fill:red" class="fixed" width="1"/><text y="20">Sign in again</text></svg>'
    ) ?? ""
  expect(
    [...box.querySelectorAll("*")].flatMap((e) =>
      [...e.attributes]
        .filter((a) => a.name === "style" || a.name === "class")
        .map((a) => `<${e.localName} ${a.name}>`)
    )
  ).toEqual([])
})

// An untrusted course's figure is drawn as an image (flyingrobots/school#210, #273): an <img>
// never runs script, whatever its SVG holds. A trusted course's stays inline, as before.
const { HookFigure } = await import("@/components/hook-figure")
const HOOK =
  '<svg viewBox="0 0 10 10" onload="pwn()"><circle data-dot cx="5" cy="5" r="4" fill="var(--primary)"/><script>pwn()</script></svg>'

/** The SVG an <img src="data:image/svg+xml,…"> shows, parsed as the browser does: as XML. */
function imageSvg(host: HTMLElement): Document | null {
  const src = host.querySelector("img")?.getAttribute("src") ?? ""
  const prefix = "data:image/svg+xml,"
  if (!src.startsWith(prefix)) return null
  return new DOMParser().parseFromString(
    decodeURIComponent(src.slice(prefix.length)),
    "image/svg+xml"
  )
}

test("an untrusted course's figure is an image, with no inline SVG on the page", async () => {
  const host = await render(<HookFigure svg={HOOK} trusted={false} />)
  const drawn = imageSvg(host)
  expect({
    inline: host.querySelectorAll("svg").length,
    images: host.querySelectorAll("[data-figure] img").length,
    dot: drawn?.querySelectorAll("circle").length ?? 0,
  }).toEqual({ inline: 0, images: 1, dot: 1 })
})

test("an untrusted course's figure takes the theme's colours, since an image cannot read the page's", async () => {
  document.documentElement.style.setProperty("--primary", "rgb(1, 2, 3)")
  try {
    const host = await render(<HookFigure svg={HOOK} trusted={false} />)
    expect(imageSvg(host)?.querySelector("circle")?.getAttribute("fill")).toBe(
      "rgb(1, 2, 3)"
    )
  } finally {
    document.documentElement.style.removeProperty("--primary")
  }
})

test("an untrusted course's figure follows a switch to the dark theme", async () => {
  const sheet = document.createElement("style")
  sheet.textContent =
    ":root { --primary: rgb(0, 0, 1) } .dark { --primary: rgb(9, 9, 9) }"
  document.head.appendChild(sheet)
  try {
    const host = await render(<HookFigure svg={HOOK} trusted={false} />)
    await act(async () => {
      document.documentElement.classList.add("dark")
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(imageSvg(host)?.querySelector("circle")?.getAttribute("fill")).toBe(
      "rgb(9, 9, 9)"
    )
  } finally {
    document.documentElement.classList.remove("dark")
    sheet.remove()
  }
})

test("a trusted course's figure stays inline SVG, coloured by the page's own variables", async () => {
  const host = await render(<HookFigure svg={HOOK} trusted />)
  expect({
    images: host.querySelectorAll("img").length,
    fill: host.querySelector("[data-figure] svg circle")?.getAttribute("fill"),
  }).toEqual({ images: 0, fill: "var(--primary)" })
})

// A figure is a JSON string, which may hold a lone surrogate ("\ud800"); encodeURIComponent throws
// URIError on one, which would take the whole home page down. Oracle: WHATWG Infra, "scalar value
// string": a lone surrogate becomes U+FFFD REPLACEMENT CHARACTER, as String.prototype.toWellFormed does.
const { figureImage } = await import("@/lib/figure")
test.each([
  ["high", "\ud800"],
  ["low", "\udc00"],
])(
  "a figure with a lone %s surrogate becomes an image with U+FFFD in its place",
  (_, lone) => {
    const src = figureImage(
      `<svg viewBox="0 0 10 10"><text>a${lone}b</text></svg>`,
      () => ""
    )
    const text = new DOMParser()
      .parseFromString(
        decodeURIComponent((src ?? "").slice("data:image/svg+xml,".length)),
        "image/svg+xml"
      )
      .querySelector("text")?.textContent
    expect(text).toBe("a�b")
  }
)

test.each([
  ["high", "\ud800"],
  ["low", "\udc00"],
])(
  "an untrusted course's figure with a lone %s surrogate still renders as an image",
  async (_, lone) => {
    const host = await render(
      <HookFigure
        svg={`<svg viewBox="0 0 10 10"><text>a${lone}b</text></svg>`}
        trusted={false}
      />
    )
    expect(host.querySelectorAll("[data-figure] img").length).toBe(1)
  }
)

// var() takes a fallback that may hold parentheses or another var() (CSS Custom Properties,
// "Using Cascading Variables: the var() notation"). Oracle: that grammar; the image's fill is
// the token's value when set, else its fallback, resolved the same way.
const PRIMARY_SET = (name: string) =>
  name === "--primary" ? "rgb(9, 9, 9)" : ""
const fillOf = (fill: string, token: (name: string) => string) =>
  new DOMParser()
    .parseFromString(
      decodeURIComponent(
        (
          figureImage(
            `<svg viewBox="0 0 10 10"><circle r="4" fill="${fill}"/></svg>`,
            token
          ) ?? ""
        ).slice("data:image/svg+xml,".length)
      ),
      "image/svg+xml"
    )
    .querySelector("circle")
    ?.getAttribute("fill")

test.each([
  ["var(--primary)", PRIMARY_SET, "rgb(9, 9, 9)"],
  ["var(--primary, rgb(1, 2, 3))", PRIMARY_SET, "rgb(9, 9, 9)"],
  ["var(--primary, rgb(1, 2, 3))", () => "", "rgb(1, 2, 3)"],
  ["var(--unset, var(--primary))", PRIMARY_SET, "rgb(9, 9, 9)"],
  [
    "var(--unset, var(--also-unset, rgb(1, 2, 3)))",
    PRIMARY_SET,
    "rgb(1, 2, 3)",
  ],
] as const)(
  "an untrusted figure’s fill %s resolves as var() says",
  (fill, token, want) => {
    expect({ fill: fillOf(fill, token) }).toEqual({ fill: want })
  }
)
