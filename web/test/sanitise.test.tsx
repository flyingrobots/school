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

// Every payload calls this; a call means script ran.
let fired = 0
;(globalThis as { pwn?: () => void }).pwn = () => {
  fired++
}

const CORPUS = [
  "<script>pwn()</script>",
  '<img src=x onerror="pwn()">',
  '<a href="javascript:pwn()">a link</a>',
  '<a href="JaVaScRiPt:pwn()">mixed case</a>',
  '<a href=" javascript:pwn()">leading space</a>',
  '<a href="jav&#x09;ascript:pwn()">tab entity</a>',
  '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;pwn()">entities</a>',
  '<a href="vbscript:pwn()">vbscript</a>',
  '<a href="data:text/html,<script>pwn()</script>">data</a>',
  '<svg onload="pwn()"><circle r="1"/></svg>',
  "<svg><script>pwn()</script></svg>",
  '<svg><a xlink:href="javascript:pwn()"><text>x</text></a></svg>',
  '<iframe src="javascript:pwn()"></iframe>',
  '<iframe srcdoc="<script>parent.pwn()</script>"></iframe>',
  '<object data="javascript:pwn()"></object>',
  '<embed src="javascript:pwn()">',
  '<body onload="pwn()">',
  '<div onmouseover="pwn()">hover</div>',
  '<details open ontoggle="pwn()">x</details>',
  '<input autofocus onfocus="pwn()">',
  '<form action="javascript:pwn()"><button>go</button></form>',
  '<button formaction="javascript:pwn()">go</button>',
  '<math><mi xlink:href="javascript:pwn()">x</mi></math>',
  '<base href="javascript:pwn()//">',
  '<meta http-equiv="refresh" content="0;url=javascript:pwn()">',
  '<link rel="stylesheet" href="javascript:pwn()">',
  '<video><source onerror="pwn()"></video>',
  '<img src="x" ONERROR="pwn()">',
  "<scr<script>ipt>pwn()</script>",
  '<<img src=x onerror="pwn()">',
  "<img src=`x` onerror=pwn()>",
  '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058pwn()">padded</a>',
  '<noscript><p title="</noscript><img src=x onerror=pwn()>"></noscript>',
  "<style>@import 'javascript:pwn()';</style>",
  '<template><img src=x onerror="pwn()"></template>',
]

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
        const url = a.value.replace(/[\u0000- ]/g, "").toLowerCase()
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
