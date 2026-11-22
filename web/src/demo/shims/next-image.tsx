// next/image for the registry examples, which are written for Next.js. A plain img; `fill` covers the parent.
import * as React from "react"

type ImageProps = Omit<React.ComponentProps<"img">, "src"> & {
  src: string
  fill?: boolean
  priority?: boolean
  quality?: number
  unoptimized?: boolean
}

export default function Image({ fill, priority: _p, quality: _q, unoptimized: _u, style, ...props }: ImageProps) {
  return <img style={fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style } : style} {...props} />
}
