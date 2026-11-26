import * as React from "react"

import { figureImage, safeFigure } from "@/lib/figure"

// The theme lives on <html>: its class (light or dark) and any inline variables. A change to
// either re-colours an untrusted figure, which cannot read the page's variables itself.
function subscribeTheme(onChange: () => void): () => void {
  const watch = new MutationObserver(onChange)
  watch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  })
  return () => watch.disconnect()
}
const themeKey = () =>
  `${document.documentElement.className}|${document.documentElement.style.cssText}`

const box =
  "flex items-center justify-center overflow-hidden [&_img]:h-full [&_img]:w-auto [&_img]:max-w-full [&_svg]:h-full [&_svg]:w-auto [&_svg]:max-w-full"

/**
 * A lesson hook's SVG figure, kept to drawing (lib/figure.ts), sized by its box. A trusted course's
 * is drawn inline; an untrusted course's as an image, where nothing in it can run
 * (flyingrobots/school#210), coloured with the theme's values as they are now.
 */
export function HookFigure({
  svg,
  trusted,
  className,
}: {
  svg: string
  trusted: boolean
  className?: string
}) {
  const theme = React.useSyncExternalStore(subscribeTheme, themeKey)
  const inline = React.useMemo(
    () => (trusted ? safeFigure(svg) : null),
    [svg, trusted]
  )
  const image = React.useMemo(() => {
    if (trusted) return null
    void theme // recomputed when the theme changes
    const style = getComputedStyle(document.documentElement)
    return figureImage(svg, (name) => style.getPropertyValue(name))
  }, [svg, trusted, theme])
  if (image !== null)
    return (
      <div data-figure className={`${box} ${className ?? ""}`}>
        <img src={image} alt="" aria-hidden="true" />
      </div>
    )
  if (inline === null) return null
  return (
    <div
      data-figure
      className={`${box} ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: inline }}
    />
  )
}
