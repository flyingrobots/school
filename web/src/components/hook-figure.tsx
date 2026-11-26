import * as React from "react"

import { safeFigure } from "@/lib/figure"

/** A lesson hook's SVG figure, kept to drawing (lib/figure.ts), sized by its box. */
export function HookFigure({
  svg,
  className,
}: {
  svg: string
  className?: string
}) {
  const safe = React.useMemo(() => safeFigure(svg), [svg])
  if (safe === null) return null
  return (
    <div
      data-figure
      className={`flex items-center justify-center [&_svg]:h-full [&_svg]:w-auto [&_svg]:max-w-full ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  )
}
