// next/link for the registry examples, which are written for Next.js. A plain anchor.
import * as React from "react"

type LinkProps = Omit<React.ComponentProps<"a">, "href"> & {
  href: string | { pathname?: string }
  prefetch?: boolean
  replace?: boolean
  scroll?: boolean
}

export default function Link({ href, prefetch: _p, replace: _r, scroll: _s, ...props }: LinkProps) {
  return <a href={typeof href === "string" ? href : (href.pathname ?? "#")} {...props} />
}
