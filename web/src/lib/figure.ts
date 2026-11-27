// A lesson hook's figure is SVG from the course (flyingrobots/school#164). A trusted course's is
// drawn inline, so it can take the page's theme colours; an untrusted course's (#210) is drawn as
// an <img>, where no script runs whatever the SVG holds. Either way a figure is kept to drawing:
// nothing that runs, loads, navigates or styles itself over the page.
// It is parsed the way the page will insert it, as HTML, in an inert document where nothing runs.
const SVG = "http://www.w3.org/2000/svg"
const DROP = [
  "script",
  "foreignObject",
  "iframe",
  "object",
  "embed",
  "image",
  "use",
  "a",
  "style",
  "animate",
  "set",
  // Parsed as markup with scripting off here, but as raw text when the page reparses with
  // scripting on: a classic mutation-XSS route (flyingrobots/school#273).
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "textarea",
]

/** The figure, kept to drawing, or null unless it is exactly one <svg> element. */
function cleaned(markup: string): Element | null {
  const body = new DOMParser().parseFromString(markup, "text/html").body
  const svg = body.firstElementChild
  if (
    svg === null ||
    body.children.length !== 1 ||
    svg.localName !== "svg" ||
    svg.namespaceURI !== SVG
  )
    return null
  for (const el of svg.querySelectorAll(DROP.join(","))) el.remove()
  // Inside <title>, <desc> and the like the parser makes HTML elements; a figure draws with SVG only.
  for (const el of svg.querySelectorAll("*"))
    if (el.namespaceURI !== SVG) el.remove()
  // `style` and `class` could lay the figure over the page and pose as School. School's figures
  // colour themselves with presentation attributes (fill="var(--primary)"), never with either.
  for (const el of [svg, ...svg.querySelectorAll("*")])
    for (const a of [...el.attributes])
      if (
        /^on/i.test(a.name) ||
        /href$/i.test(a.name) ||
        a.name === "style" ||
        a.name === "class"
      )
        el.removeAttribute(a.name)
  svg.setAttribute("aria-hidden", "true")
  return svg
}

/** The figure as safe SVG markup for inline drawing, or null unless it is exactly one <svg>. */
export function safeFigure(markup: string): string | null {
  return cleaned(markup)?.outerHTML ?? null
}

// A lone surrogate, which a JSON string may hold and encodeURIComponent throws on. Each becomes
// U+FFFD, as String.prototype.toWellFormed does (ES2024; this project's lib is ES2023).
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const wellFormed = (s: string) => s.replace(LONE_SURROGATE, "\uFFFD")

/**
 * `value` with each `var(--name)` or `var(--name, fallback)` replaced by `token(name)`, or else
 * by its fallback, resolved the same way, or else by currentColor. Parentheses are matched, so a
 * fallback may hold `rgb(1, 2, 3)` or another `var()`. An unclosed `var(` is left as written.
 */
function resolveVars(value: string, token: (name: string) => string): string {
  let out = ""
  let from = 0
  for (;;) {
    const at = value.indexOf("var(", from)
    if (at === -1) return out + value.slice(from)
    let depth = 0
    let end = -1
    for (let i = at + 3; i < value.length && end === -1; i++) {
      if (value[i] === "(") depth++
      else if (value[i] === ")" && --depth === 0) end = i
    }
    if (end === -1) return out + value.slice(from)
    const inner = value.slice(at + 4, end)
    const comma = inner.indexOf(",")
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma === -1 ? "" : inner.slice(comma + 1).trim()
    const set = /^--[\w-]+$/.test(name) ? token(name).trim() : ""
    out +=
      value.slice(from, at) +
      (set || (fallback && resolveVars(fallback, token)) || "currentColor")
    from = end + 1
  }
}

/**
 * The figure as a `data:image/svg+xml` URL for an <img>, or null unless it is exactly one <svg>.
 * An image cannot read the page's CSS variables, so each `var(--name)` in an attribute is replaced
 * by `token(name)`: the theme's value now, or the var's own fallback, or currentColor.
 */
export function figureImage(
  markup: string,
  token: (name: string) => string
): string | null {
  const svg = cleaned(markup)
  if (svg === null) return null
  for (const el of [svg, ...svg.querySelectorAll("*")])
    for (const a of [...el.attributes])
      if (a.value.includes("var("))
        el.setAttribute(a.name, resolveVars(a.value, token))
  // The serialiser declares the SVG namespace itself, so the image parses as SVG.
  return (
    "data:image/svg+xml," +
    encodeURIComponent(wellFormed(new XMLSerializer().serializeToString(svg)))
  )
}
