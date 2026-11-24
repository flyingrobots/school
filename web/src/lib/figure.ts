// A lesson hook's figure is SVG from the course (flyingrobots/school#164). Courses are trusted like
// their prose, but a figure is still kept to drawing: nothing that runs, loads or navigates.
// It is parsed the way the page will insert it, as HTML, in an inert document where nothing runs.
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
]

/** The figure as safe SVG markup, or null unless it is exactly one <svg> element. */
export function safeFigure(markup: string): string | null {
  const body = new DOMParser().parseFromString(markup, "text/html").body
  const svg = body.firstElementChild
  if (
    svg === null ||
    body.children.length !== 1 ||
    svg.localName !== "svg" ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg"
  )
    return null
  for (const el of svg.querySelectorAll(DROP.join(","))) el.remove()
  for (const el of [svg, ...svg.querySelectorAll("*")])
    for (const a of [...el.attributes])
      if (/^on/i.test(a.name) || /href$/i.test(a.name))
        el.removeAttribute(a.name)
  svg.setAttribute("aria-hidden", "true")
  return svg.outerHTML
}
